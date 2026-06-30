// Verifies Razorpay payment signature - prevents fake payment claims
const crypto = require('crypto');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      plan,
      email
    } = req.body;

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    // Verify signature using Razorpay secret
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      console.error('Invalid signature for payment:', razorpay_payment_id);
      return res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }

    // Payment verified successfully
    // TODO: Update Supabase profile with new plan + log transaction
    console.log('Payment verified:', { email, plan, payment_id: razorpay_payment_id });

    return res.status(200).json({
      success: true,
      payment_id: razorpay_payment_id,
      plan
    });

  } catch (error) {
    console.error('Verification error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Verification failed' });
  }
}
