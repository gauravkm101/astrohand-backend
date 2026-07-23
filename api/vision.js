// api/vision.js — Vercel serverless function for palm-photo verification.
//
// Groq decommissioned ALL of its vision models (llama-4-scout/maverick, 2026-07),
// so this now uses Google Gemini vision (gemini-2.0-flash, free tier). The contract
// is UNCHANGED so the frontend needs no edits:
//     POST { imageBase64 }  ->  { isPalm: boolean, answer: string }
//
// SETUP (one time):
//   1. Get a Gemini API key at https://aistudio.google.com/apikey (use the "AstroHand"
//      Google Cloud project) — free tier is plenty for palm verification.
//   2. Vercel → astrohand-backend → Settings → Environment Variables:
//        GEMINI_API_KEY = <the key>
//   3. Redeploy (a git push does this). The key stays server-side, never in the browser.
// Until GEMINI_API_KEY is set it returns a 500 and the frontend falls back to its
// local skin/detail heuristic — so nothing breaks, it just isn't AI-verified.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) { res.status(400).json({ error: 'No image provided' }); return; }

    const KEY = process.env.GEMINI_API_KEY;
    if (!KEY) { res.status(500).json({ error: 'Server not configured' }); return; }

    // Gemini wants RAW base64 + an explicit mime type — strip any data: URL prefix.
    let mime = 'image/jpeg', b64 = imageBase64;
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(imageBase64);
    if (m) { mime = m[1]; b64 = m[2]; }

    const prompt = 'Look at this image. Is it a clear photo of the INSIDE of a human hand '
      + '(the palm side, showing palm lines/creases), suitable for palmistry? Answer with ONLY '
      + 'one word: "PALM" if it clearly shows a human palm (inside of hand with lines), or "NO" '
      + 'for anything else (the back of a hand, a single finger, an animal, an object, a face, '
      + 'scenery, or an unclear image).';

    const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];
    const ask = (model) => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 20 },
        }),
      });

    let gRes = null, lastErr = '';
    for (const model of MODELS) {
      const attempt = await ask(model);
      if (attempt.ok) { gRes = attempt; break; }
      lastErr = await attempt.text().catch(() => '');
      // fall through to the next model if THIS one is missing/unsupported OR is
      // quota/rate-limited (429) — a different model may have free quota left.
      if (!/not.?found|does not exist|not supported|unavailable|is not found|quota|rate.?limit|RESOURCE_EXHAUSTED|"code":\s*429/i.test(lastErr)) {
        res.status(502).json({ error: 'Vision service error', detail: lastErr.slice(0, 200) });
        return;
      }
    }
    if (!gRes) {
      res.status(502).json({ error: 'Vision service error', detail: ('No available vision model. ' + lastErr).slice(0, 200) });
      return;
    }

    const data = await gRes.json();
    const answer = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toUpperCase();
    const isPalm = answer.includes('PALM');
    res.status(200).json({ isPalm, answer });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: String(err).slice(0, 200) });
  }
}
