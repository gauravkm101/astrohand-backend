// Verifies Razorpay payment signature AND upgrades the user's plan in Supabase.
// Flow: signature check → fetch order from Razorpay (server-to-server, so plan/email
// come from trusted order notes, not the client) → update profiles.plan via
// Supabase service-role key.
const crypto = require('crypto');
const Razorpay = require('razorpay');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://joavchffhngutkiabgjx.supabase.co';
const VALID_PLANS = ['silver', 'gold', 'vip'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ success: false, error: 'Payment system not configured' });
  }

  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature
    } = req.body || {};

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing payment details' });
    }

    // 1) Verify signature using Razorpay secret
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    const sigBuf = Buffer.from(razorpay_signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');
    const isValid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!isValid) {
      console.error('Invalid signature for payment:', razorpay_payment_id);
      return res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }

    // 2) Fetch the order from Razorpay — trusted source for plan/email/user_id
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    const order = await razorpay.orders.fetch(razorpay_order_id);
    const notes = order.notes || {};
    const plan = String(notes.plan || '').toLowerCase();
    const email = String(notes.email || '').toLowerCase().trim();
    const userId = String(notes.user_id || '').trim();

    if (!VALID_PLANS.includes(plan) || (!email && !userId)) {
      console.error('Order notes missing plan/user:', razorpay_order_id, notes);
      return res.status(400).json({ success: false, error: 'Order is missing plan details' });
    }

    // 3) Upgrade the user's plan in Supabase (service-role key, server only)
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let planUpdated = false;

    if (serviceKey) {
      // Prefer matching by auth user id; fall back to email.
      const filter = userId
        ? 'id=eq.' + encodeURIComponent(userId)
        : 'email=eq.' + encodeURIComponent(email);

      const supaRes = await fetch(SUPABASE_URL + '/rest/v1/profiles?' + filter, {
        method: 'PATCH',
        headers: {
          'apikey': serviceKey,
          'Authorization': 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ plan: plan })
      });

      if (supaRes.ok) {
        const rows = await supaRes.json();
        planUpdated = Array.isArray(rows) && rows.length > 0;
        if (!planUpdated) {
          console.error('Payment verified but no profile row matched:', { email, userId, plan });
        }
      } else {
        const errText = await supaRes.text();
        console.error('Supabase plan update failed:', supaRes.status, errText);
      }
    } else {
      console.error('SUPABASE_SERVICE_ROLE_KEY not set — plan not upgraded for', email);
    }

    console.log('Payment verified:', {
      email, plan, payment_id: razorpay_payment_id, plan_updated: planUpdated
    });

    // Payment itself is genuine either way — tell the frontend whether the
    // plan got activated so it can show "contact support" if needed.
    return res.status(200).json({
      success: true,
      plan_updated: planUpdated,
      payment_id: razorpay_payment_id,
      plan: plan
    });

  } catch (error) {
    console.error('Verification error:', error);
    return res.status(500).json({ success: false, error: 'Verification failed' });
  }
}
