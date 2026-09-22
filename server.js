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

// Gemini Keys Configuration
const rawKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').trim();
const GEMINI_KEYS = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
for (let i = 1; i <= 500; i++) {
  const k = (process.env['GEMINI_API_KEY_' + i] || '').trim();
  if (k) GEMINI_KEYS.push(k);
}

// نموذج الدردشة والنصوص
const MODEL = 'gemini-3.5-flash-lite';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GEMINI_PATH = `/v1beta/models/${MODEL}:generateContent`;

console.log(`✅ Loaded ${GEMINI_KEYS.length} Gemini key(s). Using model: ${MODEL}`);

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
      const res = await fetch(`${GEMINI_BASE}${endpoint}?key=${state.key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
      });
      if (res.status === 429) {
        const body = await res.text();
        let retrySec = 60;
        try {
          const j = JSON.parse(body);
          const ri = (j.error?.details || []).find(d => d['@type']?.includes('RetryInfo'));
          if (ri?.retryDelay) {
            const m = String(ri.retryDelay).match(/(\d+)/);
            if (m) retrySec = parseInt(m[1]) + 5;
          }
        } catch (_) {}
        state.exhaustedUntil = Date.now() + retrySec * 1000;
        continue;
      }
      if (res.status === 503 || res.status === 500) {
        state.exhaustedUntil = Date.now() + 15000;
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

// File upload to Gemini
async function uploadToGemini(buffer, mimeType, displayName) {
  const state = pickKey();
  if (!state) throw new Error('No keys.');
  const startRes = await fetch(`${GEMINI_BASE}/upload/v1beta/files?key=${state.key}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': buffer.length.toString(),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName || 'upload' } }),
  });
  if (!startRes.ok) throw new Error('Start upload failed.');
  const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('No upload URL');
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': buffer.length.toString(),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error('Upload failed');
  const fi = await uploadRes.json();
  return fi.file;
}

async function waitForFileActive(fileName, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const state = pickKey();
    if (!state) throw new Error('No keys.');
    const res = await fetch(`${GEMINI_BASE}/v1beta/${fileName}?key=${state.key}`);
    if (res.ok) {
      const data = await res.json();
      if (data.state === 'ACTIVE') return data;
      if (data.state === 'FAILED') throw new Error('Processing failed');
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timeout');
}

function getMimeCategory(mt) {
  if (!mt) return 'unknown';
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.includes('pdf')) return 'pdf';
  if (mt.includes('word') || mt.includes('document')) return 'document';
  if (mt.includes('text') || mt.includes('json') || mt.includes('csv')) return 'text';
  if (mt.includes('sheet') || mt.includes('excel')) return 'spreadsheet';
  return 'other';
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, 
});

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

const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// --- Auth Routes ---
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (error) return res.status(400).json({ error: error.message });

    const { data: signInData, error: signInError } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (signInError) return res.status(400).json({ error: signInError.message });

    res.cookie('sb_access_token', signInData.session.access_token, COOKIE_OPTS);
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: 'Invalid email or password.' });

    res.cookie('sb_access_token', data.session.access_token, COOKIE_OPTS);
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sb_access_token', { sameSite: 'lax', secure: true });
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// --- Upload Route ---
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم استلام ملف.' });
    const { buffer, mimetype, originalname, size } = req.file;
    
    console.log(`جارٍ رفع ملف: ${originalname} بحجم ${Math.round(size/1024)}KB`);

    const category = getMimeCategory(mimetype);
    const fileInfo = await uploadToGemini(buffer, mimetype, originalname);
    const activeFile = await waitForFileActive(fileInfo.name, 30000); 

    console.log(`تم الرفع بنجاح: ${activeFile.name}`);
    res.json({
      success: true,
      file: {
        name: activeFile.name,
        uri: activeFile.uri,
        mimeType: activeFile.mimeType,
        sizeBytes: activeFile.sizeBytes,
        displayName: originalname,
        category,
      },
    });
  } catch (err) {
    console.error("خطأ في رفع الملف:", err.message);
    res.status(500).json({ error: 'فشل الرفع. قد يكون الملف معقداً أو الخادم مشغول.' });
  }
});

// --- Conversations Routes ---
app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .select('id, title, created_at, updated_at')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversations: data || [] });
  } catch (err) { res.status(500).json({ error: 'Error.' }); }
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { title } = req.body;
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .insert({ user_id: req.user.id, title: title || 'محادثة جديدة' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversation: data });
  } catch (err) { res.status(500).json({ error: 'Error.' }); }
});

app.patch('/api/conversations/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;
    const { error } = await supabaseAdmin
      .from('conversations')
      .update({ title })
      .eq('id', id)
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error.' }); }
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin
      .from('conversations')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error.' }); }
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations').select('id').eq('id', id).eq('user_id', req.user.id).single();
    if (convErr || !conv) return res.status(404).json({ error: 'Not found.' });

    const { data, error } = await supabaseAdmin
      .from('messages')
      .select('id, role, content, created_at, attachment, image_url')
      .eq('conversation_id', id).order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data || [] });
  } catch (err) { res.status(500).json({ error: 'Error.' }); }
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { content, attachment } = req.body;
    if ((!content || !content.trim()) && !attachment) return res.status(400).json({ error: 'Message required.' });

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations').select('id, title')
      .eq('id', id).eq('user_id', req.user.id).single();
    if (convErr || !conv) return res.status(404).json({ error: 'Not found.' });

    const userMsgContent = (content || '').trim();
    const { data: userMsg, error: userErr } = await supabaseAdmin
      .from('messages')
      .insert({ conversation_id: id, role: 'user', content: userMsgContent, attachment: attachment || null })
      .select().single();
    if (userErr) return res.status(500).json({ error: userErr.message });

    const { data: history } = await supabaseAdmin
      .from('messages').select('role, content, attachment')
      .eq('conversation_id', id).order('created_at', { ascending: true }).limit(20);

    const geminiContents = (history || []).map(m => {
      const parts = [];
      if (m.attachment?.uri && m.attachment?.mimeType) {
        parts.push({ fileData: { fileUri: m.attachment.uri, mimeType: m.attachment.mimeType } });
      }
      if (m.content) parts.push({ text: m.content });
      if (parts.length === 0) parts.push({ text: '(empty)' });
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    let aiText = '';
    try {
      const response = await callGemini(geminiContents);
      aiText = extractText(response) || '⚠️ لم يتم استلام رد.';
    } catch (e) {
      aiText = '⚠️ حدث خطأ. حاول لاحقاً.';
    }

    const { data: aiMsg, error: aiErr } = await supabaseAdmin
      .from('messages')
      .insert({ conversation_id: id, role: 'assistant', content: aiText })
      .select().single();
    if (aiErr) return res.status(500).json({ error: aiErr.message });

    res.json({ userMessage: userMsg, aiMessage: aiMsg });
  } catch (err) {
    res.status(500).json({ error: 'Error.' });
  }
});

// --- Generate Image Route (Fixed using Nano Banana / Flash Image model endpoint) ---
app.post('/api/generate-image', requireAuth, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: 'يجب كتابة وصف للصورة' });

    // استخدام النموذج المخصص لتوليد الصور عبر الـ API
    const imageModel = 'gemini-2.5-flash-image';
    const response = await callGemini([
      { role: 'user', parts: [{ text: prompt }] }
    ], `/v1beta/models/${imageModel}:generateContent`);

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    
    let imagePart = parts.find(p => p.inlineData || p.inline_data || p.fileData);

    if (!imagePart) {
      throw new Error('لم يتم إرجاع بيانات الصورة من الخادم.');
    }

    const dataObj = imagePart.inlineData || imagePart.inline_data;
    const mimeType = dataObj?.mimeType || 'image/png';
    const b64 = dataObj?.data;

    if (!b64) throw new Error('محتوى الصورة فارغ');

    res.json({ success: true, image: { mimeType, data: b64 } });
  } catch (err) {
    console.error("Image Generation Error:", err.message);
    res.status(500).json({ success: false, error: 'تعذر توليد الصورة حالياً. تأكد من دعم المفتاح.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Smart AI running on ${PORT}`);
  console.log(`🔑 Keys: ${GEMINI_KEYS.length} | Model: ${MODEL}`);
});
