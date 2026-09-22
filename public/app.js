let currentConvId = null;
let isSignUp = false;

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
const newChatBtn = document.getElementById('new-chat-btn');
const logoutBtn = document.getElementById('logout-btn');
const toggleSidebar = document.getElementById('toggle-sidebar');
const sidebar = document.getElementById('sidebar');

authToggleBtn.addEventListener('click', () => {
  isSignUp = !isSignUp;
  authTitle.textContent = isSignUp ? 'حساب جديد' : 'تسجيل الدخول';
  authSubmitBtn.textContent = isSignUp ? 'إنشاء حساب' : 'دخول';
});

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      showApp();
      loadConversations();
    } else { showAuth(); }
  } catch { showAuth(); }
}

function showAuth() { authScreen.style.display = 'flex'; appContainer.style.display = 'none'; }
function showApp() { authScreen.style.display = 'none'; appContainer.style.display = 'flex'; }

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
    if (res.ok) { checkAuth(); } else { alert('خطأ في البيانات'); }
  } catch { alert('تعذر الاتصال'); }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  showAuth();
});

toggleSidebar.addEventListener('click', () => sidebar.classList.toggle('open'));

async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    const data = await res.json();
    conversationsList.innerHTML = '';
    
    if (data.conversations && data.conversations.length > 0) {
      data.conversations.forEach(c => renderConvItem(c));
      if (!currentConvId || !data.conversations.find(c => c.id === currentConvId)) {
        selectConv(data.conversations[0].id);
      }
    } else {
      createNewConv();
    }
  } catch (e) { console.error(e); }
}

function renderConvItem(c) {
  const div = document.createElement('div');
  div.className = `conv-item ${c.id === currentConvId ? 'active' : ''}`;
  
  div.innerHTML = `
    <div class="conv-title" onclick="selectConv('${c.id}')" title="${c.title || 'محادثة'}">
      <i class="far fa-comments"></i> ${c.title || 'محادثة'}
    </div>
    <div class="conv-actions">
      <i class="fas fa-pen edit-btn" onclick="editConv(event, '${c.id}', '${c.title}')" title="تعديل الاسم"></i>
      <i class="fas fa-trash del-btn" onclick="deleteConv(event, '${c.id}')" title="حذف"></i>
    </div>
  `;
  conversationsList.appendChild(div);
}

async function createNewConv() {
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
}

newChatBtn.addEventListener('click', createNewConv);

async function selectConv(id) {
  currentConvId = id;
  loadConversations();
  loadMessages(id);
  sidebar.classList.remove('open');
}

async function editConv(event, id, oldTitle) {
  event.stopPropagation();
  const newTitle = prompt("أدخل الاسم الجديد للمحادثة:", oldTitle);
  if (!newTitle || newTitle === oldTitle) return;
  
  const res = await fetch(`/api/conversations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle })
  });
  if (res.ok) loadConversations();
}

async function deleteConv(event, id) {
  event.stopPropagation();
  const confirmDelete = confirm("هل أنت متأكد أنك تريد حذف هذه المحادثة بشكل نهائي؟");
  if (!confirmDelete) return;
  
  const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (res.ok) {
    if (currentConvId === id) {
      currentConvId = null;
      messagesContainer.innerHTML = '';
    }
    loadConversations();
  }
}

async function loadMessages(id) {
  messagesContainer.innerHTML = '';
  const res = await fetch(`/api/conversations/${id}/messages`);
  const data = await res.json();
  (data.messages || []).forEach(m => renderMessage(m.content, m.role));
}

function renderMessage(content, role) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;

  if (role === 'assistant') {
    msgDiv.innerHTML = marked.parse(content || '');
  } else {
    msgDiv.textContent = content;
  }

  messagesContainer.appendChild(msgDiv);
  msgDiv.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

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
    
    if (res.ok && data.aiMessage) {
      renderMessage(data.aiMessage.content, 'assistant');
    } else {
      renderMessage('⚠️ حدث خطأ: ' + (data.error || 'تعذر الاتصال بالنموذج.'), 'assistant');
    }
  } catch (err) {
    renderMessage('⚠️ حدث خطأ في الاتصال بالسيرفر.', 'assistant');
  }
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

checkAuth();
