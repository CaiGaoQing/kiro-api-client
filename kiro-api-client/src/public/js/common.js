// ============ 公共状态 ============
let authToken = localStorage.getItem('authToken');

// ============ 认证相关 ============
async function checkAuth() {
    if (!authToken) {
        window.location.href = '/login.html';
        return false;
    }
    try {
        const res = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (!res.ok) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

function logout() {
    fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
    }).finally(() => {
        localStorage.removeItem('authToken');
        window.location.href = '/login.html';
    });
}

// ============ Toast 提示 ============
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
        success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        ${icons[type] || icons.info}
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
    `;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

// ============ 工具函数 ============
function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('zh-CN');
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('已复制到剪贴板', 'success');
    }).catch(() => {
        showToast('复制失败', 'error');
    });
}

// ============ 侧边栏导航 ============
function initSidebar(currentPage) {
    // 设置当前页面高亮
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === currentPage) {
            item.classList.add('active');
        }
    });

    // 导航点击事件
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const page = item.dataset.page;
            if (page) {
                navigateTo(page);
            }
        });
    });

    // 登出按钮
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }
}

function navigateTo(page) {
    const pageMap = {
        'accounts': '/pages/accounts.html',
        'gemini': '/pages/gemini.html',
        'chat': '/pages/chat.html',
        'error-accounts': '/pages/error-accounts.html',
        'api-keys': '/pages/api-keys.html',
        'usage': '/pages/usage.html',
        'logs': '/pages/logs.html',
        'error-logs': '/pages/error-logs.html',
        'proxy': '/pages/proxy.html',
        'oauth': '/pages/oauth.html',
        'change-password': '/pages/change-password.html',
        'dashboard': '/pages/accounts.html',
        'rules': '/pages/accounts.html',
        'settings': '/pages/accounts.html',
        'about': '/pages/accounts.html'
    };
    const url = pageMap[page] || '/pages/accounts.html';
    window.location.href = url;
}

// ============ 侧边栏 HTML 生成 ============
function getSidebarHTML(stats = { total: 0, active: 0, error: 0 }) {
    return `
    <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
            <div class="logo">
                <div class="logo-icon">K</div>
                <div>
                    <div class="logo-text">KIRO</div>
                    <div class="logo-subtitle">Account Manager</div>
                </div>
            </div>
        </div>
        <nav class="sidebar-nav">
            <div class="nav-section">
                <div class="nav-section-title">账号管理</div>
                <a href="#" class="nav-item" data-page="accounts">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                        <circle cx="9" cy="7" r="4"/>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                    Kiro 账号
                    <span class="nav-badge" id="nav-accounts-count">${stats.total}</span>
                </a>
                <a href="#" class="nav-item" data-page="gemini">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    Gemini 账号
                    <span class="nav-badge" id="nav-gemini-count">${stats.gemini || 0}</span>
                </a>
                <a href="#" class="nav-item" data-page="oauth">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                        <polyline points="10 17 15 12 10 7"/>
                        <line x1="15" y1="12" x2="3" y2="12"/>
                    </svg>
                    OAuth 登录
                </a>
                <a href="#" class="nav-item" data-page="chat">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    对话测试
                </a>
                <a href="#" class="nav-item" data-page="error-accounts">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    异常账号
                    <span class="nav-badge error" id="nav-error-count">${stats.error}</span>
                </a>
            </div>
            <div class="nav-section">
                <div class="nav-section-title">API 管理</div>
                <a href="#" class="nav-item" data-page="api-keys">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                    </svg>
                    API 密钥
                </a>
                <a href="#" class="nav-item" data-page="usage">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                    </svg>
                    用量统计
                </a>
            </div>
            <div class="nav-section">
                <div class="nav-section-title">日志</div>
                <a href="#" class="nav-item" data-page="logs">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                    请求日志
                </a>
                <a href="#" class="nav-item" data-page="error-logs">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    错误日志
                </a>
            </div>
            <div class="nav-section">
                <div class="nav-section-title">系统设置</div>
                <a href="#" class="nav-item" data-page="proxy">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                    代理设置
                </a>
                <a href="#" class="nav-item" data-page="change-password">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    修改密码
                </a>
            </div>
        </nav>
        <div class="sidebar-footer">
            <div class="sidebar-stats">
                <div class="stat-item">
                    <div class="stat-value" id="stat-total">${stats.total}</div>
                    <div class="stat-label">总账号</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value" id="stat-active">${stats.active}</div>
                    <div class="stat-label">活跃</div>
                </div>
            </div>
            <div class="version-info">Kiro Manager v1.0.0</div>
        </div>
    </aside>
    `;
}

// ============ 更新侧边栏统计 ============
async function updateSidebarStats() {
    try {
        const [credRes, errorRes, geminiRes] = await Promise.all([
            fetch('/api/credentials', { headers: { 'Authorization': `Bearer ${authToken}` } }),
            fetch('/api/error-credentials', { headers: { 'Authorization': `Bearer ${authToken}` } }),
            fetch('/api/gemini/credentials', { headers: { 'Authorization': `Bearer ${authToken}` } })
        ]);

        const credResult = await credRes.json();
        const errorResult = await errorRes.json();
        const geminiResult = await geminiRes.json();

        const credentials = credResult.success ? credResult.data : [];
        const errors = errorResult.success ? errorResult.data : [];
        const geminiCredentials = geminiResult.success ? geminiResult.data : [];

        const total = credentials.length;
        const active = credentials.filter(c => c.isActive).length;
        const errorCount = errors.length;
        const geminiCount = geminiCredentials.length;

        // 更新侧边栏数字
        const totalEl = document.getElementById('stat-total');
        const activeEl = document.getElementById('stat-active');
        const navAccountsEl = document.getElementById('nav-accounts-count');
        const navErrorEl = document.getElementById('nav-error-count');
        const navGeminiEl = document.getElementById('nav-gemini-count');

        if (totalEl) totalEl.textContent = total;
        if (activeEl) activeEl.textContent = active;
        if (navAccountsEl) navAccountsEl.textContent = total;
        if (navErrorEl) navErrorEl.textContent = errorCount;
        if (navGeminiEl) navGeminiEl.textContent = geminiCount;

        return { total, active, error: errorCount, gemini: geminiCount };
    } catch (e) {
        console.error('Update sidebar stats error:', e);
        return { total: 0, active: 0, error: 0, gemini: 0 };
    }
}
