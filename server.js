require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// إعدادات لتحسين سرعة استقبال الطلبات وتأمينها
app.use(cors());
app.use(express.json());

// استدعاء المفاتيح الخمسة من ملف .env
const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
let currentKeyIndex = 0;

// دالة ذكية لتجهيز العميل بناءً على المفتاح النشط حالياً
function getAiClient() {
    if (apiKeys.length === 0) throw new Error("لم يتم العثور على مفاتيح API في الإعدادات!");
    return new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
}

// 🟢 مسار منع النوم (Keep-Alive) - ضعه في خدمة cron-job.org
app.get('/ping', (req, res) => {
    // رد سريع جداً بخفة 200 OK لا يستهلك موارد
    res.status(200).send('Server is awake and fully operational! 🚀');
});

// 🔵 مسار الذكاء الاصطناعي السريع مع التبديل التلقائي للمفاتيح
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    
    if (!prompt) {
        return res.status(400).json({ error: "النص (prompt) مطلوب!" });
    }

    let attempts = 0;
    
    // المحاولة بجميع المفاتيح المتاحة قبل الاستسلام
    while (attempts < apiKeys.length) {
        try {
            const ai = getAiClient();
            console.log(`[جاري المعالجة] باستخدام المفتاح رقم: ${currentKeyIndex + 1}`);
            
            // استخدام gemini-2.5-flash لأنه الأسرع للردود اللحظية
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });
            
            // إرسال النتيجة فوراً للمستخدم
            return res.status(200).json({ success: true, text: response.text });
            
        } catch (error) {
            console.error(`[فشل المفتاح ${currentKeyIndex + 1}]:`, error.message);
            
            // التبديل للمفتاح التالي فوراً وبدون إيقاف السيرفر
            currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            attempts++;
        }
    }
    
    // إذا انتهت حصة الـ 5 حسابات بالكامل (نادر جداً)
    res.status(500).json({ error: "الضغط عالٍ جداً، يرجى المحاولة بعد قليل." });
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`✅ السيرفر يعمل بنجاح على المنفذ ${PORT}`);
    console.log(`🔑 عدد المفاتيح المجهزة للدوران: ${apiKeys.length}`);
});
