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

// ============================================
// SUPABASE
// ============================================
const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
const supabaseServiceKey = (process.env.SUPABASE_SERVICE_KEY || '').trim();

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️  SUPABASE_URL or SUPABASE_ANON_KEY not set.');
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ============================================
// GEMINI KEY POOL (Unlimited Keys)
// ============================================
const rawKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').trim();
const GEMINI_KEYS = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

// Support numbered keys: GEMINI_API_KEY_1, GEMINI_API_KEY_2, ...
for (let i = 1; i <= 500; i++) {
  const k = (process.env['GEMINI_API_KEY_' + i] || '').trim();
  if (k) GEMINI_KEYS.push(k);
}

const MODEL = 'gemini-3.5-flash-lite';
const IMAGE_MODEL = 'gemini-2.5-flash-image';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GEMINI_PATH = `/v1beta/models/${MODEL}:generateContent`;
const IMAGE_PATH = `/v1beta/models/${IMAGE_MODEL}:generateContent`;

if (GEMINI_KEYS.length === 0) {
  console.warn('⚠️  No Gemini API keys found.');
} else {
  console.log(`✅ Loaded ${GEMINI_KEYS.length} Gemini API key(s).`);
}

// Key state tracking
const keyStates = GEMINI_KEYS.map((key, idx) => ({
  key, idx,
  exhaustedUntil: 0,
  successCount: 0,
  failCount: 0,
  lastUsed: 0,
}));

function pickKey() {
  const now = Date.now();
  const available = keyStates.filter(k => k.exhaustedUntil <= now);
  if (available.length === 0) return null;
  available.sort((a, b) => a.lastUsed - b.lastUsed);
  return available[0];
}

async function callGemini(contents, endpoint = GEMINI_PATH, retries = 2) {
  if (GEMINI_KEYS.length === 0) throw new Error('No API keys configured.');

  const maxAttempts = GEMINI_KEYS.length + retries;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const state = pickKey();
    if (!state) {
      const soonest = Math.min(...keyStates.map(k => k.exhaustedUntil));
      const waitSec = Math.max(1, Math.ceil((soonest - Date.now()) / 1000));
      throw new Error(`All keys exhausted. Retry in ~${waitSec}s.`);
    }

    state.lastUsed = Date.now();
    const url = `${GEMINI_BASE}${endpoint}?key=${state.key}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
      });

      if (res.status === 429) {
        const body = await res.text();
        let retrySec = 60;
        try {
          const j = JSON.parse(body);
          const retryInfo = (j.error?.details || []).find(d => d['@type']?.includes('RetryInfo'));
          if (retryInfo?.retryDelay) {
            const m = String(retryInfo.retryDelay).match(/(\d+)/);
            if (m) retrySec = parseInt(m[1], 10) + 5;
          }
        } catch (_) {}
        state.exhaustedUntil = Date.now() + retrySec * 1000;
        state.failCount++;
        console.warn(`🔴 Key #${state.idx + 1} quota reached. Cooldown ${retrySec}s.`);
        continue;
      }

      if (res.status === 503 || res.status === 500) {
        state.exhaustedUntil = Date.now() + 15 * 1000;
        state.failCount++;
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        console.error(`Gemini error (key #${state.idx + 1}, ${res.status}):`, errText.slice(0, 200));
        state.failCount++;
        continue;
      }

      const data = await res.json();
      state.successCount++;
      return data;
    } catch (err) {
      state.exhaustedUntil = Date.now() + 10 * 1000;
      state.failCount++;
      continue;
    }
  }

  throw new Error('All attempts failed.');
}

function extractText(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').filter(Boolean).join('\n').trim();
}

// ============================================
// GEMINI FILE API (for uploads)
// ============================================
function pickFileKey() {
  const now = Date.now();
  const available = keyStates.filter(k => k.exhaustedUntil <= now);
  if (available.length === 0) return null;
  return available[0];
}

async function uploadToGemini(buffer, mimeType, displayName) {
  const state = pickFileKey();
  if (!state) throw new Error('No API keys available for upload.');

  const startUrl = `${GEMINI_BASE}/upload/v1beta/files?key=${state.key}`;

  const startRes = await fetch(startUrl, {
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

  if (!startRes.ok) {
    const err = await startRes.text();
    console.error('File start error:', err.slice(0, 300));
    throw new Error('Failed to start file upload');
  }

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

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    console.error('File upload error:', err.slice(0, 300));
    throw new Error('Failed to upload file');
  }

  const fileInfo = await uploadRes.json();
  return fileInfo.file;
}

async function waitForFileActive(fileName, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const state = pickFileKey();
    if (!state) throw new Error('No keys available');
    const res = await fetch(`${GEMINI_BASE}/v1beta/${fileName}?key=${state.key}`);
    if (res.ok) {
      const data = await res.json();
      if (data.state === 'ACTIVE') return data;
      if (data.state === 'FAILED') throw new Error('File processing failed');
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('File processing timeout');
}

function getMimeCategory(mimeType) {
  if (!mimeType) return 'unknown';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('pdf')) return 'pdf';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'document';
  if (mimeType.includes('text') || mimeType.includes('json') || mimeType.includes('csv')) return 'text';
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return 'spreadsheet';
  return 'other';
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ============================================
// AUTH HELPERS
// ============================================
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

// ============================================
// AUTH ROUTES
// ============================================
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

    res.cookie('sb_access_token', signInData.session.access_token, {
      httpOnly: true, secure: true, sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: 'Invalid email or password.' });

    res.cookie('sb_access_token', data.session.access_token, {
      httpOnly: true, secure: true, sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { access_token, refresh_token } = req.body;
    if (!access_token) return res.status(400).json({ error: 'Access token required.' });

    const { data, error } = await supabaseAdmin.auth.setSession({ access_token, refresh_token });
    if (error || !data.session) return res.status(400).json({ error: 'Invalid Google session.' });

    res.cookie('sb_access_token', data.session.access_token, {
      httpOnly: true, secure: true, sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sb_access_token', { sameSite: 'none', secure: true });
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// ============================================
// FILE UPLOAD
// ============================================
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    const { buffer, mimetype, originalname, size } = req.file;

    if (size > 100 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large. Max 100MB.' });
    }

    const category = getMimeCategory(mimetype);
    console.log(`📤 Uploading: ${originalname} (${mimetype}, ${(size/1024/1024).toFixed(2)}MB)`);

    const fileInfo = await uploadToGemini(buffer, mimetype, originalname);
    const activeFile = await waitForFileActive(fileInfo.name);

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
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Failed to upload file. Please try again.' });
  }
});

// ============================================
// IMAGE GENERATION
// ============================================
app.post('/api/generate-image', requireAuth, async (req, res) => {
  try {
    const { prompt, baseImage } = req.body;

    if (!prompt?.trim() && !baseImage) {
      return res.status(400).json({ error: 'Prompt required.' });
    }

    const parts = [];
    if (baseImage?.data && baseImage?.mimeType) {
      parts.push({
        inlineData: { mimeType: baseImage.mimeType, data: baseImage.data },
      });
    }
    if (prompt?.trim()) parts.push({ text: prompt.trim() });

    console.log(`🎨 Generating image: "${prompt?.slice(0, 60)}..."`);

    const data = await callGemini([{ parts }], IMAGE_PATH);
    const responseParts = data.candidates?.[0]?.content?.parts || [];

    const imagePart = responseParts.find(p => p.inlineData);
    const textPart = responseParts.find(p => p.text);

    if (!imagePart) {
      return res.status(500).json({
        error: textPart?.text || 'لم يتم توليد صورة.',
      });
    }

    res.json({
      success: true,
      image: {
        mimeType: imagePart.inlineData.mimeType,
        data: imagePart.inlineData.data,
      },
      text: textPart?.text || '',
    });
  } catch (err) {
    console.error('Image gen error:', err.message);
    if (err.message.includes('exhausted')) {
      return res.status(429).json({ error: 'تم استهلاك الحد اليومي. حاول لاحقاً.' });
    }
    res.status(500).json({ error: 'فشل توليد الصورة. حاول لاحقاً.' });
  }
});

// ============================================
// CONVERSATIONS
// ============================================
app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .select('id, title, created_at, updated_at')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversations: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { title } = req.body;
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .insert({ user_id: req.user.id, title: title || 'New Chat' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversation: data });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.patch('/api/conversations/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title required.' });
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .update({ title: title.trim(), updated_at: new Date().toISOString() })
      .eq('id', id).eq('user_id', req.user.id)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversation: data });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin
      .from('conversations')
      .delete().eq('id', id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ============================================
// MESSAGES
// ============================================
app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations').select('id')
      .eq('id', id).eq('user_id', req.user.id).single();
    if (convErr || !conv) return res.status(404).json({ error: 'Conversation not found.' });

    const { data, error } = await supabaseAdmin
      .from('messages')
      .select('id, role, content, created_at, attachment, image_url')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { content, attachment } = req.body;

    if ((!content || !content.trim()) && !attachment) {
      return res.status(400).json({ error: 'Message or attachment required.' });
    }

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('id, title')
      .eq('id', id).eq('user_id', req.user.id).single();
    if (convErr || !conv) return res.status(404).json({ error: 'Conversation not found.' });

    const userMsgContent = (content || '').trim();
    const { data: userMsg, error: userErr } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: id,
        role: 'user',
        content: userMsgContent,
        attachment: attachment || null,
      })
      .select().single();
    if (userErr) return res.status(500).json({ error: userErr.message });

    // Load history
    const { data: history } = await supabaseAdmin
      .from('messages')
      .select('role, content, attachment')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(20);

    // Build Gemini contents
    const geminiContents = (history || []).map(m => {
      const parts = [];

      if (m.attachment?.uri && m.attachment?.mimeType) {
        parts.push({
          fileData: { fileUri: m.attachment.uri, mimeType: m.attachment.mimeType },
        });
      }

      if (m.content) parts.push({ text: m.content });
      if (parts.length === 0) parts.push({ text: '(empty)' });

      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });

    let aiText = '';
    try {
      const response = await callGemini(geminiContents);
      aiText = extractText(response);
      if (!aiText) aiText = '⚠️ لم يتم استلام رد. حاول مرة أخرى.';
    } catch (e) {
      console.error('Gemini error:', e.message);
      if (e.message.includes('exhausted')) {
        aiText = '⚠️ تم استهلاك الحد اليومي. حاول لاحقاً.';
      } else {
        aiText = '⚠️ حدث خطأ مؤقت. حاول مرة أخرى.';
      }
    }

    const { data: aiMsg, error: aiErr } = await supabaseAdmin
      .from('messages')
      .insert({ conversation_id: id, role: 'assistant', content: aiText })
      .select().single();
    if (aiErr) return res.status(500).json({ error: aiErr.message });

    const updates = { updated_at: new Date().toISOString() };
    if (conv.title === 'New Chat') {
      if (userMsgContent) {
        updates.title = userMsgContent.slice(0, 40) + (userMsgContent.length > 40 ? '...' : '');
      } else if (attachment?.displayName) {
        updates.title = attachment.displayName.slice(0, 40);
      }
    }
    await supabaseAdmin.from('conversations').update(updates).eq('id', id);

    res.json({
      userMessage: userMsg,
      aiMessage: aiMsg,
      conversationTitle: updates.title || conv.title,
    });
  } catch (err) {
    console.error('Send message error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ============================================
// KEYS STATUS
// ============================================
app.get('/api/keys-status', requireAuth, (req, res) => {
  const now = Date.now();
  const status = keyStates.map(k => ({
    index: k.idx + 1,
    available: k.exhaustedUntil <= now,
    cooldownSec: Math.max(0, Math.ceil((k.exhaustedUntil - now) / 1000)),
    successCount: k.successCount,
    failCount: k.failCount,
  }));
  res.json({ totalKeys: GEMINI_KEYS.length, status });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Smart AI running on http://localhost:${PORT}`);
  console.log(`🔑 Gemini keys loaded: ${GEMINI_KEYS.length}`);
  console.log(`📦 Model: ${MODEL} | Image: ${IMAGE_MODEL}`);
});
