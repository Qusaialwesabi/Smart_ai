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

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '').trim();
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

if (!supabase) console.warn('⚠️ Supabase not configured.');

// Keys
const apiKeys = (process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
for (let i = 1; i <= 100; i++) {
  const k = (process.env['GEMINI_API_KEY_' + i] || '').trim();
  if (k) apiKeys.push(k);
}
const uniqueKeys = [...new Set(apiKeys)];

const keyStates = uniqueKeys.map((key, idx) => ({
  key, idx, exhaustedUntil: 0, lastUsed: 0, successCount: 0, failCount: 0, lastError: '',
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
  return m.includes('429') || m.includes('quota') || m.includes('rate') || m.includes('resource_exhausted');
}

function isOverloaded(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('503') || m.includes('high demand') || m.includes('overloaded') || m.includes('unavailable');
}

const MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-2.5-flash-lite';
const MODELS = [MODEL, FALLBACK_MODEL];

async function generateText(contents) {
  if (keyStates.length === 0) throw new Error('No API keys.');

  let lastError = '';

  for (const modelName of MODELS) {
    for (let round = 0; round < 3; round++) {
      for (let k = 0; k < keyStates.length; k++) {
        const state = pickKey();
        if (!state) {
          if (round < 2) {
            console.log(`⏳ All keys cooling — waiting 5s (round ${round + 1}/3)...`);
            await new Promise(r => setTimeout(r, 5000));
            break;
          }
          continue;
        }

        state.lastUsed = Date.now();
        try {
          const ai = new GoogleGenAI({ apiKey: state.key });
          const response = await ai.models.generateContent({ model: modelName, contents });
          state.successCount++;
          console.log(`✅ Key #${state.idx + 1} (${modelName}) succeeded (total: ${state.successCount})`);
          return response.text || '';
        } catch (err) {
          const msg = String(err.message || '');
          console.error(`❌ Key #${state.idx + 1} (${modelName}):`, msg.slice(0, 150));
          lastError = msg;

          if (msg.includes('404') || msg.includes('not found')) break;
          if (isQuotaError(msg)) coolDown(state, 60, 'quota');
          else if (isOverloaded(msg)) coolDown(state, 5, 'google busy');
          else if (msg.includes('400') || msg.includes('invalid')) throw new Error('BAD_REQUEST: ' + msg.slice(0, 200));
          else coolDown(state, 8, msg.slice(0, 60));
        }
      }
      if (round < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }

  throw new Error('GENERATION_FAILED: ' + lastError);
}

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

app.get('/ping', (req, res) => res.status(200).send('OK 🚀'));

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
    if (contents.length > 0 && contents[contents.length - 1].role === role) continue;
    contents.push({ role, parts: [{ text: m.content || '' }] });
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
    if (err.message === 'ALL_KEYS_EXHAUSTED') aiText = '⚠️ السيرفر مزدحم. حاول بعد ثوانٍ.';
    else if (err.message.startsWith('BAD_REQUEST')) aiText = '⚠️ خطأ في صيغة الطلب.';
    else if (err.message.startsWith('GENERATION_FAILED')) aiText = '⚠️ Google مزدحمة حالياً. حاول بعد قليل.';
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

  res.json({ aiMessage: aiMsg || { role: 'assistant', content: aiText } });
});

app.get('/api/keys-status', requireAuth, (req, res) => {
  const now = Date.now();
  res.json({
    total: keyStates.length,
    models: MODELS,
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
    fetch(`${SELF_URL}/ping`).then(r => console.log(`💓 Self-ping OK (${r.status})`)).catch(e => console.warn('Self-ping failed:', e.message));
  }, 10 * 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`🔑 Keys: ${keyStates.length}`);
  console.log(`📦 Models: ${MODELS.join(' → ')}`);
});
