let currentConvId = null;
let isSignUp = false;

// DOM Elements
const authScreen = document.getElementById('auth-screen');
const appContainer = document.getElementById('app-container');
const authTitle = document.getElementById('auth-title');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authToggleBtn = document.getElementById('auth-toggle-btn');

const conversationsList = document.getElementById('conversations-list');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const genImgBtn = document.getElementById('gen-img-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const logoutBtn = document.getElementById('logout-btn');
const toggleSidebar = document.getElementById('toggle-sidebar');
const sidebar = document.getElementById('sidebar');

// Auth Mode Switcher
authToggleBtn.addEventListener('click', () => {
  isSignUp = !isSignUp;
  authTitle.textContent = isSignUp ? 'حساب جديد' : 'تسجيل الدخول';
  authSubmitBtn.textContent = isSignUp ? 'إنشاء حساب' : 'دخول';
  authToggleBtn.innerHTML = isSignUp 
    ? 'لديك حساب بالفعل؟ <span>تسجيل الدخول</span>' 
    : 'ليس لديك حساب؟ <span>إنشاء حساب جديد</span>';
});

// Check Current Session
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      showApp();
      loadConversations();
    } else {
      showAuth();
    }
  } catch { showAuth(); }
}

function showAuth() {
  authScreen.style.display = 'flex';
  appContainer.style.display = 'none';
}

function showApp() {
  authScreen.style.display = 'none';
  appContainer.style.display = 'flex';
}

// Login/Signup Submit
authSubmitBtn.addEventListener('click', async () => {
  const email = authEmail.value.trim();
  const password = authPassword.value.trim();
  if (!email || !password) return alert('يرجى ملء جميع الحقول');

  const endpoint = isSignUp ? '/api/auth/signup' : '/api/auth/login';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (res.ok) {
      showApp();
      loadConversations();
    } else {
      alert(data.error || 'حدث خطأ في التسجيل');
    }
  } catch { alert('تعذر الاتصال بالخادم'); }
});

// Logout
logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  showAuth();
});

// Sidebar Mobile Toggle
toggleSidebar.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

// Conversations
async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    const data = await res.json();
    conversationsList.innerHTML = '';
    
    if (data.conversations && data.conversations.length > 0) {
      data.conversations.forEach(c => {
        const div = document.createElement('div');
        div.className = `conv-item ${c.id === currentConvId ? 'active' : ''}`;
        div.innerHTML = `<span><i class="far fa-comments"></i> ${c.title || 'محادثة'}</span>
                         <i class="fas fa-trash del-btn" style="font-size:0.8rem;"></i>`;
        div.onclick = (e) => {
          if (e.target.classList.contains('del-btn')) {
            deleteConv(c.id);
          } else {
            selectConv(c.id);
          }
        };
        conversationsList.appendChild(div);
      });
      if (!currentConvId) selectConv(data.conversations[0].id);
    } else {
      createNewConv();
    }
  } catch (e) { console.error(e); }
}

async function createNewConv() {
  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'محادثة جديدة' })
    });
    const data = await res.json();
    if (data.conversation) {
      currentConvId = data.conversation.id;
      loadConversations();
      messagesContainer.innerHTML = '';
    }
  } catch (e) { console.error(e); }
}

newChatBtn.addEventListener('click', createNewConv);

async function selectConv(id) {
  currentConvId = id;
  loadConversations();
  loadMessages(id);
  sidebar.classList.remove('open');
}

async function deleteConv(id) {
  if (!confirm('هل تريد حذف هذه المحادثة؟')) return;
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (currentConvId === id) currentConvId = null;
  loadConversations();
}

async function loadMessages(id) {
  messagesContainer.innerHTML = '';
  try {
    const res = await fetch(`/api/conversations/${id}/messages`);
    const data = await res.json();
    (data.messages || []).forEach(m => renderMessage(m.content, m.role));
  } catch (e) { console.error(e); }
}

function renderMessage(content, role, isImg = false) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;

  if (isImg) {
    msgDiv.innerHTML = `<img src="${content}" alt="Generated AI Image" />`;
  } else if (role === 'assistant') {
    msgDiv.innerHTML = marked.parse(content || '');
  } else {
    msgDiv.textContent = content;
  }

  messagesContainer.appendChild(msgDiv);
  msgDiv.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Send Chat Message
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !currentConvId) return;

  messageInput.value = '';
  renderMessage(text, 'user');

  try {
    const res = await fetch(`/api/conversations/${currentConvId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    const data = await res.json();
    if (data.aiMessage) {
      renderMessage(data.aiMessage.content, 'assistant');
    }
  } catch {
    renderMessage('⚠️ حدث خطأ أثناء الاتصال.', 'assistant');
  }
}

// Generate Image
async function generateImage() {
  const prompt = messageInput.value.trim();
  if (!prompt) return alert('يرجى كتابة وصف الصورة في خانة النص');

  messageInput.value = '';
  renderMessage(`🎨 طلب صورة: ${prompt}`, 'user');

  try {
    const res = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (data.success && data.image) {
      const src = `data:${data.image.mimeType};base64,${data.image.data}`;
      renderMessage(src, 'assistant', true);
    } else {
      renderMessage('⚠️ فشل توليد الصورة. حاول مرة أخرى.', 'assistant');
    }
  } catch {
    renderMessage('⚠️ تعذر الاتصال بمحرك الصور.', 'assistant');
  }
}

sendBtn.addEventListener('click', sendMessage);
genImgBtn.addEventListener('click', generateImage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// Init
checkAuth();
