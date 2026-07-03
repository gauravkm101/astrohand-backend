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

    // Groq vision-capable model. If this model name ever changes, update it here.
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
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

    if (!groqRes.ok) {
      const errText = await groqRes.text().catch(() => '');
      res.status(502).json({ error: 'Vision service error', detail: errText.slice(0, 200) });
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
