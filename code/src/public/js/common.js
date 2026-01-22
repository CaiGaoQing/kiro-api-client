// ============ 公共状态 ============
let authToken = localStorage.getItem('authToken');

// 站点设置（全局）- 先尝试从 localStorage 读取缓存
window.siteSettings = JSON.parse(localStorage.getItem('siteSettings')) || {
    siteName: 'Kiro',
    siteLogo: 'K',
    siteSubtitle: 'Account Manager'
};

// ============ 站点设置 ============
async function loadSiteSettings() {
    try {
        const res = await fetch('/api/site-settings');
        const data = await res.json();
        if (data.success && data.data) {
            window.siteSettings = data.data;
            // 缓存到 localStorage
            localStorage.setItem('siteSettings', JSON.stringify(data.data));
            // 更新页面上的站点信息
            updateSiteSettingsUI();
        }
    } catch (e) {
        console.error('Load site settings error:', e);
    }
    return window.siteSettings;
}

// 更新页面上所有使用站点设置的元素
function updateSiteSettingsUI() {
    const settings = window.siteSettings;

    // 更新页面 title（替换 Kiro 为配置的站点名称）
    const currentTitle = document.title;
    if (currentTitle.includes('Kiro')) {
        document.title = currentTitle.replace(/Kiro/g, settings.siteName);
    } else if (!currentTitle.includes(settings.siteName)) {
        // 如果 title 不包含站点名称，追加
        const pageName = currentTitle.split(' - ')[0] || currentTitle;
        document.title = `${pageName} - ${settings.siteName} ${settings.siteSubtitle}`;
    }

    // 更新侧边栏 logo
    const logoIcon = document.querySelector('.sidebar .logo-icon');
    const logoText = document.querySelector('.sidebar .logo-text');
    const logoSubtitle = document.querySelector('.sidebar .logo-subtitle');

    if (logoIcon) logoIcon.textContent = settings.siteLogo;
    if (logoText) logoText.textContent = settings.siteName.toUpperCase();
    if (logoSubtitle) logoSubtitle.textContent = settings.siteSubtitle;

    // 更新版本信息
    const versionInfo = document.querySelector('.version-info');
    if (versionInfo) versionInfo.textContent = `${settings.siteName} Manager v1.0.0`;

    // 更新导航中的账号文字
    const kiroNavItem = document.querySelector('.nav-item[data-page="accounts"]');
    if (kiroNavItem) {
        const badge = kiroNavItem.querySelector('.nav-badge');
        const badgeHTML = badge ? badge.outerHTML : '';
        const svgIcon = kiroNavItem.querySelector('svg');
        const svgHTML = svgIcon ? svgIcon.outerHTML : '';
        kiroNavItem.innerHTML = `${svgHTML} ${settings.siteName} 账号 ${badgeHTML}`;
    }

    // 更新页面副标题中的 "Kiro"
    const pageSubtitle = document.querySelector('.page-subtitle');
    if (pageSubtitle && pageSubtitle.textContent.includes('Kiro')) {
        pageSubtitle.textContent = pageSubtitle.textContent.replace(/Kiro/g, settings.siteName);
    }
}

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
    // 优先使用 navigator.clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('已复制到剪贴板', 'success');
        }).catch(() => {
            // 如果失败，使用备用方案
            fallbackCopyToClipboard(text);
        });
    } else {
        // 不支持 clipboard API，使用备用方案
        fallbackCopyToClipboard(text);
    }
}

function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showToast('已复制到剪贴板', 'success');
        } else {
            showToast('复制失败', 'error');
        }
    } catch (err) {
        showToast('复制失败', 'error');
    }
    document.body.removeChild(textArea);
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
            const page = item.dataset.page;
            if (page) {
                e.preventDefault();
                navigateTo(page);
            }
            // 没有 data-page 的链接允许默认行为（如外部链接）
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
        'orchids': '/pages/orchids.html',
        'warp': '/pages/warp.html',
        'chat': '/pages/chat.html',
        'error-accounts': '/pages/error-accounts.html',
        'api-keys': '/pages/api-keys.html',
        'usage': '/pages/usage.html',
        'logs': '/pages/logs.html',
        'error-logs': '/pages/error-logs.html',
        'proxy': '/pages/proxy.html',
        'oauth': '/pages/oauth.html',
        'change-password': '/pages/change-password.html',
        'trial-admin': '/pages/trial-admin.html',
        'site-settings': '/pages/site-settings.html',
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
    const settings = window.siteSettings || { siteName: 'Kiro', siteLogo: 'K', siteSubtitle: 'Account Manager' };
    return `
    <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
            <div class="logo">
                <div class="logo-icon">${settings.siteLogo}</div>
                <div>
                    <div class="logo-text">${settings.siteName.toUpperCase()}</div>
                    <div class="logo-subtitle">${settings.siteSubtitle}</div>
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
                    ${settings.siteName} 账号
                    <span class="nav-badge" id="nav-accounts-count">${stats.total}</span>
                </a>
                <a href="#" class="nav-item" data-page="gemini">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    Gemini 账号
                    <span class="nav-badge" id="nav-gemini-count">${stats.gemini || 0}</span>
                </a>
                <a href="#" class="nav-item" data-page="orchids">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                        <path d="M2 17l10 5 10-5"/>
                        <path d="M2 12l10 5 10-5"/>
                    </svg>
                    Orchids 账号
                    <span class="nav-badge" id="nav-orchids-count">${stats.orchids || 0}</span>
                </a>
                <a href="#" class="nav-item" data-page="warp">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                    Warp 账号
                    <span class="nav-badge" id="nav-warp-count">${stats.warp || 0}</span>
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
                <a href="https://pay.ldxp.cn/shop/N0IK02WR" class="nav-item" target="_blank" rel="noopener noreferrer">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="9" cy="21" r="1"/>
                        <circle cx="20" cy="21" r="1"/>
                        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                    </svg>
                    号池购买
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
                <a href="#" class="nav-item" data-page="trial-admin">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                        <circle cx="8.5" cy="7" r="4"/>
                        <polyline points="17 11 19 13 23 9"/>
                    </svg>
                    试用审批
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
                <a href="#" class="nav-item" data-page="site-settings">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <line x1="3" y1="9" x2="21" y2="9"/>
                        <line x1="9" y1="21" x2="9" y2="9"/>
                    </svg>
                    站点设置
                </a>
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
            <div class="version-info">${settings.siteName} Manager v1.0.0</div>
        </div>
    </aside>
    `;
}

// ============ 更新侧边栏统计 ============
async function updateSidebarStats() {
    try {
        const [credRes, errorRes, geminiRes, warpRes] = await Promise.all([
            fetch('/api/credentials', { headers: { 'Authorization': `Bearer ${authToken}` } }),
            fetch('/api/error-credentials', { headers: { 'Authorization': `Bearer ${authToken}` } }),
            fetch('/api/gemini/credentials', { headers: { 'Authorization': `Bearer ${authToken}` } }),
            fetch('/api/warp/statistics', { headers: { 'Authorization': `Bearer ${authToken}` } })
        ]);

        const credResult = await credRes.json();
        const errorResult = await errorRes.json();
        const geminiResult = await geminiRes.json();
        const warpResult = await warpRes.json();

        const credentials = credResult.success ? credResult.data : [];
        const errors = errorResult.success ? errorResult.data : [];
        const geminiCredentials = geminiResult.success ? geminiResult.data : [];
        const warpStats = warpResult.success ? warpResult.data : { total: 0 };

        const total = credentials.length;
        const active = credentials.filter(c => c.isActive).length;
        const errorCount = errors.length;
        const geminiCount = geminiCredentials.length;
        const warpCount = warpStats.total || 0;

        // 更新侧边栏数字
        const totalEl = document.getElementById('stat-total');
        const activeEl = document.getElementById('stat-active');
        const navAccountsEl = document.getElementById('nav-accounts-count');
        const navErrorEl = document.getElementById('nav-error-count');
        const navGeminiEl = document.getElementById('nav-gemini-count');
        const navWarpEl = document.getElementById('nav-warp-count');

        if (totalEl) totalEl.textContent = total;
        if (activeEl) activeEl.textContent = active;
        if (navAccountsEl) navAccountsEl.textContent = total;
        if (navErrorEl) navErrorEl.textContent = errorCount;
        if (navGeminiEl) navGeminiEl.textContent = geminiCount;
        if (navWarpEl) navWarpEl.textContent = warpCount;

        return { total, active, error: errorCount, gemini: geminiCount, warp: warpCount };
    } catch (e) {
        console.error('Update sidebar stats error:', e);
        return { total: 0, active: 0, error: 0, gemini: 0, warp: 0 };
    }
}

// ============ 自动初始化站点设置 ============
// 页面加载时自动更新 title（使用缓存的设置）
(function() {
    const settings = window.siteSettings;
    // 从当前 title 中提取页面名称部分
    const currentTitle = document.title;
    const pageName = currentTitle.split(' - ')[0] || currentTitle;
    // 如果 title 包含 "Kiro"，替换为配置的站点名称
    if (currentTitle.includes('Kiro')) {
        document.title = currentTitle.replace(/Kiro/g, settings.siteName);
    }
})();

// 页面完全加载后，从服务器获取最新设置并更新
document.addEventListener('DOMContentLoaded', function() {
    // 延迟加载站点设置，避免阻塞页面渲染
    setTimeout(() => {
        loadSiteSettings();
    }, 100);
});
