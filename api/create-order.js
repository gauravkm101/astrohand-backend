// Creates a Razorpay order - keeps secret key safe on server.
// SECURITY: price is decided HERE from the plan name. Any amount sent by the
// frontend is ignored, so nobody can pay ₹1 and get VIP.
const Razorpay = require('razorpay');

// Fixed price list (in paise). Change prices here, never trust the client.
const PLAN_PRICES = {
  silver: 49900,  // ₹499
  gold: 99900,    // ₹999
  vip: 199900     // ₹1999
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Payment system not configured' });
  }

  try {
    const { plan, email, user_id } = req.body || {};

    const planKey = String(plan || '').toLowerCase().trim();
    const amount = PLAN_PRICES[planKey];

    if (!amount) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Missing or invalid email' });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    // plan/email/user_id go into order notes — verify-payment.js reads them
    // back from Razorpay (server-to-server), NOT from the client.
    const order = await razorpay.orders.create({
      amount: amount,
      currency: 'INR',
      receipt: 'astrohand_' + planKey + '_' + Date.now(),
      notes: {
        plan: planKey,
        email: email.toLowerCase().trim(),
        user_id: user_id ? String(user_id) : ''
      }
    });

    return res.status(200).json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      plan: planKey
    });

  } catch (error) {
    console.error('Razorpay order error:', error);
    return res.status(500).json({ error: 'Failed to create order' });
  }
}
