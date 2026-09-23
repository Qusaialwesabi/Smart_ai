const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// إعداد Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
let supabase;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    realtime: { params: { eventsPerSecond: 0 } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// ----------------------------------------------------
// نظام إدارة مفاتيح Gemini اللامحدودة (Pool of Keys)
// ----------------------------------------------------
// جلب المفاتيح من ملف البيئة .env (يمكنك إضافة مفاتيح فاصلة بفاصلة أو إضافة متغيرات جديدة)
const geminiKeysString = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
// تحويلها إلى مصفوفة وإزالة المسافات الفارغة
const geminiKeys = geminiKeysString.split(',').map(key => key.trim()).filter(Boolean);

console.log(`تم تحميل ${geminiKeys.length} مفتاح لـ Gemini بنجاح.`);

// دالة ذكية لتوليد المحتوى مع التبديل التلقائي للمفاتيح عند حدوث أي خطأ
async function generateWithRotatingKeys(prompt) {
  if (geminiKeys.length === 0) {
    throw new Error('لا توجد مفاتيح Gemini مضافة في السيرفر');
  }

  let lastError = null;

  // التجربة عبر المفاتيح الواحد تلو الآخر
  for (let i = 0; i < geminiKeys.length; i++) {
    const currentKey = geminiKeys[i];
    try {
      const genAI = new GoogleGenerativeAI(currentKey);
      const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text(); // نجحت العملية، نرجع النص فوراً
    } catch (error) {
      console.warn(`المفتاح رقم ${i + 1} فشل أو انتهى، جاري التجربة في المفتاح التالي... الخطأ:`, error.message);
      lastError = error;
      // الانتقال للمفتاح التالي في اللفة القادمة للـ loop
    }
  }

  // لو خلصت كل المفاتيح و فشلت كلها
  throw new Error('فشلت كل المفاتيح المتاحة: ' + (lastError ? lastError.message : 'خطأ غير معروف'));
}

// ----------------------------------------------------
// المسارات (Routes)
// ----------------------------------------------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ success: false, error: 'قاعدة البيانات غير متصلة' });

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ success: false, error: error.message || 'خطأ في البيانات' });
    
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ success: false, error: 'قاعدة البيانات غير متصلة' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ success: false, error: error.message || 'البريد أو كلمة المرور غير صحيحة' });
    
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
  }
});

// مسار الدردشة مع نظام تبديل المفاتيح التلقائي
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'الرجاء إرسال النص' });

    // استدعاء الدالة الذكية للتبديل بين المفاتيح
    const text = await generateWithRotatingKeys(prompt);

    res.json({ success: true, text: text });
  } catch (error) {
    console.error("Gemini Rotation Error:", error);
    res.status(500).json({ success: false, error: 'خطأ من الذكاء الاصطناعي: ' + error.message });
  }
});

// ----------------------------------------------------
// تشغيل الخادم مع آلية Keep-Alive (كل 10 ثوانٍ)
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);

  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://qusai-alwesabi.onrender.com';

  setInterval(async () => {
    try {
      await fetch(RENDER_URL);
      console.log('Keep-alive self-ping sent successfully.');
    } catch (error) {
      console.log('Keep-alive self-ping error:', error.message);
    }
  }, 10 * 1000);
});
