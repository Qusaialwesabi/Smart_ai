require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// إعدادات السيرفر
app.use(cors());
app.use(express.json());

// 🟢 الربط بمجلد الواجهة (public) ليعرض موقعك عند فتح الرابط المباشر
app.use(express.static('public'));

// استدعاء المفاتيح الأربعة من ملف .env
const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
let currentKeyIndex = 0;

function getAiClient() {
    if (apiKeys.length === 0) throw new Error("لم يتم العثور على مفاتيح API في الإعدادات!");
    return new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
}

// 🟢 مسار فحص حالة السيرفر (منع النوم)
app.get('/ping', (req, res) => {
    res.status(200).send('Server is awake and fully operational! 🚀');
});

// 🔵 مسار توليد النصوص مع الموديل 3.5-flash-lite والتبديل التلقائي
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    
    if (!prompt) {
        return res.status(400).json({ error: "النص (prompt) مطلوب!" });
    }

    let attempts = 0;
    
    while (attempts < apiKeys.length) {
        try {
            const ai = getAiClient();
            console.log(`[جاري المعالجة] باستخدام المفتاح رقم: ${currentKeyIndex + 1}`);
            
            const response = await ai.models.generateContent({
                model: 'gemini-3.5-flash-lite',
                contents: prompt,
            });
            
            return res.status(200).json({ success: true, text: response.text });
            
        } catch (error) {
            console.error(`[فشل المفتاح ${currentKeyIndex + 1}]:`, error.message);
            currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            attempts++;
        }
    }
    
    res.status(500).json({ error: "جميع المفاتيح مستنفدة أو هناك ضغط عالٍ جداً، يرجى المحاولة بعد قليل." });
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`✅ السيرفر يعمل بنجاح على المنفذ ${PORT}`);
    console.log(`🔑 عدد المفاتيح المجهزة للدوران: ${apiKeys.length}`);
    
    // ⏰ نظام الزيارة الذاتية (Self-Ping) كل 10 دقائق لمنع النوم
    const serverUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;
    
    setInterval(async () => {
        try {
            const response = await fetch(`${serverUrl}/ping`);
            if (response.ok) {
                console.log(`[Keep-Alive] تمت الزيارة الذاتية بنجاح في: ${new Date().toLocaleTimeString()}`);
            }
        } catch (error) {
            console.error('[Keep-Alive] فشلت الزيارة الذاتية:', error.message);
        }
    }, 10 * 60 * 1000); 
});
