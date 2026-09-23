const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json());

// إخبار السيرفر بوجود ملفات الواجهة (HTML, CSS, JS) داخل مجلد public
app.use(express.static(path.join(__dirname, 'public')));

// 1. إعداد الاتصال بـ Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
let supabase;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

// 2. إعداد الاتصال بـ Gemini
let genAI;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// ----------------------------------------------------
// المسارات (Routes)
// ----------------------------------------------------

// عرض واجهة الموقع عند فتح الرابط الرئيسي
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// مسار إنشاء حساب جديد
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!supabase) {
        return res.status(500).json({ success: false, error: 'لم يتم الاتصال بقاعدة البيانات' });
    }

    const { data, error } = await supabase.auth.signUp({ email, password });
    
    if (error) {
        return res.status(400).json({ success: false, error: 'خطأ في البيانات أو الحساب موجود مسبقاً' });
    }
    res.json({ success: true, data });
  } catch (error) {
    console.error("Register Error:", error);
    res.status(500).json({ success: false, error: 'حدث خطأ داخلي في الخادم' });
  }
});

// مسار تسجيل الدخول
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!supabase) {
        return res.status(500).json({ success: false, error: 'لم يتم الاتصال بقاعدة البيانات' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    
    if (error) {
        return res.status(400).json({ success: false, error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
    }
    res.json({ success: true, data });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ success: false, error: 'حدث خطأ داخلي في الخادم' });
  }
});

// مسار الذكاء الاصطناعي (Gemini)
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'الرجاء إرسال النص (prompt)' });
    }

    if (!genAI) {
        return res.status(500).json({ error: 'لم يتم إعداد مفتاح Gemini' });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.json({ success: true, text: text });
  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({ success: false, error: 'حدث خطأ داخلي في الخادم' });
  }
});

// ----------------------------------------------------
// إعدادات التشغيل لـ Vercel
// ----------------------------------------------------
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server is running locally on port ${PORT}`);
  });
}
