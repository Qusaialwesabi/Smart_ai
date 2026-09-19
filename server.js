require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cookieParser = require('cookie-parser');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Supabase Setup ---
const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
const supabaseServiceKey = (process.env.SUPABASE_SERVICE_KEY || '').trim();

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Warning: SUPABASE_URL or SUPABASE_ANON_KEY is not set.');
}
if (!process.env.GEMINI_API_KEY) {
  console.warn('Warning: GEMINI_API_KEY is not set.');
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// --- Security & Performance Middleware ---
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for simplicity with CDN scripts
}));
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- Gemini API with Retry Logic ---
const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const MODEL = 'gemini-3.5-flash-lite'; // الأسرع والأكثر استقراراً
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

async function callGemini(messages, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: messages }),
      });

      if (!res.ok) {
        const errText = await res.text();
        // If it's a rate limit (429), don't retry, just throw
        if (res.status === 429) throw new Error('rate_limit');
        console.error(`Gemini API error (attempt ${i + 1}):`, errText);
        throw new Error('api_error');
      }

      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p.text || '').join('\n').trim();

      if (text) return text;

      // If text is empty, wait and retry
      console.warn(`Empty response from Gemini (attempt ${i + 1}). Retrying...`);
      if (i < retries) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
      
    } catch (err) {
      if (err.message === 'rate_limit') throw err; // Don't retry on rate limit
      console.error(`Attempt ${i + 1} failed:`, err.message);
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error('Max retries reached with empty response.');
}

// --- Auth Helpers ---
function getAccessToken(req) {
  if (req.cookies && req.cookies.sb_access_token) return req.cookies.sb_access_token;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

async function getAuthenticatedUser(req) {
  const token = getAccessToken(req);
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch (e) {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

// ============================
// AUTH ROUTES
// ============================

// Email/Password Signup
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

// Email/Password Login
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

// Google OAuth Login
app.post('/api/auth/google', async (req, res) => {
  try {
    const { access_token, refresh_token } = req.body;
    if (!access_token) return res.status(400).json({ error: 'Access token required.' });

    const { data, error } = await supabaseAdmin.auth.setSession({
      access_token,
      refresh_token,
    });

    if (error || !data.session) {
      return res.status(400).json({ error: 'Invalid Google session.' });
    }

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

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sb_access_token', { sameSite: 'none', secure: true });
  res.json({ success: true });
});

// Current User
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// ============================
// CONVERSATIONS ROUTES
// ============================
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
    console.error('List conversations error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { title } = req.body;
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .insert({ user_id: req.user.id, title: title || 'New Chat' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversation: data });
  } catch (err) {
    console.error('Create conversation error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.patch('/api/conversations/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title required.' });

    const { data, error } = await supabaseAdmin
      .from('conversations')
      .update({ title: title.trim(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversation: data });
  } catch (err) {
    console.error('Rename conversation error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
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
  } catch (err) {
    console.error('Delete conversation error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations').select('id')
      .eq('id', id).eq('user_id', req.user.id).single();
    if (convErr || !conv) return res.status(404).json({ error: 'Conversation not found.' });

    const { data, error } = await supabaseAdmin
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data || [] });
  } catch (err) {
    console.error('List messages error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message required.' });

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('id, title')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();
    if (convErr || !conv) return res.status(404).json({ error: 'Conversation not found.' });

    const { data: userMsg, error: userErr } = await supabaseAdmin
      .from('messages')
      .insert({ conversation_id: id, role: 'user', content: content.trim() })
      .select()
      .single();
    if (userErr) return res.status(500).json({ error: userErr.message });

    const { data: history } = await supabaseAdmin
      .from('messages')
      .select('role, content')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(30);

    const geminiMessages = (history || []).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    let aiText = '';
    try {
      aiText = await callGemini(geminiMessages);
    } catch (e) {
      console.error('Gemini error:', e.message);
      if (e.message === 'rate_limit') {
        aiText = '⚠️ الحد اليومي للطلبات قد انتهى. حاول مرة أخرى لاحقاً.';
      } else {
        aiText = '⚠️ حدث خطأ مؤقت. حاول مرة أخرى.';
      }
    }

    const { data: aiMsg, error: aiErr } = await supabaseAdmin
      .from('messages')
      .insert({ conversation_id: id, role: 'assistant', content: aiText })
      .select()
      .single();
    if (aiErr) return res.status(500).json({ error: aiErr.message });

    const updates = { updated_at: new Date().toISOString() };
    if (conv.title === 'New Chat') {
      updates.title = content.trim().slice(0, 40) + (content.length > 40 ? '...' : '');
    }
    await supabaseAdmin.from('conversations').update(updates).eq('id', id);

    res.json({ userMessage: userMsg, aiMessage: aiMsg, conversationTitle: updates.title || conv.title });
  } catch (err) {
    console.error('Send message error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Smart AI running on http://localhost:${PORT}`);
  console.log(`🔑 Gemini API Key: ${API_KEY ? 'Loaded' : 'MISSING'}`);
});
