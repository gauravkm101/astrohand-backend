// Creates a Razorpay order - keeps secret key safe on server
const Razorpay = require('razorpay');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { amount, plan, email } = req.body;

    if (!amount || !plan || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const order = await razorpay.orders.create({
      amount: amount, // already in paise from frontend
      currency: 'INR',
      receipt: 'astrohand_' + plan + '_' + Date.now(),
      notes: { plan, email }
    });

    return res.status(200).json(order);

  } catch (error) {
    console.error('Razorpay order error:', error);
    return res.status(500).json({ error: error.message || 'Failed to create order' });
  }
}
