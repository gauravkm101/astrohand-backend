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

  async function viaGroq() {
    if (!GROQ_KEY) throw Object.assign(new Error('Groq not configured'), { skip: true });
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: systemPrompt }, ...history],
        // Indic scripts cost roughly 3-5x the tokens of the same text in English,
        // so a 2000-token ceiling silently chopped every Hindi/Tamil translation.
        max_tokens: wanted,
        temperature: temp,
        top_p: 0.95,
      }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw Object.assign(new Error(e.error?.message || `Groq HTTP ${r.status}`), { status: r.status });
    }
    const d = await r.json();
    const c = d.choices?.[0];
    const text = c?.message?.content || '';
    if (!text) throw new Error('Groq returned nothing');
    return {
      text,
      truncated: c.finish_reason === 'length',
      provider: 'groq',
      usage: d.usage && { in: d.usage.prompt_tokens, out: d.usage.completion_tokens, total: d.usage.total_tokens },
    };
  }

  // Newest first. A model that is out of quota answers 429 and the next one is
  // tried, so the day's capacity is the sum of the family's allowances.
  const GEMINI_MODELS = [
    'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest',
    'gemini-3.1-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite',
  ];

  async function viaGemini() {
    if (!GEMINI_KEY) throw Object.assign(new Error('Gemini not configured'), { skip: true });
    let last = 'no model answered';
    for (const model of GEMINI_MODELS) {
      const r = await fetch(
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
        }
      );
      if (r.status === 429 || r.status === 404) { last = `${model} unavailable (${r.status})`; continue; }
      if (!r.ok) { last = `${model} HTTP ${r.status}`; continue; }
      const d = await r.json();
      const c = d.candidates?.[0];
      const text = c?.content?.parts?.map((p) => p.text).join('') || '';
      if (!text.trim()) { last = `${model} returned nothing`; continue; }
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
    try {
      return res.status(200).json(await provider());
    } catch (e) {
      failures.push(e.message);
      if (!e.skip) console.error('Provider failed:', e.message);
    }
  }

  // Both are down or out of quota. Say so honestly — the app shows a
  // "busy, try again in a minute" message for this, which is true.
  console.error('All providers failed:', failures.join(' | '));
  return res.status(429).json({
    error: 'Our astrologers are busy right now. Please try again in a minute.',
    detail: failures.join(' | '),
  });
}