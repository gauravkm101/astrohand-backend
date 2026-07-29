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

    const isReport = plan === 'report';
    if ((!isReport && !VALID_PLANS.includes(plan)) || (!email && !userId)) {
      console.error('Order notes missing plan/user:', razorpay_order_id, notes);
      return res.status(400).json({ success: false, error: 'Order is missing plan details' });
    }

    // 3) Apply the purchase in Supabase (service-role key, server only)
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const svcHeaders = { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
    let applied = false;

    if (serviceKey) {
      if (isReport) {
        // One-time ₹99 report: grant ONE report credit — never touches the plan.
        // grant_report_credit(uuid) needs the profile id, so resolve it first.
        let uid = userId;
        if (!uid) {
          const look = await fetch(SUPABASE_URL + '/rest/v1/profiles?email=eq.' + encodeURIComponent(email) + '&select=id', { headers: svcHeaders });
          if (look.ok) { const rows = await look.json(); uid = (Array.isArray(rows) && rows[0]) ? rows[0].id : ''; }
        }
        if (uid) {
          const rpc = await fetch(SUPABASE_URL + '/rest/v1/rpc/grant_report_credit', {
            method: 'POST', headers: svcHeaders, body: JSON.stringify({ uid })
          });
          applied = rpc.ok;
          if (!rpc.ok) console.error('grant_report_credit failed:', rpc.status, await rpc.text());
        } else {
          console.error('Report payment verified but no profile matched:', { email, userId });
        }
      } else {
        // Subscription: set the plan + a 30-day validity window.
        const filter = userId ? 'id=eq.' + encodeURIComponent(userId) : 'email=eq.' + encodeURIComponent(email);
        const supaRes = await fetch(SUPABASE_URL + '/rest/v1/profiles?' + filter, {
          method: 'PATCH',
          headers: { ...svcHeaders, 'Prefer': 'return=representation' },
          body: JSON.stringify({
            plan: plan,
            plan_since: new Date().toISOString(),
            plan_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          })
        });
        if (supaRes.ok) {
          const rows = await supaRes.json();
          applied = Array.isArray(rows) && rows.length > 0;
          if (!applied) console.error('Payment verified but no profile row matched:', { email, userId, plan });
        } else {
          console.error('Supabase plan update failed:', supaRes.status, await supaRes.text());
        }
      }
    } else {
      console.error('SUPABASE_SERVICE_ROLE_KEY not set — purchase not applied for', email);
    }

    console.log('Payment verified:', { email, plan, payment_id: razorpay_payment_id, applied });

    // Payment itself is genuine either way — tell the frontend what got applied.
    return res.status(200).json({
      success: true,
      plan_updated: applied,
      credit_granted: isReport && applied,
      payment_id: razorpay_payment_id,
      plan: plan
    });

  } catch (error) {
    console.error('Verification error:', error);
    return res.status(500).json({ success: false, error: 'Verification failed' });
  }
}
