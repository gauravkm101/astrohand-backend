// Creates a Razorpay order - keeps secret key safe on server.
// SECURITY: price is decided HERE from the plan name + server-validated coupon.
// Any amount sent by the frontend is ignored, so nobody can pay ₹1 and get VIP.
const Razorpay = require('razorpay');

// Fixed price list (in rupees). Change prices here, never trust the client.
const PLAN_PRICES_INR = {
  silver: 499,
  gold: 999,
  vip: 1999
};

// Must stay in sync with the COUPONS table in index.html (frontend shows the
// discount, backend enforces it).
const COUPONS = {
  'WELCOME20': { pct: 20, expires: '2026-12-31', plans: ['gold', 'vip'] },
  'GOLD10':    { pct: 10, expires: '2026-12-31', plans: ['gold'] },
  'VIP15':     { pct: 15, expires: '2026-12-31', plans: ['vip'] }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return res.status(503).json({ error: 'Payment system not configured' });
  }

  try {
    const { plan, email, user_id, coupon } = req.body || {};

    const planKey = String(plan || '').toLowerCase().trim();
    const baseInr = PLAN_PRICES_INR[planKey];

    if (!baseInr) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Missing or invalid email' });
    }

    // Server-side coupon validation (mirror of frontend rules).
    // Rupees-first rounding matches the price the user sees in the modal.
    let chargeInr = baseInr;
    let couponCode = '';
    if (coupon) {
      const c = COUPONS[String(coupon).toUpperCase().trim()];
      const notExpired = c && (!c.expires || new Date() <= new Date(c.expires + 'T23:59:59'));
      const planAllowed = c && (!c.plans || c.plans.includes(planKey));
      if (c && notExpired && planAllowed) {
        chargeInr = Math.round(baseInr * (1 - c.pct / 100));
        couponCode = String(coupon).toUpperCase().trim();
      } else {
        return res.status(400).json({ error: 'Invalid or expired coupon' });
      }
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    // plan/email/user_id go into order notes — verify-payment.js reads them
    // back from Razorpay (server-to-server), NOT from the client.
    const order = await razorpay.orders.create({
      amount: chargeInr * 100, // paise
      currency: 'INR',
      receipt: 'astrohand_' + planKey + '_' + Date.now(),
      notes: {
        plan: planKey,
        email: email.toLowerCase().trim(),
        user_id: user_id ? String(user_id) : '',
        coupon: couponCode
      }
    });

    // key_id is Razorpay's PUBLIC key — safe to send; keeps it out of index.html
    // so going live never needs a frontend edit.
    return res.status(200).json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      plan: planKey,
      key_id: process.env.RAZORPAY_KEY_ID
    });

  } catch (error) {
    console.error('Razorpay order error:', error);
    return res.status(500).json({ error: 'Failed to create order' });
  }
}
