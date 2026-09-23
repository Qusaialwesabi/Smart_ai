const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json());

// إخبار السيرفر بوجود ملفات الواجهة داخل مجلد public
app.use(express.static(path.join(__dirname, 'public')));

// إعداد الاتصال بـ Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
let supabase;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

// إعداد الاتصال بـ Gemini
let genAI;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// ----------------------------------------------------
// المسارات (Routes)
// ----------------------------------------------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// مسار إنشاء حساب
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ success: false, error: 'قاعدة البيانات غير متصلة' });

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ success: false, error: 'خطأ في البيانات أو الحساب موجود مسبقاً' });
    
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
  }
});

// مسار تسجيل الدخول
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ success: false, error: 'قاعدة البيانات غير متصلة' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ success: false, error: 'البريد أو كلمة المرور غير صحيحة' });
    
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
  }
});

// مسار الدردشة مع الذكاء الاصطناعي
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'الرجاء إرسال النص' });
    if (!genAI) return res.status(500).json({ error: 'مفتاح Gemini غير محدد' });

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.json({ success: true, text: text });
  } catch (error) {
    res.status(500).json({ success: false, error: 'خطأ في معالجة الذكاء الاصطناعي' });
  }
});

// ----------------------------------------------------
// تشغيل الخادم بشكل طبيعي لـ Railway
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
