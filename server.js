require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🟢 إعداد Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// 🟢 إعداد مفاتيح Gemini
const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
let currentKeyIndex = 0;

function getAiClient() {
    if (apiKeys.length === 0) throw new Error("لم يتم العثور على مفاتيح API لـ Gemini");
    return new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
}

// متغيّر لتخزين جلسة المستخدم المؤقتة (أو يمكن الاعتماد على Supabase Auth)
let activeUser = null;

// 🟢 مسار منع النوم (Ping)
app.get('/ping', (req, res) => res.status(200).send('Server Awake 🚀'));

// 🔵 1. مسارات المصادقة (Auth Routes)
app.get('/api/auth/me', (req, res) => {
    if (activeUser) return res.json({ user: activeUser });
    res.status(401).json({ error: "غير مسجل الدخول" });
});

app.post('/api/auth/signup', async (req, res) => {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ error: "Supabase غير متصل" });
    
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    
    activeUser = data.user;
    res.json({ user: data.user });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ error: "Supabase غير متصل" });
    
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    
    activeUser = data.user;
    res.json({ user: data.user });
});

app.post('/api/auth/logout', async (req, res) => {
    if (supabase) await supabase.auth.signOut();
    activeUser = null;
    res.json({ success: true });
});

// 🟣 2. مسارات المحادثات (Conversations)
app.get('/api/conversations', async (req, res) => {
    if (!supabase || !activeUser) return res.json({ conversations: [] });
    
    const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('user_id', activeUser.id)
        .order('created_at', { ascending: false });
        
    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversations: data || [] });
});

app.post('/api/conversations', async (req, res) => {
    const { title } = req.body;
    if (!supabase || !activeUser) return res.status(401).json({ error: "غير مصرح" });

    const { data, error } = await supabase
        .from('conversations')
        .insert([{ title: title || 'محادثة جديدة', user_id: activeUser.id }])
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversation: data });
});

app.put('/api/conversations/:id', async (req, res) => {
    const { title } = req.body;
    const { id } = req.params;
    
    const { error } = await supabase
        .from('conversations')
        .update({ title })
        .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

app.delete('/api/conversations/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('conversations').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// 🟠 3. مسارات الرسائل والتفاعل مع Gemini
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

    // 1. حفظ رسالة المستخدم في Supabase
    if (supabase) {
        await supabase.from('messages').insert([{ conversation_id: id, role: 'user', content }]);
    }

    // 2. إرسال الطلب للذكاء الاصطناعي مع التبديل التلقائي بين المفاتيح الأربعة
    let attempts = 0;
    let aiText = "";

    while (attempts < apiKeys.length) {
        try {
            const ai = getAiClient();
            console.log(`[جاري التوليد] بالمفتاح رقم: ${currentKeyIndex + 1}`);

            const response = await ai.models.generateContent({
                model: 'gemini-3.5-flash-lite',
                contents: content,
            });

            aiText = response.text;
            break;
        } catch (error) {
            console.error(`[فشل المفتاح ${currentKeyIndex + 1}]:`, error.message);
            currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            attempts++;
        }
    }

    if (!aiText) {
        return res.status(500).json({ error: "فشل الاتصال بالذكاء الاصطناعي، جميع المفاتيح مستنفدة." });
    }

    // 3. حفظ إجابة الذكاء الاصطناعي في Supabase
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

// تشغيل السيرفر والـ Self-Ping
app.listen(PORT, () => {
    console.log(`✅ السيرفر يعمل على المنفذ ${PORT}`);
    const serverUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;

    setInterval(async () => {
        try {
            await fetch(`${serverUrl}/ping`);
            console.log(`[Keep-Alive] تمت الزيارة الذاتية في: ${new Date().toLocaleTimeString()}`);
        } catch (err) {
            console.error('[Keep-Alive] فشلت الزيارة الذاتية');
        }
    }, 10 * 60 * 1000);
});
