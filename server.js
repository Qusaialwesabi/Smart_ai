require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cookieParser = require('cookie-parser');
const path = require('path');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
const supabaseServiceKey = (process.env.SUPABASE_SERVICE_KEY || '').trim();

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Gemini Keys Setup
const rawKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').trim();
const GEMINI_KEYS = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
for (let i = 1; i <= 500; i++) {
  const k = (process.env['GEMINI_API_KEY_' + i] || '').trim();
  if (k) GEMINI_KEYS.push(k);
}

const MODEL = 'gemini-3.5-flash-lite';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GEMINI_PATH = `/v1beta/models/${MODEL}:generateContent`;

console.log(`✅ Loaded ${GEMINI_KEYS.length} Gemini key(s). Model: ${MODEL}`);

const keyStates = GEMINI_KEYS.map((key, idx) => ({
  key, idx, exhaustedUntil: 0, successCount: 0, failCount: 0, lastUsed: 0,
}));

function pickKey() {
  const now = Date.now();
  const available = keyStates.filter(k => k.exhaustedUntil <= now);
  if (available.length === 0) return null;
  available.sort((a, b) => a.lastUsed - b.lastUsed);
  return available[0];
}

async function callGemini(contents, endpoint = GEMINI_PATH, retries = 2) {
  if (GEMINI_KEYS.length === 0) throw new Error('No API keys.');
  const maxAttempts = GEMINI_KEYS.length + retries;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const state = pickKey();
    if (!state) throw new Error('All keys exhausted.');
    state.lastUsed = Date.now();
    try {
      const payload = {
        contents,
        systemInstruction: {
          parts: [{ text: "أنت مساعد برمجي محترف. عند إرجاع أكواد برمجية (مثل HTML, CSS, JavaScript)، قم دائماً بتغليف الأكواد داخل علامات تنصيص الأكواد المظلمة ```language ... ``` ولا تقم باختصار الأكواد أبداً." }]
        },
        generationConfig: {
          maxOutputTokens: 8192,
        }
      };

      const res = await fetch(`${GEMINI_BASE}${endpoint}?key=${state.key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        state.exhaustedUntil = Date.now() + 60000;
        continue;
      }
      if (!res.ok) { state.failCount++; continue; }
      const data = await res.json();
      state.successCount++;
      return data;
    } catch (e) {
      state.exhaustedUntil = Date.now() + 10000;
      continue;
    }
  }
  throw new Error('All attempts failed.');
}

function extractText(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').filter(Boolean).join('\n').trim();
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function getAccessToken(req) {
  if (req.cookies?.sb_access_token) return req.cookies.sb_access_token;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

async function getAuthenticatedUser(req) {
  const token = getAccessToken(req);
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch { return null; }
}

async function requireAuth(req, res, next) {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 };

// --- Authentication Routes ---
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return res.status(400).json({ error: error.message });
    const { data: signInData } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    res.cookie('sb_access_token', signInData.session.access_token, COOKIE_OPTS);
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: 'Invalid credentials' });
    res.cookie('sb_access_token', data.session.access_token, COOKIE_OPTS);
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// --- Conversation & Messaging Routes ---
app.get('/api/conversations', requireAuth, async (req, res) => {
  const { data } = await supabaseAdmin.from('conversations').select('*').eq('user_id', req.user.id).order('updated_at', { ascending: false });
  res.json({ conversations: data || [] });
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  const { data } = await supabaseAdmin.from('conversations').insert({ user_id: req.user.id, title: req.body.title || 'محادثة جديدة' }).select().single();
  res.json({ conversation: data });
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const { data } = await supabaseAdmin.from('messages').select('*').eq('conversation_id', req.params.id).order('created_at', { ascending: true });
  res.json({ messages: data || [] });
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    
    const { data: userMsg } = await supabaseAdmin.from('messages').insert({ conversation_id: id, role: 'user', content }).select().single();
    
    const { data: history } = await supabaseAdmin.from('messages').select('role, content').eq('conversation_id', id).order('created_at', { ascending: true }).limit(20);
    const geminiContents = (history || []).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }]
    }));

    const response = await callGemini(geminiContents);
    const aiText = extractText(response) || '⚠️ لم يتم استلام رد.';

    const { data: aiMsg } = await supabaseAdmin.from('messages').insert({ conversation_id: id, role: 'assistant', content: aiText }).select().single();
    
    res.json({ userMessage: userMsg, aiMessage: aiMsg });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Image Route via Free Open Engine ---
app.post('/api/generate-image', requireAuth, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: 'الوصف مطلوب' });

    let englishPrompt = prompt;
    try {
      const translationRes = await callGemini([{ role: 'user', parts: [{ text: `Translate to English: "${prompt}". Output only translation.` }] }]);
      const translated = extractText(translationRes);
      if (translated) englishPrompt = translated;
    } catch (_) {}

    const cleanPrompt = encodeURIComponent(englishPrompt.trim());
    const imageUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1000000)}`;

    const imageRes = await fetch(imageUrl);
    const arrayBuffer = await imageRes.arrayBuffer();
    const b64 = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = imageRes.headers.get('content-type') || 'image/jpeg';

    res.json({ success: true, image: { mimeType, data: b64 } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'تعذر توليد الصورة' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Smart AI running on ${PORT}`));
