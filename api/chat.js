// AstroHand AI API Proxy
// This file runs on Vercel serverless - your Groq key stays secret

const GROQ_KEY = process.env.GROQ_API_KEY; // Set this in Vercel dashboard
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

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.slice(-12) // max 12 messages history
        ],
        // Indic scripts cost roughly 3–5x the tokens of the same text in English,
        // so a 2000-token ceiling silently chopped every Hindi/Tamil/Bengali
        // translation mid-sentence. Long reports need the headroom too.
        max_tokens: Math.min(Math.max(Number(maxTokens) || 1000, 1), 8000),
        // Readings want warmth; a translation wants fidelity. 0.85 for everything
        // made translations drift and paraphrase, so callers can now ask for less.
        temperature: Number.isFinite(temperature)
          ? Math.max(0, Math.min(1.5, temperature))
          : 0.85,
        top_p: 0.95
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('Groq error:', err);
      return res.status(response.status).json({ 
        error: err.error?.message || 'AI service error' 
      });
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content || '';

    if (!text) {
      return res.status(500).json({ error: 'Empty response from AI' });
    }

    // 'length' means the model ran out of room and the text stops mid-sentence.
    // Callers translate long readings in chunks and need to know, rather than
    // quietly showing a half-finished result.
    //
    // `usage` is passed through so the cost of a feature can actually be
    // measured instead of guessed — the provider bills per token and the free
    // tier is capped per day, so knowing what one Kundli costs decides when a
    // paid plan is needed.
    return res.status(200).json({
      text,
      truncated: choice?.finish_reason === 'length',
      usage: data.usage
        ? {
            in: data.usage.prompt_tokens,
            out: data.usage.completion_tokens,
            total: data.usage.total_tokens,
          }
        : undefined,
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
