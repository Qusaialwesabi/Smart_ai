require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// إعداد Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// إعداد Gemini API Keys ومعالجة الدوران
const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
let currentKeyIndex = 0;

function getAiClient() {
    if (apiKeys.length === 0) throw new Error("مفاتيح Gemini غير متوفرة");
    return new GoogleGenerativeAI(apiKeys[currentKeyIndex].trim());
}

// مسار فحص Uptime لضمان بقاء السيرفر نشطاً
app.get('/ping', (req, res) => res.status(200).send('Operational 🚀'));

// 1. مسارات المصادقة (Auth)
app.get('/api/auth/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !supabase) return res.status(401).json({ error: "غير مصرح" });

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) return res.status(401).json({ error: "جلسة غير صالحة" });
    res.json({ user });
});

app.post('/api/auth/signup', async (req, res) => {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ error: "إعدادات Supabase مفقودة بالسيرفر" });

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ error: "إعدادات Supabase مفقودة بالسيرفر" });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

// 2. مسارات المحادثات (Conversations)
app.get('/api/conversations', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !supabase) return res.json({ conversations: [] });

    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "غير مصرح" });

    const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversations: data || [] });
});

app.post('/api/conversations', async (req, res) => {
    const authHeader = req.headers.authorization;
    const { title } = req.body;
    if (!authHeader || !supabase) return res.status(401).json({ error: "غير مصرح" });

    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "غير مصرح" });

    const { data, error } = await supabase
        .from('conversations')
        .insert([{ title: title || 'محادثة جديدة', user_id: user.id }])
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversation: data });
});

app.put('/api/conversations/:id', async (req, res) => {
    const { id } = req.params;
    const { title } = req.body;
    if (!supabase) return res.status(500).json({ error: "إعدادات Supabase مفقودة" });

    const { error } = await supabase
        .from('conversations')
        .update({ title })
        .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

app.delete('/api/conversations/:id', async (req, res) => {
    const { id } = req.params;
    if (!supabase) return res.status(500).json({ error: "إعدادات Supabase مفقودة" });

    await supabase.from('messages').delete().eq('conversation_id', id);
    const { error } = await supabase.from('conversations').delete().eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// 3. مسارات الرسائل والتفاعل مع النموذج gemini-3.5-flash-lite
app.get('/api/conversations/:id/messages', async (req, res) => {
    const { id } = req.params;
    if (!supabase) return res.json({ messages: [] });

    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', id)
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data || [] });
});

app.post('/api/conversations/:id/messages', async (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: "المحتوى مطلوب" });

    if (supabase) {
        await supabase.from('messages').insert([{ conversation_id: id, role: 'user', content }]);
    }

    let attempts = 0;
    let aiText = "";

    while (attempts < Math.max(apiKeys.length, 1)) {
        try {
            const genAI = getAiClient();
            // استخدام نموذج gemini-3.5-flash-lite
            const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });
            const result = await model.generateContent(content);
            const response = await result.response;
            aiText = response.text();
            break;
        } catch (error) {
            console.error(`خطأ بالمفتاح رقم ${currentKeyIndex}:`, error.message);
            if (apiKeys.length > 1) {
                currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            }
            attempts++;
        }
    }

    if (!aiText) return res.status(500).json({ error: "تعذر توليد الإجابة، تأكد من صحة المفاتيح." });

    let aiMessage = { content: aiText, role: 'assistant' };
    if (supabase) {
        const { data } = await supabase
            .from('messages')
            .insert([{ conversation_id: id, role: 'assistant', content: aiText }])
            .select()
            .single();
        if (data) aiMessage = data;
    }

    res.json({ aiMessage });
});

app.listen(PORT, () => {
    console.log(`✅ السيرفر يعمل على المنفذ ${PORT}`);
    console.log(`🔑 عدد المفاتيح المجهزة للدوران: ${apiKeys.length}`);
    const serverUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;
    setInterval(() => {
        fetch(`${serverUrl}/ping`).catch(() => {});
    }, 10 * 60 * 1000);
});
