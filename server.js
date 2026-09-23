const express = require('express');
const cors = require('cors');
require('dotenv').config();

// استدعاء مكتبات Gemini و Supabase
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// إعدادات الميدلوير
app.use(cors());
app.use(express.json());

// 1. إعداد الاتصال بـ Supabase
const supabaseUrl = process.env.SUPABASE_URL;
// استخدمنا هنا المتغيرين تحسباً للاسم الذي وضعته في Vercel
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

// مسار رئيسي للتأكد من أن السيرفر يعمل بنجاح
app.get('/', (req, res) => {
  res.send('🚀 Smart AI Server is running successfully on Vercel!');
});

// مسار للتعامل مع الذكاء الاصطناعي (Gemini)
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'الرجاء إرسال النص (prompt)' });
    }

    // استخدام أحدث موديل من جيميناي
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
// إعدادات التشغيل (مهمة جداً لـ Vercel)
// ----------------------------------------------------

// تصدير التطبيق ليتمكن Vercel من تشغيله كـ Serverless Function
module.exports = app;

// تشغيل السيرفر محلياً فقط (تجاهله في Vercel)
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server is running locally on port ${PORT}`);
  });
}
