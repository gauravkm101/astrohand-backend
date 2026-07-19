// api/vision.js  —  Vercel serverless function for palm-photo verification
// Deploy this alongside your existing api/chat.js on Vercel.
// It receives a base64 image, asks a Groq VISION model whether the image
// is a human palm, and returns a simple yes/no verdict. The Groq API key
// stays safe on the server (never in the browser).

export default async function handler(req, res) {
  // CORS (so your site can call it)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) { res.status(400).json({ error: 'No image provided' }); return; }

    // Build a data URL for the vision model
    const dataUrl = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) { res.status(500).json({ error: 'Server not configured' }); return; }

    // Groq retires vision models from time to time (llama-4-scout died 2026-07),
    // so ask Groq which models exist RIGHT NOW and pick the vision-capable ones,
    // with the old known names as a safety net.
    let CANDIDATE_MODELS = [];
    try {
      const ml = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
      });
      if (ml.ok) {
        const list = (await ml.json()).data || [];
        CANDIDATE_MODELS = list
          .map((m) => m.id)
          .filter((id) => /scout|maverick|vision|llava|-vl-|vl\b/i.test(id))
          .sort((a, b) => (b.includes('maverick') ? 1 : 0) - (a.includes('maverick') ? 1 : 0));
      }
    } catch (_) {}
    CANDIDATE_MODELS = CANDIDATE_MODELS.concat([
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'meta-llama/llama-4-scout-17b-16e-instruct',
    ]).filter((v, i, a) => a.indexOf(v) === i);

    const askModel = (model) => fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 20,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Look at this image. Is it a clear photo of the INSIDE of a human hand (the palm side, showing palm lines/creases), suitable for palmistry? Answer with ONLY one word: "PALM" if it clearly shows a human palm (inside of hand with lines), or "NO" if it shows anything else (the back of a hand, a single finger, an animal, an object, a face, scenery, or an unclear image).',
              },
              {
                type: 'image_url',
                image_url: { url: dataUrl },
              },
            ],
          },
        ],
      }),
    });

    let groqRes = null, lastErr = '';
    for (const model of CANDIDATE_MODELS) {
      const attempt = await askModel(model);
      if (attempt.ok) { groqRes = attempt; break; }
      lastErr = await attempt.text().catch(() => '');
      // Only fall through to the next model when this one is missing/unavailable.
      if (!/model_not_found|does not exist|decommissioned/i.test(lastErr)) {
        res.status(502).json({ error: 'Vision service error', detail: lastErr.slice(0, 200) });
        return;
      }
    }

    if (!groqRes) {
      res.status(502).json({ error: 'Vision service error', detail: ('No available vision model. ' + lastErr).slice(0, 200) });
      return;
    }

    const data = await groqRes.json();
    const answer = (data?.choices?.[0]?.message?.content || '').trim().toUpperCase();
    const isPalm = answer.includes('PALM');

    res.status(200).json({ isPalm, answer });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: String(err).slice(0, 200) });
  }
}
