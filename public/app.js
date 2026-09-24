// ============ STATE ============
let currentConvId = null;
let isSignUp = false;
let isSending = false;

// ============ ELEMENTS ============
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
const sidebarOverlay = document.getElementById('sidebar-overlay');

// ============ HELPERS ============
function getToken() { return localStorage.getItem('supabase_token'); }
function getAuthHeaders() {
  const t = getToken();
  return { 'Content-Type': 'application/json', ...(t ? { 'Authorization': `Bearer ${t}` } : {}) };
}
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text || '';
  return d.innerHTML;
}

// ============ SIDEBAR ============
function openSidebar() {
  if (sidebar) sidebar.classList.add('open');
  if (sidebarOverlay) sidebarOverlay.classList.add('show');
}
function closeSidebar() {
  if (sidebar) sidebar.classList.remove('open');
  if (sidebarOverlay) sidebarOverlay.classList.remove('show');
}

if (toggleSidebar) toggleSidebar.addEventListener('click', () => {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});
if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);

// ============ AUTH ============
if (authToggleBtn) {
  authToggleBtn.addEventListener('click', () => {
    isSignUp = !isSignUp;
    authTitle.textContent = isSignUp ? 'حساب جديد' : 'تسجيل الدخول';
    authSubmitBtn.textContent = isSignUp ? 'إنشاء حساب' : 'دخول';
  });
}

function showAuth() { authScreen.style.display = 'flex'; appContainer.style.display = 'none'; }
function showApp() { authScreen.style.display = 'none'; appContainer.style.display = 'flex'; }

async function checkAuth() {
  if (!getToken()) return showAuth();
  try {
    const res = await fetch('/api/auth/me', { headers: getAuthHeaders() });
    if (res.ok) { showApp(); loadConversations(); }
    else { localStorage.removeItem('supabase_token'); showAuth(); }
  } catch { showAuth(); }
}

if (authSubmitBtn) {
  authSubmitBtn.addEventListener('click', async () => {
    const email = authEmail.value.trim();
    const password = authPassword.value.trim();
    if (!email || !password) return alert('يرجى ملء جميع الحقول');

    const endpoint = isSignUp ? '/api/auth/signup' : '/api/auth/login';
    authSubmitBtn.disabled = true;
    const orig = authSubmitBtn.textContent;
    authSubmitBtn.textContent = '...';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (res.ok && data.session?.access_token) {
        localStorage.setItem('supabase_token', data.session.access_token);
        showApp();
        loadConversations();
      } else if (res.ok && isSignUp) {
        alert('تم إنشاء الحساب! قم بتسجيل الدخول.');
        isSignUp = false;
        authTitle.textContent = 'تسجيل الدخول';
        authSubmitBtn.textContent = 'دخول';
      } else {
        alert('خطأ: ' + (data.error || 'تأكد من البيانات.'));
      }
    } catch {
      alert('خطأ في الاتصال.');
    } finally {
      authSubmitBtn.disabled = false;
      authSubmitBtn.textContent = orig;
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('supabase_token');
    currentConvId = null;
    closeSidebar();
    showAuth();
  });
}

// ============ CONVERSATIONS ============
async function loadConversations() {
  try {
    const res = await fetch('/api/conversations', { headers: getAuthHeaders() });
    if (res.status === 401) {
      localStorage.removeItem('supabase_token');
      showAuth();
      return;
    }
    const data = await res.json();
    conversationsList.innerHTML = '';

    if (data.conversations?.length > 0) {
      data.conversations.forEach((c) => renderConvItem(c));
      if (!currentConvId || !data.conversations.find((c) => c.id === currentConvId)) {
        selectConv(data.conversations[0].id);
      }
    } else {
      await createNewConv();
    }
  } catch (e) { console.error(e); }
}

function renderConvItem(c) {
  const div = document.createElement('div');
  div.className = `conv-item ${c.id === currentConvId ? 'active' : ''}`;
  div.innerHTML = `
    <div class="conv-title" data-id="${c.id}">
      <i class="far fa-comments"></i>
      <span>${escapeHtml(c.title)}</span>
    </div>
    <div class="conv-actions">
      <i class="fas fa-pen edit-btn"></i>
      <i class="fas fa-trash del-btn"></i>
    </div>
  `;
  div.querySelector('.conv-title').addEventListener('click', () => selectConv(c.id));
  div.querySelector('.edit-btn').addEventListener('click', (e) => { e.stopPropagation(); editConv(c.id, c.title); });
  div.querySelector('.del-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteConv(c.id); });
  conversationsList.appendChild(div);
}

async function createNewConv() {
  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ title: 'محادثة جديدة' }),
    });
    const data = await res.json();
    if (data.conversation) {
      currentConvId = data.conversation.id;
      loadConversations();
      messagesContainer.innerHTML = '';
      return currentConvId;
    }
  } catch (e) { console.error(e); }
  return null;
}

if (newChatBtn) {
  newChatBtn.addEventListener('click', async () => {
    await createNewConv();
    closeSidebar();
  });
}

async function selectConv(id) {
  currentConvId = id;
  loadConversations();
  loadMessages(id);
  closeSidebar();
}

async function editConv(id, oldTitle) {
  const newTitle = prompt('الاسم الجديد:', oldTitle);
  if (!newTitle?.trim() || newTitle === oldTitle) return;
  const res = await fetch(`/api/conversations/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify({ title: newTitle.trim() }),
  });
  if (res.ok) loadConversations();
}

async function deleteConv(id) {
  if (!confirm('هل أنت متأكد؟')) return;
  const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE', headers: getAuthHeaders() });
  if (res.ok) {
    if (currentConvId === id) { currentConvId = null; messagesContainer.innerHTML = ''; }
    loadConversations();
  }
}

// ============ MESSAGES ============
async function loadMessages(id) {
  messagesContainer.innerHTML = '';
  try {
    const res = await fetch(`/api/conversations/${id}/messages`, { headers: getAuthHeaders() });
    const data = await res.json();
    (data.messages || []).forEach((m) => renderMessage(m.content, m.role));
  } catch (e) { console.error(e); }
}

function renderMessage(content, role) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;

  if (role === 'assistant') {
    if (typeof marked !== 'undefined') {
      try { msgDiv.innerHTML = marked.parse(content || ''); }
      catch { msgDiv.textContent = content || ''; }
    } else {
      msgDiv.textContent = content || '';
    }
  } else {
    msgDiv.textContent = content || '';
  }

  messagesContainer.appendChild(msgDiv);

  if (typeof hljs !== 'undefined') {
    msgDiv.querySelectorAll('pre code').forEach((b) => { try { hljs.highlightElement(b); } catch (e) {} });
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  return msgDiv;
}

// ============ SEND MESSAGE (GLOBAL) ============
window.sendMessage = async function() {
  console.log('📤 Send called | convId:', currentConvId, '| sending:', isSending);

  const text = (messageInput?.value || '').trim();
  if (!text) { console.log('⚠️ Empty'); return; }
  if (isSending) { console.log('⚠️ Already sending'); return; }

  if (!currentConvId) {
    console.log('⚠️ Creating conversation...');
    await createNewConv();
    if (!currentConvId) { alert('تعذر إنشاء محادثة. سجّل دخول مجدداً.'); return; }
  }

  isSending = true;
  if (sendBtn) sendBtn.disabled = true;
  messageInput.value = '';

  renderMessage(text, 'user');

  const typingDiv = document.createElement('div');
  typingDiv.className = 'message assistant';
  typingDiv.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  messagesContainer.appendChild(typingDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  try {
    const res = await fetch(`/api/conversations/${currentConvId}/messages`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ content: text }),
    });
    const data = await res.json();
    typingDiv.remove();

    if (res.ok && data.aiMessage) {
      renderMessage(data.aiMessage.content, 'assistant');
      loadConversations();
    } else {
      renderMessage('⚠️ ' + (data.error || 'خطأ'), 'assistant');
    }
  } catch (err) {
    typingDiv.remove();
    renderMessage('⚠️ خطأ في الاتصال.', 'assistant');
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
    messageInput?.focus();
  }
};

// Attach to button (multiple ways for safety)
if (sendBtn) {
  sendBtn.onclick = window.sendMessage;
  sendBtn.addEventListener('click', function(e) { e.preventDefault(); window.sendMessage(); });
}

if (messageInput) {
  messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      window.sendMessage();
    }
  });
}

// ============ INIT ============
checkAuth();
