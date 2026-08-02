// Verifies a Google Play purchase and applies it in Supabase.
//
// The app sends only a purchase token. We ask Google whether that token is real
// before touching anything — a client claim is never trusted. On success we
// write the SAME profiles columns the website's Razorpay flow writes
// (plan / plan_since / plan_until / report_credits), so a plan bought in the
// app unlocks on astrohand.in and vice-versa.
//
// Env required (Vercel):
//   GOOGLE_PLAY_SA_JSON      service-account JSON with Android Publisher access
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_URL             (optional, defaults below)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://joavchffhngutkiabgjx.supabase.co';
const PACKAGE_NAME = 'in.astrohand.astrohand_app';

// Product id → what it grants. Must match Play Console exactly.
const PRODUCTS = {
  astrohand_silver_monthly: { kind: 'sub', plan: 'silver' },
  astrohand_gold_monthly:   { kind: 'sub', plan: 'gold' },
  astrohand_vip_monthly:    { kind: 'sub', plan: 'vip' },
  astrohand_report_99:      { kind: 'report' },
};

/** Google OAuth2 access token from the service account (JWT bearer flow). */
async function googleAccessToken() {
  const raw = process.env.GOOGLE_PLAY_SA_JSON;
  if (!raw) throw new Error('GOOGLE_PLAY_SA_JSON not set');
  const sa = JSON.parse(raw);
  const crypto = require('crypto');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(claim)}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Google token exchange failed');
  return json.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { product_id, purchase_token, user_id, email } = req.body || {};
    if (!product_id || !purchase_token || (!user_id && !email)) {
      return res.status(400).json({ success: false, error: 'Missing purchase details' });
    }

    const product = PRODUCTS[product_id];
    if (!product) return res.status(400).json({ success: false, error: 'Unknown product' });

    // ── 1) Ask Google whether this purchase is genuine ──────────────────────
    const token = await googleAccessToken();
    const kind = product.kind === 'sub' ? 'subscriptions' : 'products';
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/${kind}/${encodeURIComponent(product_id)}/tokens/${encodeURIComponent(purchase_token)}`;
    const gRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!gRes.ok) {
      console.error('Play verification failed:', gRes.status, await gRes.text());
      return res.status(400).json({ success: false, error: 'Purchase could not be verified' });
    }
    const purchase = await gRes.json();

    // Subscriptions: 0 = payment received. One-time: purchaseState 0 = purchased.
    const ok = product.kind === 'sub'
      ? (purchase.paymentState === 1 || purchase.paymentState === 0 || !!purchase.expiryTimeMillis)
      : purchase.purchaseState === 0;
    if (!ok) {
      return res.status(400).json({ success: false, error: 'Purchase is not in a paid state' });
    }

    // ── 2) Apply it in Supabase (service role — bypasses the client guard) ──
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      console.error('SUPABASE_SERVICE_ROLE_KEY not set — purchase not applied for', email);
      return res.status(200).json({ success: true, applied: false });
    }
    const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

    let uid = user_id;
    if (!uid && email) {
      const look = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id`, { headers: h });
      if (look.ok) { const rows = await look.json(); uid = rows[0] && rows[0].id; }
    }
    // Self-heal a missing row so a paying customer is never left without one.
    if (uid) {
      const chk = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=id`, { headers: h });
      const rows = chk.ok ? await chk.json() : [];
      if (!rows.length) {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
          method: 'POST',
          headers: { ...h, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ id: uid, email: email || null, plan: 'free', joined_at: new Date().toISOString() }),
        });
      }
    }
    if (!uid) {
      console.error('Play purchase verified but no profile matched:', { email, user_id });
      return res.status(200).json({ success: true, applied: false });
    }

    let applied = false;
    if (product.kind === 'report') {
      const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/grant_report_credit`, {
        method: 'POST', headers: h, body: JSON.stringify({ uid }),
      });
      if (rpc.ok) {
        const bal = Number(await rpc.text());
        applied = Number.isFinite(bal) && bal > 0;
      }
    } else {
      // Trust Google's expiry when present, else fall back to 30 days.
      const until = purchase.expiryTimeMillis
        ? new Date(Number(purchase.expiryTimeMillis))
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const patch = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}`, {
        method: 'PATCH',
        headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({
          plan: product.plan,
          plan_since: new Date().toISOString(),
          plan_until: until.toISOString(),
        }),
      });
      if (patch.ok) {
        const rows = await patch.json();
        applied = Array.isArray(rows) && rows.length > 0;
      }
    }

    console.log('Play purchase applied:', { product_id, uid, applied });
    return res.status(200).json({ success: true, applied });
  } catch (error) {
    console.error('verify-play-purchase error:', error);
    return res.status(500).json({ success: false, error: 'Verification failed' });
  }
}
