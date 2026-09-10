// AstroHand AI API Proxy
// This file runs on Vercel serverless - your Groq key stays secret

const GROQ_KEY = process.env.GROQ_API_KEY; // Set this in Vercel dashboard
const GEMINI_KEY = process.env.GEMINI_API_KEY; // second provider, used when Groq is spent
// One full Kundli report is a dozen-plus calls on its own, and translating it
// runs another call per chunk. 20/day cut people off in the middle of a single
// report. (In-memory and per serverless instance, so this was always a rough
// brake rather than an exact quota.)
const RATE_LIMIT = 150; // max requests per IP per day

// Simple in-memory rate limiter (resets when serverless function restarts)
const rateLimitMap = new Map();

/* ── Circuit breaker + last-known-good ────────────────────────────────────────
   Free tiers do not fail randomly, they fail for the rest of the day: Groq runs
   out of tokens, and Gemini's allowance is per-model per-day. So the same
   provider that just refused will almost certainly refuse the next caller too —
   and probing it again costs that caller real seconds. Measured 2026-08-23,
   after the timeout fix: Groq failed 10 out of 10 times yet was still tried on
   every request, and roughly 2 in 10 requests walked the whole Gemini list
   because the model that usually answers had hit its daily quota. Those were
   the 16-17s responses.

   So a provider that fails is put aside for COOL_MS and skipped, and the model
   that last worked is tried first next time. Both facts live in module scope,
   which on Vercel survives between invocations on a warm instance and is lost
   when it recycles — exactly like rateLimitMap above. That is fine: this is an
   optimisation, never a gate. If everything is cooling we ignore the cooldowns
   and try anyway, so a stale note can cost a slow request but can never cost a
   reading. And because a cooldown expires on its own, the day Groq's quota
   resets it simply starts winning again — no deploy needed. */
const COOL_MS = 10 * 60 * 1000;
const coolUntil = new Map();
let lastGoodGemini = null;
let lastGoodGroq = null;

const isCool = (k) => (coolUntil.get(k) || 0) > Date.now();
const markCool = (k) => coolUntil.set(k, Date.now() + COOL_MS);
const markGood = (k) => coolUntil.delete(k);

function checkRateLimit(ip) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + dayMs });
    return true;
  }
  
  const data = rateLimitMap.get(ip);
  
  if (now > data.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + dayMs });
    return true;
  }
  
  if (data.count >= RATE_LIMIT) {
    return false;
  }
  
  data.count++;
  return true;
}

export default async function handler(req, res) {
  // CORS headers - allow your domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only POST allowed
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
             req.headers['x-real-ip'] || 
             req.socket?.remoteAddress || 
             'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ 
      error: 'Daily limit reached. Please try again tomorrow.',
      code: 'RATE_LIMIT'
    });
  }

  // Validate request
  const { systemPrompt, messages, maxTokens, temperature } = req.body;
  
  if (!systemPrompt || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request format' });
  }

  if (!GROQ_KEY) {
    return res.status(500).json({ error: 'API not configured' });
  }

  // Block prompt injection attempts
  const combined = systemPrompt + JSON.stringify(messages);
  const suspicious = ['ignore previous', 'ignore all', 'jailbreak', 'dan mode', 'reveal key', 'api key'];
  if (suspicious.some(s => combined.toLowerCase().includes(s))) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  /* ── The provider chain ───────────────────────────────────────────────────
     Groq first: it is fastest and its free tier is 100,000 tokens a day.
     Gemini second: its free tier is 20 requests a day PER MODEL, so it rotates
     the flash family and each model contributes its own allowance.

     The point is that work never stops. A user hitting Groq's daily ceiling
     used to see "The stars are quiet — please try again"; now the request
     quietly moves to the other provider and they get their reading. Measured
     2026-08-04: Gemini also handles Indian languages better than Groq, which
     returned Gujarati terms in Devanagari, so falling back is not a downgrade.  */

  const wanted = Math.min(Math.max(Number(maxTokens) || 1000, 1), 8000);
  const temp = Number.isFinite(temperature) ? Math.max(0, Math.min(1.5, temperature)) : 0.85;
  const history = messages.slice(-12); // max 12 messages of context

  /* ── Deadlines ────────────────────────────────────────────────────────────
     Measured 2026-08-23: a quarter of all requests were returning 504
     FUNCTION_INVOCATION_TIMEOUT at exactly 30s, while the ones that worked
     answered in ~2s. The cause was not slow generation — it was that no fetch
     below had a timeout. Groq is out of quota and usually refuses instantly,
     but when it hangs instead, nothing interrupts it and Vercel kills the whole
     function at maxDuration (30s, see vercel.json). The user just sees the app
     stall forever.

     So: every upstream call now gets its own abort timeout, and the chain stops
     starting new attempts once the overall budget is gone. A caller then gets a
     real 429 with a message the app already knows how to show, instead of a 504
     with no body at all. */
  const BUDGET_MS = 25000;    // stay under vercel.json maxDuration (30s)
  const PER_CALL_MS = 9000;   // any single provider that goes quiet is abandoned
  // Per Groq model, not per provider — viaGroq walks a list now. When a model is
  // reachable it answers in about 3s; when the account cannot reach it the
  // refusal comes back in well under a second, so trying the next name is cheap.
  // Only a genuinely hanging model costs the full leash.
  const GROQ_MS = 4000;
  const startedAt = Date.now();
  const msLeft = () => BUDGET_MS - (Date.now() - startedAt);

  function timeoutFetch(url, opts, ms) {
    const budget = Math.max(0, Math.min(ms, msLeft()));
    if (budget <= 250) throw Object.assign(new Error('out of time budget'), { noTime: true });
    return fetch(url, { ...opts, signal: AbortSignal.timeout(budget) });
  }

  /* Groq used to be one hardcoded model, and on 2026-09-10 that turned into a
     silent outage. Measured against the live deployment, 10 identical requests:
     Groq answered 0 of them, every one failing with

       "The model `llama-3.3-70b-versatile` does not exist or you do not have
        access to it"

     The name is still in Groq's catalogue but it moved to their Enterprise tier,
     so this account lost access. Because any Groq failure cooled the whole
     provider for ten minutes, every request for the next ten minutes fell to
     Gemini — and Gemini was slow enough that 3 of those 10 requests failed
     outright with a 429. Users saw readings that never arrived.

     Two things were wrong, and both are fixed here:
       1. one model name was a single point of failure. Groq now walks a list,
          exactly as Gemini does, so a retired or gated name costs one round trip
          instead of the whole provider.
       2. a per-model refusal is not evidence the provider is down, so it cools
          that model only. The whole of Groq is only cooled when the account
          itself is the problem (401/403 on the key, or 429 out of quota) —
          see the chain below. */
  const GROQ_MODELS = [
    'llama-3.3-70b-versatile',  // best quality when the account can reach it
    'llama-3.1-8b-instant',     // always on the free tier, and fast
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
  ];

  async function viaGroq() {
    if (!GROQ_KEY) throw Object.assign(new Error('Groq not configured'), { skip: true });
    if (isCool('groq')) throw Object.assign(new Error('Groq cooling off'), { skip: true });

    const ordered = [...new Set([lastGoodGroq, ...GROQ_MODELS].filter(Boolean))];
    const warm = ordered.filter((m) => !isCool(`groq:${m}`));
    const candidates = warm.length ? warm : ordered;

    // Groq is the fast path, not the fallback. Leave Gemini enough of the budget
    // to still answer if every Groq model refuses.
    const GROQ_PHASE_FLOOR = 14000;

    let last = 'no Groq model answered';
    let accountLevel = null;
    for (const model of candidates) {
      if (msLeft() <= GROQ_PHASE_FLOOR) { last = `${last} (leaving budget for Gemini)`; break; }
      let r, d;
      try {
        r = await timeoutFetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: systemPrompt }, ...history],
            // Indic scripts cost roughly 3-5x the tokens of the same text in English,
            // so a 2000-token ceiling silently chopped every Hindi/Tamil translation.
            max_tokens: wanted,
            temperature: temp,
            top_p: 0.95,
          }),
        }, GROQ_MS);
      } catch (e) {
        last = `groq:${model} ${e.noTime ? 'skipped (no time left)' : `timed out/aborted (${e.name})`}`;
        if (e.noTime) break;
        continue;
      }

      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        const msg = e.error?.message || `HTTP ${r.status}`;
        // 401/403 mean the key itself is bad; no model will work, so let the
        // chain cool the whole provider. Everything else is this model's problem.
        if (r.status === 401 || r.status === 403) {
          accountLevel = `Groq key rejected (${r.status}): ${msg}`;
          break;
        }
        // 404 or "does not exist / do not have access" — this exact name is out
        // of reach for this account. Stop asking for it; try the next one.
        if (r.status === 404 || r.status === 400 || /does not exist|do not have access/i.test(msg)) {
          markCool(`groq:${model}`);
          last = `groq:${model} unavailable: ${msg}`;
          continue;
        }
        if (r.status === 429) {
          markCool(`groq:${model}`);
          last = `groq:${model} out of quota`;
          continue;
        }
        last = `groq:${model} ${msg}`;
        continue;
      }

      d = await r.json();
      const c = d.choices?.[0];
      const text = c?.message?.content || '';
      if (!text) { last = `groq:${model} returned nothing`; continue; }

      markGood(`groq:${model}`);
      markGood('groq');
      lastGoodGroq = model;
      return {
        text,
        truncated: c.finish_reason === 'length',
        provider: `groq:${model}`,
        usage: d.usage && { in: d.usage.prompt_tokens, out: d.usage.completion_tokens, total: d.usage.total_tokens },
      };
    }

    // Only an account-level failure earns a whole-provider cooldown.
    if (accountLevel) throw Object.assign(new Error(accountLevel), { accountLevel: true });
    throw Object.assign(new Error(last), { modelLevel: true });
  }

  /* A model that is out of quota answers 429 and the next one is tried, so the
     day's capacity is the sum of the family's allowances.

     Order matters more than it looks: every model listed before the one that
     actually answers costs a full round-trip on EVERY request. Measured
     2026-08-23 against the live deployment — 8 samples, every single success
     came back as `gemini-flash-lite-latest` in about 2s, which means the two
     names that used to sit ahead of it were failing every time and buying
     nothing. They are kept as later fallbacks rather than deleted, since a
     name that is dead today may be the supported one after a Gemini rename —
     that has already happened once on this project. */
  const GEMINI_MODELS = [
    'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-2.0-flash',
    'gemini-2.0-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite',
  ];

  async function viaGemini() {
    if (!GEMINI_KEY) throw Object.assign(new Error('Gemini not configured'), { skip: true });
    // Whatever answered last time goes first; then the static order.
    const ordered = [...new Set([lastGoodGemini, ...GEMINI_MODELS].filter(Boolean))];
    // Skip models known to be out of quota — unless that would skip everything,
    // in which case the notes are stale or the whole family is spent and we
    // should still try rather than refuse.
    const warm = ordered.filter((m) => !isCool(`gem:${m}`));
    const candidates = warm.length ? warm : ordered;

    let last = 'no model answered';
    for (const model of candidates) {
      if (msLeft() <= 1500) { last = `${last} (budget spent)`; break; }
      let r, d;
      // Per-model try/catch: one model that hangs and gets aborted must not
      // abandon the models after it, which is what an uncaught throw here would do.
      try {
        r = await timeoutFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              // Gemini calls the assistant role "model" and wants parts, not content.
              contents: history.map((m) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: String(m.content || '') }],
              })),
              generationConfig: { maxOutputTokens: wanted, temperature: temp },
            }),
          },
          PER_CALL_MS
        );
        // 429 = daily allowance gone, 404 = the name no longer exists. Neither
        // resolves within this request, so stop asking for a while.
        if (r.status === 429 || r.status === 404) {
          markCool(`gem:${model}`);
          last = `${model} unavailable (${r.status})`;
          continue;
        }
        if (!r.ok) { last = `${model} HTTP ${r.status}`; continue; }
        d = await r.json();
      } catch (e) {
        last = `${model} ${e.noTime ? 'skipped (no time left)' : `timed out/aborted (${e.name})`}`;
        if (e.noTime) break;
        continue;
      }
      const c = d.candidates?.[0];
      const text = c?.content?.parts?.map((p) => p.text).join('') || '';
      if (!text.trim()) { last = `${model} returned nothing`; continue; }
      markGood(`gem:${model}`);
      lastGoodGemini = model;
      return {
        text,
        truncated: c.finishReason === 'MAX_TOKENS',
        provider: `gemini:${model}`,
        usage: d.usageMetadata && {
          in: d.usageMetadata.promptTokenCount,
          out: d.usageMetadata.candidatesTokenCount,
          total: d.usageMetadata.totalTokenCount,
        },
      };
    }
    throw new Error(last);
  }

  const chain = [viaGroq, viaGemini];
  const failures = [];
  for (const provider of chain) {
    if (msLeft() <= 1500) { failures.push('budget spent before ' + provider.name); break; }
    try {
      return res.status(200).json(await provider());
    } catch (e) {
      failures.push(e.message);
      // `skip` means we never actually called it (not configured, or already
      // cooling), so it says nothing about the provider's health.
      if (!e.skip) {
        // Both providers now track their own models individually, so a whole
        // provider is only benched when the account itself is the problem.
        //
        // This used to read `if (provider === viaGroq) markCool('groq')`, which
        // meant one retired model name — or a single slow response past the 4s
        // leash — silently took Groq out for ten minutes and dumped every
        // request onto Gemini. On 2026-09-10 that was costing roughly a third of
        // all readings; see the note above viaGroq.
        if (provider === viaGroq && e.accountLevel) markCool('groq');
        console.error('Provider failed:', e.message);
      }
    }
  }

  // Both are down or out of quota. Say so honestly — the app shows a
  // "busy, try again in a minute" message for this, which is true.
  // Returning 429 (not a 504) matters: the app retries a 429 once by itself,
  // and a 504 arrives with no body at all, so the user saw a dead screen.
  console.error(`All providers failed after ${Date.now() - startedAt}ms:`, failures.join(' | '));
  return res.status(429).json({
    error: 'Our astrologers are busy right now. Please try again in a minute.',
    detail: failures.join(' | '),
    elapsedMs: Date.now() - startedAt,
  });
}