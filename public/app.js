// STATE
let currentConvId = null;
let isSignUp = false;
let isSending = false;
let isRefreshing = false;

// ELEMENTS
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

// TOKEN
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
  const rt = getRefreshToken();
  if (!rt) return false;
  isRefreshing = true;
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    const data = await res.json();
    if (res.ok && data.session?.access_token) { saveTokens(data.session); return true; }
    return false;
  } catch { return false; }
  finally { isRefreshing = false; }
}

function forceLogout(msg) {
  clearTokens();
  currentConvId = null;
  closeSidebar();
  showAuth();
  if (msg) alert(msg);
}

async function authFetch(url, options = {}) {
  options.headers = { ...(options.headers || {}), ...getAuthHeaders() };
  let res = await fetch(url, options);
  if (res.status === 401) {
    const ok = await refreshAccessToken();
    if (ok) {
      options.headers = { ...(options.headers || {}), ...getAuthHeaders() };
      res = await fetch(url, options);
    } else {
      forceLogout('انتهت جلستك.');
      throw new Error('UNAUTHORIZED');
    }
  }
  return res;
}

// HELPERS
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text || '';
  return d.innerHTML;
}

// UPDATE USAGE BADGE UI
function updateUsageUI(usage) {
  const badge = document.getElementById('usage-badge');
  if (!badge || !usage) return;
  if (usage.plan === 'premium') {
    badge.className = 'usage-badge premium';
    badge.innerHTML = '<i class="fas fa-crown"></i> Premium';
  } else {
    const rem = usage.remaining !== undefined ? usage.remaining : 7;
    const limit = usage.limit || 7;
    badge.className = rem <= 1 ? 'usage-badge low' : 'usage-badge';
    badge.innerHTML = `<i class="fas fa-bolt"></i> متبقي: ${rem} / ${limit}`;
  }
}

// LOAD SUBSCRIPTION STATUS
async function loadSubscriptionStatus() {
  try {
    const res = await authFetch('/api/subscription/status');
    if (res.ok) {
      const data = await res.json();
      updateUsageUI({ plan: data.plan, remaining: data.remaining, limit: data.limit });
    }
  } catch (err) {
    console.error('Failed to load sub status', err);
  }
}

// CODE COPY
function addCopyButtonsToMessage(msgEl) {
  msgEl.querySelectorAll('pre').forEach((pre) => {
    if (pre.dataset.copyEnhanced === 'true') return;
    pre.dataset.copyEnhanced = 'true';
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;
    let lang = 'code';
    const m = (codeEl.className || '').match(/language-(\w+)/);
    if (m) lang = m[1];
    const rawCode = codeEl.textContent || '';

    const header = document.createElement('div');
    header.className = 'code-block-header';

    const langLabel = document.createElement('span');
    langLabel.className = 'code-lang';
    langLabel.textContent = lang;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-code-btn';
    copyBtn.type = 'button';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i> نسخ';

    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(rawCode);
        } else {
          const ta = document.createElement('textarea');
          ta.value = rawCode;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<i class="fas fa-check"></i> تم النسخ';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<i class="fas fa-copy"></i> نسخ';
        }, 2000);
      } catch (err) {
        copyBtn.innerHTML = '<i class="fas fa-times"></i> فشل';
        setTimeout(() => {
          copyBtn.innerHTML = '<i class="fas fa-copy"></i> نسخ';
        }, 2000);
      }
    });

    header.appendChild(langLabel);
    header.appendChild(copyBtn);

    const wrap = document.createElement('div');
    wrap.className = 'code-block-content';
    wrap.appendChild(codeEl);

    pre.innerHTML = '';
    pre.appendChild(header);
    pre.appendChild(wrap);
  });
}

// SIDEBAR
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

// AUTH
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
      const data = await res.json();
      showApp();
      loadConversations();
      if (data.profile) {
        updateUsageUI({ plan: data.profile.plan, remaining: data.profile.remaining, limit: data.profile.limit });
      }
    } else {
      forceLogout();
    }
  } catch (e) {}
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
        loadSubscriptionStatus();
      } else if (res.ok && isSignUp) {
        alert('تم إنشاء الحساب! قم بتسجيل الدخول.');
        isSignUp = false;
        authTitle.textContent = 'تسجيل الدخول';
        authSubmitBtn.textContent = 'دخول';
      } else {
        alert('خطأ: ' + (data.error || 'تأكد من البيانات.'));
      }
    } catch {
      alert('حدث خطأ في الاتصال.');
    } finally {
      authSubmitBtn.disabled = false;
      authSubmitBtn.textContent = orig;
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => forceLogout());
}

// CONVERSATIONS
async function loadConversations() {
  try {
    const res = await authFetch('/api/conversations');
    if (!res.ok) return;
    const data = await res.json();
    renderConversations(data.conversations || []);
    if (!currentConvId && data.conversations?.length > 0) {
      selectConversation(data.conversations[0].id);
    } else if (!currentConvId) {
      createNewConversation();
    }
  } catch (e) {}
}

function renderConversations(convs) {
  if (!conversationsList) return;
  conversationsList.innerHTML = '';
  convs.forEach(c => {
    const el = document.createElement('div');
    el.className = `conv-item ${c.id === currentConvId ? 'active' : ''}`;
    el.innerHTML = `
      <div class="conv-title"><i class="fas fa-message"></i> ${escapeHtml(c.title)}</div>
      <div class="conv-actions">
        <i class="fas fa-trash del-btn" title="حذف"></i>
      </div>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.del-btn')) {
        e.stopPropagation();
        deleteConversation(c.id);
        return;
      }
      selectConversation(c.id);
      closeSidebar();
    });
    conversationsList.appendChild(el);
  });
}

async function createNewConversation() {
  try {
    const res = await authFetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'محادثة جديدة' }),
    });
    if (!res.ok) return;
    const data = await res.json();
    currentConvId = data.conversation.id;
    messagesContainer.innerHTML = '';
    loadConversations();
    closeSidebar();
  } catch (e) {}
}

if (newChatBtn) newChatBtn.addEventListener('click', createNewConversation);

async function selectConversation(id) {
  currentConvId = id;
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('onclick')?.includes(id) || false);
  });
  loadConversations();
  await loadMessages(id);
}

async function loadMessages(convId) {
  try {
    const res = await authFetch(`/api/conversations/${convId}/messages`);
    if (!res.ok) return;
    const data = await res.json();
    messagesContainer.innerHTML = '';
    (data.messages || []).forEach(m => appendMessage(m.role, m.content, false));
    scrollToBottom();
  } catch (e) {}
}

async function deleteConversation(id) {
  if (!confirm('هل تريد حذف هذه المحادثة؟')) return;
  try {
    const res = await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (currentConvId === id) {
        currentConvId = null;
        messagesContainer.innerHTML = '';
      }
      loadConversations();
    }
  } catch (e) {}
}

// MESSAGES & SENDING
function appendMessage(role, content, animate = true) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (role === 'assistant') {
    div.innerHTML = marked.parse(content || '');
    addCopyButtonsToMessage(div);
  } else {
    div.textContent = content;
  }
  messagesContainer.appendChild(div);
  scrollToBottom();
  return div;
}

function appendTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = 'typing-indicator';
  div.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  messagesContainer.appendChild(div);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isSending) return;
  if (!currentConvId) {
    await createNewConversation();
  }

  messageInput.value = '';
  isSending = true;
  sendBtn.disabled = true;

  appendMessage('user', text);
  appendTypingIndicator();

  try {
    const res = await authFetch(`/api/conversations/${currentConvId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });

    removeTypingIndicator();
    const data = await res.json();

    if (res.status === 429) {
      // انتهت الرسائل المجانية
      openSubModal(data.message || 'انتهت رسائلك المجانية لهذا اليوم.');
      updateUsageUI({ plan: 'free', remaining: 0, limit: 7 });
      return;
    }

    if (!res.ok) {
      appendMessage('assistant', '⚠️ حدث خطأ أثناء إرسال الرسالة.');
      return;
    }

    appendMessage('assistant', data.aiMessage.content);
    if (data.usage) {
      updateUsageUI(data.usage);
    }
    loadConversations();
  } catch (err) {
    removeTypingIndicator();
    appendMessage('assistant', '⚠️ خطأ في الاتصال بالسيرفر.');
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    messageInput.focus();
  }
}

if (sendBtn) sendBtn.addEventListener('click', sendMessage);
if (messageInput) {
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

// SUBSCRIPTION MODAL FUNCTIONS
function openSubModal(msg) {
  const modal = document.getElementById('sub-modal');
  const limitMsg = document.getElementById('sub-limit-msg');
  if (limitMsg && msg) limitMsg.textContent = msg;
  if (modal) modal.classList.add('show');
}

function closeSubModal() {
  const modal = document.getElementById('sub-modal');
  if (modal) modal.classList.remove('show');
}

async function selectPlan(plan) {
  try {
    const btn = document.querySelector(`.sub-plan[data-plan="${plan}"] .sub-plan-btn`);
    if (btn) { btn.disabled = true; btn.textContent = 'جاري التحويل...'; }

    const res = await authFetch('/api/paypal/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    const data = await res.json();
    if (res.ok && data.approvalUrl) {
      window.location.href = data.approvalUrl;
    } else {
      alert(data.error || 'فشل بدء الدفع.');
      if (btn) { btn.disabled = false; btn.textContent = 'اشترك الآن'; }
    }
  } catch (err) {
    alert('حدث خطأ في الاتصال.');
  }
}

// CHECK PAYPAL RETURN AFTER REDIRECT
async function checkPaymentReturn() {
  const urlParams = new URLSearchParams(window.location.search);
  const paymentStatus = urlParams.get('payment');
  const token = urlParams.get('token'); // PayPal order token

  if (paymentStatus === 'success' && token) {
    // إزالة البارامترات من الرابط
    window.history.replaceState({}, document.title, window.location.pathname);
    // نقوم بالتحقق وتأكيد الطلب
    // (بما أن الكود الحالي في السيرفر يلتقط الدفع عبر الدخول أو يمكن تمرير الـ plan المخزن مؤقتاً أو التقاطه تلقائياً)
    alert('تم الدفع بنجاح! يتم تفعيل اشتراكك...');
    loadSubscriptionStatus();
  } else if (paymentStatus === 'cancel') {
    window.history.replaceState({}, document.title, window.location.pathname);
    alert('تم إلغاء عملية الدفع.');
  }
}

// INIT
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  checkPaymentReturn();
});
