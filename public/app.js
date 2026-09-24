// ============ STATE ============
let currentConvId = null;
let isSignUp = false;
let isSending = false;
let isRefreshing = false;

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

// ============ TOKEN MANAGEMENT ============
function getToken() { return localStorage.getItem('supabase_token'); }
function getRefreshToken() { return localStorage.getItem('supabase_refresh_token'); }

function saveTokens(session) {
  if (session?.access_token) localStorage.setItem('supabase_token', session.access_token);
  if (session?.refresh_token) localStorage.setItem('supabase_refresh_token', session.refresh_token);
}

function clearTokens() {
  localStorage.removeItem('supabase_token');
  localStorage.removeItem('supabase_refresh_token');
}

function getAuthHeaders() {
  const t = getToken();
  return { 'Content-Type': 'application/json', ...(t ? { 'Authorization': `Bearer ${t}` } : {}) };
}

async function refreshAccessToken() {
  if (isRefreshing) return false;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  isRefreshing = true;
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const data = await res.json();

    if (res.ok && data.session?.access_token) {
      saveTokens(data.session);
      console.log('✅ Token refreshed');
      return true;
    }
    console.warn('❌ Refresh failed:', data.error || res.status);
    return false;
  } catch (e) {
    console.error('Refresh error:', e);
    return false;
  } finally {
    isRefreshing = false;
  }
}

function forceLogout(message) {
  clearTokens();
  currentConvId = null;
  closeSidebar();
  showAuth();
  if (message) alert(message);
}

async function authFetch(url, options = {}) {
  options.headers = { ...(options.headers || {}), ...getAuthHeaders() };
  let res = await fetch(url, options);

  if (res.status === 401) {
    console.log('⚠️ 401 — refreshing token...');
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      options.headers = { ...(options.headers || {}), ...getAuthHeaders() };
      res = await fetch(url, options);
    } else {
      forceLogout('انتهت جلستك. يرجى تسجيل الدخول مجدداً.');
      throw new Error('UNAUTHORIZED');
    }
  }
  return res;
}

// ============ HELPERS ============
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text || '';
  return d.innerHTML;
}

// ============ CODE COPY BUTTONS ============
function addCopyButtonsToMessage(msgElement) {
  const preBlocks = msgElement.querySelectorAll('pre');

  preBlocks.forEach((pre) => {
    // Skip if already processed
    if (pre.dataset.copyEnhanced === 'true') return;
    pre.dataset.copyEnhanced = 'true';

    const codeEl = pre.querySelector('code');
    if (!codeEl) return;

    // Get language from class (e.g., "language-javascript")
    let lang = 'code';
    const codeClasses = codeEl.className || '';
    const langMatch = codeClasses.match(/language-(\w+)/);
    if (langMatch) lang = langMatch[1];

    // Get raw code text BEFORE we wrap anything
    const rawCode = codeEl.textContent || '';

    // Create wrapper structure
    const header = document.createElement('div');
    header.className = 'code-block-header';

    const langLabel = document.createElement('span');
    langLabel.className = 'code-lang';
    langLabel.textContent = lang;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-code-btn';
    copyBtn.type = 'button';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i> نسخ';
    copyBtn.setAttribute('aria-label', 'نسخ الكود');

    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        // Try modern clipboard API first
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(rawCode);
        } else {
          // Fallback for older browsers / non-HTTPS
          const textarea = document.createElement('textarea');
          textarea.value = rawCode;
          textarea.style.position = 'fixed';
          textarea.style.left = '-9999px';
          textarea.style.top = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }

        // Visual feedback
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<i class="fas fa-check"></i> تم النسخ';

        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<i class="fas fa-copy"></i> نسخ';
        }, 2000);
      } catch (err) {
        console.error('Copy failed:', err);
        copyBtn.innerHTML = '<i class="fas fa-times"></i> فشل';
        setTimeout(() => {
          copyBtn.innerHTML = '<i class="fas fa-copy"></i> نسخ';
        }, 2000);
      }
    });

    header.appendChild(langLabel);
    header.appendChild(copyBtn);

    // Create content wrapper
    const contentWrap = document.createElement('div');
    contentWrap.className = 'code-block-content';

    // Move code into content wrapper
    contentWrap.appendChild(codeEl);

    // Clear pre and rebuild
    pre.innerHTML = '';
    pre.appendChild(header);
    pre.appendChild(contentWrap);
  });
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
    const res = await authFetch('/api/auth/me');
    if (res.ok) {
      showApp();
      loadConversations();
    } else {
      forceLogout();
    }
  } catch (e) {
    // authFetch handles logout
  }
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
        saveTokens(data.session);
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

if (authPassword) {
  authPassword.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') authSubmitBtn.click();
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => forceLogout());
}

// ============ CONVERSATIONS ============
async function loadConversations() {
  try {
    const res = await authFetch('/api/conversations');
    if (!res.ok) return;

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
  } catch (e) {
    if (e.message !== 'UNAUTHORIZED') console.error(e);
  }
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
    const res = await authFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: 'محادثة جديدة' }),
    });
    const data = await res.json();
    if (data.conversation) {
      currentConvId = data.conversation.id;
      loadConversations();
      messagesContainer.innerHTML = '';
      return currentConvId;
    }
  } catch (e) {
    if (e.message !== 'UNAUTHORIZED') console.error(e);
  }
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
  try {
    const res = await authFetch(`/api/conversations/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: newTitle.trim() }),
    });
    if (res.ok) loadConversations();
  } catch (e) {
    if (e.message !== 'UNAUTHORIZED') console.error(e);
  }
}

async function deleteConv(id) {
  if (!confirm('هل أنت متأكد؟')) return;
  try {
    const res = await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (currentConvId === id) { currentConvId = null; messagesContainer.innerHTML = ''; }
      loadConversations();
    }
  } catch (e) {
    if (e.message !== 'UNAUTHORIZED') console.error(e);
  }
}

// ============ MESSAGES ============
async function loadMessages(id) {
  messagesContainer.innerHTML = '';
  try {
    const res = await authFetch(`/api/conversations/${id}/messages`);
    const data = await res.json();
    (data.messages || []).forEach((m) => renderMessage(m.content, m.role));
  } catch (e) {
    if (e.message !== 'UNAUTHORIZED') console.error(e);
  }
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

  // Highlight code blocks
  if (typeof hljs !== 'undefined') {
    msgDiv.querySelectorAll('pre code').forEach((b) => {
      try { hljs.highlightElement(b); } catch (e) {}
    });
  }

  // Add copy buttons (after highlighting so lang class is preserved)
  if (role === 'assistant') {
    addCopyButtonsToMessage(msgDiv);
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  return msgDiv;
}

// ============ SEND MESSAGE ============
window.sendMessage = async function() {
  console.log('📤 Send called | convId:', currentConvId, '| sending:', isSending);

  const text = (messageInput?.value || '').trim();
  if (!text) return;
  if (isSending) return;

  if (!currentConvId) {
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
    const res = await authFetch(`/api/conversations/${currentConvId}/messages`, {
      method: 'POST',
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
    if (err.message === 'UNAUTHORIZED') return;
    renderMessage('⚠️ خطأ في الاتصال.', 'assistant');
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
    messageInput?.focus();
  }
};

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

// ============ AUTO REFRESH EVERY 30 MINUTES ============
setInterval(async () => {
  if (getToken() && getRefreshToken()) {
    console.log('🔄 Proactive token refresh...');
    await refreshAccessToken();
  }
}, 30 * 60 * 1000);

// ============ INIT ============
checkAuth();
