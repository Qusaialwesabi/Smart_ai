import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// إعداد Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// إعداد Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// مسار معالجة الرسائل
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'الرسالة مطلوبة' });
    }

    // إرسال النص مباشرة للموديل الخفيف لضمان أسرع استجابة
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: message,
    });

    const reply = response.text;

    return res.json({ reply });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء معالجة الطلب' });
  }
});

// إرجاع الواجهة عند طلب أي مسار
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// تحديد المنفذ بدقة والتنصت على 0.0.0.0 ليقبل جميع اتصالات Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
