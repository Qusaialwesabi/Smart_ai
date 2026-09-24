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
// SUPABASE
// ============================================
const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '').trim();
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

if (!supabase) console.warn('⚠️ Supabase not configured.');

// ============================================
// GEMINI KEYS
// ============================================
const apiKeys = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

for (let i = 1; i <= 100; i++) {
  const k = (process.env['GEMINI_API_KEY_' + i] || '').trim();
  if (k) apiKeys.push(k);
}

const uniqueKeys = [...new Set(apiKeys)];

const keyStates = uniqueKeys.map((key, idx) => ({
  key,
  idx,
  exhaustedUntil: 0,
  lastUsed: 0,
  successCount: 0,
  failCount: 0,
  lastError: '',
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
  console.warn(`🔴 Key #${state.idx + 1} cooldown for ${seconds}s — ${reason}`);
}

function isQuotaError(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('429') ||
    m.includes('quota') ||
    m.includes('rate') ||
    m.includes('resource_exhausted') ||
    m.includes('too many requests')
  );
}

function isServerError(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('503') || m.includes('500') || m.includes('unavailable') || m.includes('overloaded');
}

// ============================================
// MODEL (only one)
// ============================================
const MODEL = 'gemini-3.5-flash-lite';

// ============================================
// GENERATE TEXT (Key Rotation)
// ============================================
async function generateText(contents) {
  if (keyStates.length === 0) throw new Error('No API keys configured.');

  const maxAttempts = keyStates.length + 2;
  let lastError = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const state = pickKey();
    if (!state) throw new Error('ALL_KEYS_EXHAUSTED');

    state.lastUsed = Date.now();

    try {
      const ai = new GoogleGenAI({ apiKey: state.key });
      const response = await ai.models.generateContent({
        model: MODEL,
        contents,
      });

      state.successCount++;
      console.log(`✅ Key #${state.idx + 1} succeeded (total: ${state.successCount})`);
      return response.text || '';
    } catch (err) {
      const msg = String(err.message || '');
      console.error(`❌ Key #${state.idx + 1} error:`, msg.slice(0, 200));

      if (isQuotaError(msg)) {
        coolDown(state, 60, 'quota/rate limit');
      } else if (isServerError(msg)) {
        coolDown(state, 20, 'server error');
      } else if (msg.includes('400') || msg.includes('not supported') || msg.includes('invalid')) {
        throw new Error('BAD_REQUEST: ' + msg.slice(0, 200));
      } else {
        coolDown(state, 10, msg.slice(0, 80));
      }
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
  const token = authHeader.slice(7);
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
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
// ROUTES
// ============================================
app.get('/ping', (req, res) => res.status(200).send('OK 🚀'));

// AUTH
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
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

// CONVERSATIONS
app.get('/api/conversations', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .eq('user_id', req.user.id)
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversations: data || [] });
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  const { title } = req.body;
  const { data, error } = await supabase
    .from('conversations')
    .insert([{ title: title || 'محادثة جديدة', user_id: req.user.id }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversation: data });
});

app.put('/api/conversations/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required.' });

  const { error } = await supabase
    .from('conversations')
    .update({ title: title.trim(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  await supabase.from('messages').delete().eq('conversation_id', id);
  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('id', id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// MESSAGES
app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', req.user.id)
    .single();
  if (!conv) return res.status(404).json({ error: 'Not found.' });

  const { data, error } = await supabase
    .from('messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data || [] });
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Message required.' });
  }

  const { data: conv } = await supabase
    .from('conversations')
    .select('id, title')
    .eq('id', id)
    .eq('user_id', req.user.id)
    .single();
  if (!conv) return res.status(404).json({ error: 'Not found.' });

  const { error: userErr } = await supabase
    .from('messages')
    .insert([{ conversation_id: id, role: 'user', content: content.trim() }]);
  if (userErr) return res.status(500).json({ error: userErr.message });

  // Load last 20 messages
  const { data: historyRaw } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', id)
    .order('created_at', { ascending: false })
    .limit(20);

  const history = (historyRaw || []).reverse();

  const contents = [];
  for (const m of history) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (contents.length > 0 && contents[contents.length - 1].role === role) continue;
    contents.push({ role, parts: [{ text: m.content || '' }] });
  }

  while (contents.length > 0 && contents[0].role === 'model') contents.shift();
  while (contents.length > 0 && contents[contents.length - 1].role === 'model') contents.pop();

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: content.trim() }] });
  }

  let aiText = '';
  try {
    aiText = await generateText(contents);
    if (!aiText) aiText = '⚠️ لم يتم استلام رد.';
  } catch (err) {
    console.error('Generate error:', err.message);
    if (err.message === 'ALL_KEYS_EXHAUSTED') {
      aiText = '⚠️ تم استهلاك جميع المفاتيح مؤقتاً. حاول بعد دقيقة.';
    } else if (err.message.startsWith('BAD_REQUEST')) {
      aiText = '⚠️ خطأ في صيغة الطلب. حاول مرة أخرى.';
    } else if (err.message.startsWith('GENERATION_FAILED')) {
      aiText = '⚠️ حدث خطأ في التوليد. حاول مرة أخرى.';
    } else {
      aiText = '⚠️ حدث خطأ. حاول لاحقاً.';
    }
  }

  const { data: aiMsg } = await supabase
    .from('messages')
    .insert([{ conversation_id: id, role: 'assistant', content: aiText }])
    .select()
    .single();

  const updates = { updated_at: new Date().toISOString() };
  if (conv.title === 'محادثة جديدة' || conv.title === 'New Chat') {
    updates.title = content.trim().slice(0, 40);
  }
  await supabase.from('conversations').update(updates).eq('id', id);

  res.json({ aiMessage: aiMsg || { role: 'assistant', content: aiText } });
});

// KEYS STATUS
app.get('/api/keys-status', requireAuth, (req, res) => {
  const now = Date.now();
  res.json({
    total: keyStates.length,
    model: MODEL,
    status: keyStates.map(k => ({
      index: k.idx + 1,
      available: k.exhaustedUntil <= now,
      cooldownSec: Math.max(0, Math.ceil((k.exhaustedUntil - now) / 1000)),
      success: k.successCount,
      fail: k.failCount,
      lastError: k.lastError ? k.lastError.slice(0, 100) : '',
    })),
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// SELF-PING
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || '';

if (SELF_URL) {
  console.log(`🔁 Self-ping enabled: ${SELF_URL}/ping every 10 minutes`);
  setInterval(() => {
    fetch(`${SELF_URL}/ping`)
      .then(r => console.log(`💓 Self-ping OK (${r.status})`))
      .catch(e => console.warn('Self-ping failed:', e.message));
  }, 10 * 60 * 1000);
} else {
  console.log('ℹ️ Self-ping disabled.');
}

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔑 Keys loaded: ${keyStates.length}`);
  console.log(`📦 Model: ${MODEL}`);
});
