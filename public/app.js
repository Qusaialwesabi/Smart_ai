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
      showApp();
      loadConversations();
      loadSubscriptionStatus();
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

if (logoutBtn) logoutBtn.addEventListener('click', () => forceLogout());

// CONVERSATIONS
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
  } catch (e) {}
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
  const t = prompt('الاسم الجديد:', oldTitle);
  if (!t?.trim() || t === oldTitle) return;
  try {
    const res = await authFetch(`/api/conversations/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: t.trim() }),
    });
    if (res.ok) loadConversations();
  } catch (e) {}
}

async function deleteConv(id) {
  if (!confirm('هل أنت متأكد؟')) return;
  try {
    const res = await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (currentConvId === id) { currentConvId = null; messagesContainer.innerHTML = ''; }
      loadConversations();
    }
  } catch (e) {}
}

// MESSAGES
async function loadMessages(id) {
  messagesContainer.innerHTML = '';
  try {
    const res = await authFetch(`/api/conversations/${id}/messages`);
    const data = await res.json();
    (data.messages || []).forEach((m) => renderMessage(m.content, m.role));
  } catch (e) {}
}

function renderMessage(content, role) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (role === 'assistant') {
    if (typeof marked !== 'undefined') {
      try { div.innerHTML = marked.parse(content || ''); }
      catch { div.textContent = content || ''; }
    } else div.textContent = content || '';
  } else div.textContent = content || '';

  messagesContainer.appendChild(div);

  if (typeof hljs !== 'undefined') {
    div.querySelectorAll('pre code').forEach((b) => { try { hljs.highlightElement(b); } catch (e) {} });
  }
  if (role === 'assistant') addCopyButtonsToMessage(div);

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  return div;
}

// SEND
window.sendMessage = async function() {
  const text = (messageInput?.value || '').trim();
  if (!text) return;
  if (isSending) return;

  if (!currentConvId) {
    await createNewConv();
    if (!currentConvId) { alert('تعذر إنشاء محادثة.'); return; }
  }

  isSending = true;
  if (sendBtn) sendBtn.disabled = true;
  messageInput.value = '';

  renderMessage(text, 'user');

  const typing = document.createElement('div');
  typing.className = 'message assistant';
  typing.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  messagesContainer.appendChild(typing);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  try {
    const res = await authFetch(`/api/conversations/${currentConvId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: text }),
    });
    const data = await res.json();
    typing.remove();

    if (res.status === 429 && data.error === 'LIMIT_REACHED') {
      renderMessage(data.message, 'assistant');
      openSubModal(data.message);
      return;
    }

    if (res.ok && data.aiMessage) {
      renderMessage(data.aiMessage.content, 'assistant');
      loadConversations();
      if (data.usage) {
        updateUsageBadge({
          isPremium: data.usage.plan === 'premium',
          remaining: data.usage.remaining,
          limit: data.usage.limit,
        });
      }
    } else {
      renderMessage('⚠️ ' + (data.error || 'خطأ'), 'assistant');
    }
  } catch (err) {
    typing.remove();
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

// SUBSCRIPTION
async function loadSubscriptionStatus() {
  try {
    const res = await authFetch('/api/subscription/status');
    if (!res.ok) return;
    const data = await res.json();
    updateUsageBadge(data);
  } catch (e) {}
}

function updateUsageBadge(data) {
  let badge = document.getElementById('usage-badge');
  const header = document.querySelector('.chat-header');
  if (!badge && header) {
    badge = document.createElement('span');
    badge.id = 'usage-badge';
    badge.className = 'usage-badge';
    header.appendChild(badge);
  }
  if (!badge) return;

  if (data.isPremium) {
    badge.className = 'usage-badge premium';
    badge.innerHTML = '<i class="fas fa-crown"></i> Premium';
  } else {
    const rem = data.remaining;
    badge.className = 'usage-badge' + (rem <= 2 ? ' low' : '');
    badge.innerHTML = `<i class="fas fa-bolt"></i> ${rem}/${data.limit}`;
  }
}

function openSubModal(limitMsg) {
  const modal = document.getElementById('sub-modal');
  const msgEl = document.getElementById('sub-limit-msg');
  if (msgEl && limitMsg) msgEl.textContent = limitMsg;
  if (modal) modal.classList.add('show');
  loadSubscriptionStatus();
}
window.openSubModal = openSubModal;

function closeSubModal() {
  const modal = document.getElementById('sub-modal');
  if (modal) modal.classList.remove('show');
}
window.closeSubModal = closeSubModal;

async function selectPlan(plan) {
  const btn = document.querySelector(`.sub-plan[data-plan="${plan}"] .sub-plan-btn`);
  const orig = btn?.innerHTML;
  try {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري التحضير...';
    }
    const res = await authFetch('/api/paypal/create-order', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed.');

    sessionStorage.setItem('paypal_order_id', data.orderId);
    sessionStorage.setItem('paypal_plan', plan);
    window.location.href = data.approvalUrl;
  } catch (err) {
    alert('فشل بدء الدفع: ' + err.message);
    if (btn && orig) { btn.disabled = false; btn.innerHTML = orig; }
  }
}
window.selectPlan = selectPlan;

async function handlePayPalReturn() {
  const params = new URLSearchParams(window.location.search);
  const payment = params.get('payment');

  if (payment === 'success') {
    const orderId = sessionStorage.getItem('paypal_order_id');
    const plan = sessionStorage.getItem('paypal_plan');
    if (orderId && plan) {
      try {
        const res = await authFetch('/api/paypal/capture-order', {
          method: 'POST',
          body: JSON.stringify({ orderId, plan }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          alert('🎉 مبروك! تم تفعيل اشتراكك بنجاح.');
          closeSubModal();
          await checkAuth();
        } else {
          alert('⚠️ فشل تأكيد الدفع: ' + (data.error || 'حاول لاحقاً'));
        }
      } catch (err) { console.error('Capture error:', err); }
      finally {
        sessionStorage.removeItem('paypal_order_id');
        sessionStorage.removeItem('paypal_plan');
      }
    }
    window.history.replaceState(null, '', window.location.pathname);
  } else if (payment === 'cancel') {
    alert('تم إلغاء الدفع.');
    window.history.replaceState(null, '', window.location.pathname);
  }
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('sub-modal-overlay')) closeSubModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSubModal();
});

setInterval(async () => {
  if (getToken() && getRefreshToken()) await refreshAccessToken();
}, 30 * 60 * 1000);

handlePayPalReturn();
checkAuth();
