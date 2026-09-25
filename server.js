require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// ============================================
// CONFIG
// ============================================
const FREE_DAILY_LIMIT = 7;
const PAYPAL_CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
const PAYPAL_API = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

const PRICES = {
  monthly: { amount: 10, days: 30, label: 'شهري' },
  yearly: { amount: 110, days: 365, label: 'سنوي' },
};

console.log(`💳 PayPal mode: ${PAYPAL_MODE.toUpperCase()}`);
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) console.warn('⚠️ PayPal credentials missing.');
if (!APP_URL) console.warn('⚠️ APP_URL missing.');

// ============================================
// SUPABASE
// ============================================
const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '').trim();
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

if (!supabase) console.warn('⚠️ Supabase not configured.');

// ============================================
// GEMINI KEYS
// ============================================
const apiKeys = (process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
for (let i = 1; i <= 100; i++) {
  const k = (process.env['GEMINI_API_KEY_' + i] || '').trim();
  if (k) apiKeys.push(k);
}
const uniqueKeys = [...new Set(apiKeys)];

const keyStates = uniqueKeys.map((key, idx) => ({
  key, idx, exhaustedUntil: 0, lastUsed: 0, successCount: 0, failCount: 0, consecutive503: 0, lastError: '',
}));

console.log(`✅ Loaded ${keyStates.length} Gemini key(s).`);

function pickKey() {
  const now = Date.now();
  const available = keyStates.filter(k => k.exhaustedUntil <= now);
  if (available.length === 0) return null;
  available.sort((a, b) => a.lastUsed - b.lastUsed);
  return available[0];
}

function coolDown(state, seconds, reason) {
  state.exhaustedUntil = Date.now() + seconds * 1000;
  state.failCount++;
  state.lastError = reason;
  console.warn(`🔴 Key #${state.idx + 1} cooldown ${seconds}s — ${reason}`);
}

function isQuotaError(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('429') || m.includes('quota') || m.includes('rate') || m.includes('resource_exhausted');
}

function isOverloaded(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('503') || m.includes('high demand') || m.includes('overloaded') || m.includes('unavailable');
}

const MODEL = 'gemini-3.5-flash-lite';
const MAX_ROUNDS = 2;

async function generateText(contents) {
  if (keyStates.length === 0) throw new Error('No API keys.');
  let lastError = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let triedAnyKeyThisRound = false;
    for (let k = 0; k < keyStates.length; k++) {
      const state = pickKey();
      if (!state) continue;
      triedAnyKeyThisRound = true;
      state.lastUsed = Date.now();
      try {
        const ai = new GoogleGenAI({ apiKey: state.key });
        const response = await ai.models.generateContent({ model: MODEL, contents });
        state.successCount++;
        state.consecutive503 = 0;
        console.log(`✅ Key #${state.idx + 1} OK (total: ${state.successCount})`);
        return response.text || '';
      } catch (err) {
        const msg = String(err.message || '');
        console.error(`❌ Key #${state.idx + 1}:`, msg.slice(0, 150));
        lastError = msg;
        if (msg.includes('400') || msg.includes('invalid')) throw new Error('BAD_REQUEST: ' + msg.slice(0, 200));
        else if (isQuotaError(msg)) coolDown(state, 60, 'quota');
        else if (isOverloaded(msg)) {
          state.consecutive503++;
          const backoff = Math.min(10 * state.consecutive503, 45);
          coolDown(state, backoff, `google busy x${state.consecutive503}`);
        } else coolDown(state, 8, msg.slice(0, 60));
      }
    }
    if (!triedAnyKeyThisRound && round < MAX_ROUNDS - 1) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw new Error('GENERATION_FAILED: ' + lastError);
}

// ============================================
// AUTH HELPERS
// ============================================
async function getUserFromToken(req) {
  if (!supabase) return null;
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(authHeader.slice(7));
    if (error || !user) return null;
    return user;
  } catch { return null; }
}

async function requireAuth(req, res, next) {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

// ============================================
// SUBSCRIPTION HELPERS
// ============================================
async function getOrCreateProfile(userId, email) {
  if (!supabase) return null;
  let { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (!profile) {
    const { data: newProfile } = await supabase.from('profiles')
      .insert([{ id: userId, email, plan: 'free', messages_today: 0, last_reset_at: new Date().toISOString() }])
      .select().single();
    profile = newProfile;
  }
  return profile;
}

function shouldResetDaily(profile) {
  if (!profile.last_reset_at) return true;
  const hours = (new Date() - new Date(profile.last_reset_at)) / (1000 * 60 * 60);
  return hours >= 24;
}

async function checkAndIncrementUsage(user, email) {
  const profile = await getOrCreateProfile(user.id, email);
  if (!profile) return { allowed: true, reason: 'no-profile' };

  if (profile.plan === 'premium') {
    if (profile.subscription_expires_at && new Date(profile.subscription_expires_at) < new Date()) {
      await supabase.from('profiles')
        .update({ plan: 'free', messages_today: 0, last_reset_at: new Date().toISOString() })
        .eq('id', user.id);
      return { allowed: false, reason: 'expired', remaining: 0, plan: 'free' };
    }
    return { allowed: true, reason: 'premium', remaining: -1, plan: 'premium' };
  }

  let messagesToday = profile.messages_today || 0;
  let lastResetAt = profile.last_reset_at;
  
  if (shouldResetDaily(profile)) {
    messagesToday = 0;
    lastResetAt = new Date().toISOString();
  }

  if (messagesToday >= FREE_DAILY_LIMIT) {
    return { allowed: false, reason: 'limit', remaining: 0, plan: 'free', limit: FREE_DAILY_LIMIT };
  }

  const newMessagesToday = messagesToday + 1;
  await supabase.from('profiles')
    .update({ messages_today: newMessagesToday, last_reset_at: lastResetAt })
    .eq('id', user.id);

  return { 
    allowed: true, 
    reason: 'free', 
    remaining: Math.max(0, FREE_DAILY_LIMIT - newMessagesToday), 
    limit: FREE_DAILY_LIMIT,
    plan: 'free' 
  };
}

// ============================================
// PAYPAL HELPERS
// ============================================
async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error('PayPal not configured.');
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('PayPal token error:', err.slice(0, 300));
    throw new Error('PayPal auth failed.');
  }
  return (await res.json()).access_token;
}

// ============================================
// ROUTES
// ============================================
app.get('/ping', (req, res) => res.status(200).send('OK 🚀'));

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const profile = await getOrCreateProfile(req.user.id, req.user.email);
  
  let messagesToday = profile?.messages_today || 0;
  if (profile && shouldResetDaily(profile)) messagesToday = 0;

  res.json({
    user: { id: req.user.id, email: req.user.email },
    profile: profile ? {
      plan: profile.plan || 'free',
      messages_today: messagesToday,
      remaining: profile.plan === 'premium' ? -1 : Math.max(0, FREE_DAILY_LIMIT - messagesToday),
      limit: FREE_DAILY_LIMIT,
      subscription_expires_at: profile.subscription_expires_at,
    } : null,
  });
});

app.post('/api/auth/signup', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured.' });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/auth/login', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured.' });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/auth/refresh', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured.' });
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token required.' });
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error) return res.status(401).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/subscription/status', requireAuth, async (req, res) => {
  const profile = await getOrCreateProfile(req.user.id, req.user.email);
  if (!profile) return res.status(500).json({ error: 'Profile error.' });

  let messagesToday = profile.messages_today || 0;
  if (shouldResetDaily(profile)) messagesToday = 0;

  const isPremium = profile.plan === 'premium' &&
    (!profile.subscription_expires_at || new Date(profile.subscription_expires_at) > new Date());

  res.json({
    plan: isPremium ? 'premium' : 'free',
    isPremium,
    messagesToday,
    remaining: isPremium ? -1 : Math.max(0, FREE_DAILY_LIMIT - messagesToday),
    limit: FREE_DAILY_LIMIT,
    expiresAt: profile.subscription_expires_at || null,
    prices: {
      monthly: PRICES.monthly.amount,
      yearly: PRICES.yearly.amount,
    },
  });
});

app.post('/api/paypal/create-order', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan || !PRICES[plan]) return res.status(400).json({ error: 'Invalid plan.' });

    const priceData = PRICES[plan];
    const accessToken = await getPayPalAccessToken();

    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'USD', value: priceData.amount.toFixed(2) },
          description: `Smart AI Premium - ${priceData.label}`,
          custom_id: `${req.user.id}|${plan}`,
        }],
        application_context: {
          brand_name: 'Smart AI',
          user_action: 'PAY_NOW',
          return_url: `${APP_URL}/?payment=success`,
          cancel_url: `${APP_URL}/?payment=cancel`,
        },
      }),
    });

    if (!orderRes.ok) {
      const err = await orderRes.text();
      console.error('PayPal create order error:', err.slice(0, 300));
      return res.status(500).json({ error: 'فشل إنشاء الطلب.' });
    }

    const order = await orderRes.json();
    const approvalLink = order.links?.find(l => l.rel === 'approve')?.href;
    if (!approvalLink) return res.status(500).json({ error: 'No approval link.' });

    console.log(`💳 Order: ${order.id} | User: ${req.user.id} | Plan: ${plan}`);
    res.json({ orderId: order.id, approvalUrl: approvalLink });
  } catch (err) {
    console.error('Create order error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/paypal/capture-order', requireAuth, async (req, res) => {
  try {
    const { orderId, plan } = req.body;
    if (!orderId || !plan || !PRICES[plan]) return res.status(400).json({ error: 'Invalid request.' });

    const accessToken = await getPayPalAccessToken();

    const captureRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!captureRes.ok) {
      const err = await captureRes.text();
      console.error('PayPal capture error:', err.slice(0, 300));
      return res.status(500).json({ error: 'فشل تأكيد الدفع.' });
    }

    const captureData = await captureRes.json();
    if (captureData.status !== 'COMPLETED') return res.status(400).json({ error: 'لم يتم إكمال الدفع.' });

    const capture = captureData.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = capture?.id;
    const payerId = captureData.payer?.payer_id;

    const days = PRICES[plan].days;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    const { error: updateErr } = await supabase.from('profiles')
      .update({
        plan: 'premium',
        subscription_plan: plan,
        subscription_started_at: new Date().toISOString(),
        subscription_expires_at: expiresAt.toISOString(),
        paypal_order_id: orderId,
        paypal_payer_id: payerId,
      })
      .eq('id', req.user.id);

    if (updateErr) console.error('Upgrade error:', updateErr.message);

    await supabase.from('payments').insert([{
      user_id: req.user.id,
      paypal_order_id: orderId,
      paypal_capture_id: captureId,
      amount: PRICES[plan].amount,
      currency: 'USD',
      plan,
      status: 'completed',
    }]);

    console.log(`✅ Payment success! User: ${req.user.id} | Plan: ${plan} | Order: ${orderId}`);

    res.json({
      success: true,
      plan: 'premium',
      subscriptionPlan: plan,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('Capture error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/conversations', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('conversations')
    .select('id, title, created_at, updated_at')
    .eq('user_id', req.user.id)
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversations: data || [] });
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  const { title } = req.body;
  const { data, error } = await supabase.from('conversations')
    .insert([{ title: title || 'محادثة جديدة', user_id: req.user.id }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversation: data });
});

app.put('/api/conversations/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required.' });
  const { error } = await supabase.from('conversations')
    .update({ title: title.trim(), updated_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  await supabase.from('messages').delete().eq('conversation_id', id);
  const { error } = await supabase.from('conversations')
    .delete().eq('id', id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { data: conv } = await supabase.from('conversations')
    .select('id').eq('id', id).eq('user_id', req.user.id).single();
  if (!conv) return res.status(404).json({ error: 'Not found.' });

  const { data, error } = await supabase.from('messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data || [] });
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message required.' });

  const usage = await checkAndIncrementUsage(req.user, req.user.email);
  if (!usage.allowed) {
    return res.status(429).json({
      error: 'LIMIT_REACHED',
      message: usage.reason === 'expired'
        ? 'انتهى اشتراكك. جدّد للاستمرار.'
        : `انتهت رسائلك المجانية لهذا اليوم (${FREE_DAILY_LIMIT} رسائل).`,
      reason: usage.reason,
      remaining: usage.remaining,
      plan: usage.plan,
    });
  }

  const { data: conv } = await supabase.from('conversations')
    .select('id, title').eq('id', id).eq('user_id', req.user.id).single();
  if (!conv) return res.status(404).json({ error: 'Not found.' });

  const { error: userErr } = await supabase.from('messages')
    .insert([{ conversation_id: id, role: 'user', content: content.trim() }]);
  if (userErr) return res.status(500).json({ error: userErr.message });

  const { data: historyRaw } = await supabase.from('messages')
    .select('role, content').eq('conversation_id', id)
    .order('created_at', { ascending: false }).limit(20);

  const history = (historyRaw || []).reverse();

  const contents = [];
  for (const m of history) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const text = m.content || '';
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += '\n' + text;
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }
  while (contents.length > 0 && contents[0].role === 'model') contents.shift();
  while (contents.length > 0 && contents[contents.length - 1].role === 'model') contents.pop();
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: content.trim() }] });

  let aiText = '';
  try {
    aiText = await generateText(contents);
    if (!aiText) aiText = '⚠️ لم يتم استلام رد.';
  } catch (err) {
    console.error('Generate error:', err.message);
    if (err.message.startsWith('BAD_REQUEST')) aiText = '⚠️ خطأ في صيغة الطلب.';
    else if (err.message.startsWith('GENERATION_FAILED')) aiText = '⚠️ الموديل مزدحم. حاول بعد قليل.';
    else aiText = '⚠️ حدث خطأ. حاول لاحقاً.';
  }

  const { data: aiMsg } = await supabase.from('messages')
    .insert([{ conversation_id: id, role: 'assistant', content: aiText }])
    .select().single();

  const updates = { updated_at: new Date().toISOString() };
  if (conv.title === 'محادثة جديدة' || conv.title === 'New Chat') {
    updates.title = content.trim().slice(0, 40);
  }
  await supabase.from('conversations').update(updates).eq('id', id);

  res.json({
    aiMessage: aiMsg || { role: 'assistant', content: aiText },
    usage: { plan: usage.plan, remaining: usage.remaining, limit: usage.limit || FREE_DAILY_LIMIT },
  });
});

app.get('/api/keys-status', requireAuth, (req, res) => {
  const now = Date.now();
  res.json({
    total: keyStates.length,
    model: MODEL,
    status: keyStates.map(k => ({
      index: k.idx + 1,
      available: k.exhaustedUntil <= now,
      cooldownSec: Math.max(0, Math.ceil((k.exhaustedUntil - now) / 1000)),
      success: k.successCount, fail: k.failCount,
      lastError: k.lastError ? k.lastError.slice(0, 80) : '',
    })),
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || '';
if (SELF_URL) {
  console.log(`🔁 Self-ping enabled every 10 min`);
  setInterval(() => {
    fetch(`${SELF_URL}/ping`)
      .then(r => console.log(`💓 Self-ping OK (${r.status})`))
      .catch(e => console.warn('Self-ping failed:', e.message));
  }, 10 * 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`🔑 Keys: ${keyStates.length}`);
  console.log(`📦 Model: ${MODEL}`);
  console.log(`💳 PayPal: ${PAYPAL_MODE}`);
  console.log(`💵 Monthly: $${PRICES.monthly.amount} | Yearly: $${PRICES.yearly.amount}`);
});
