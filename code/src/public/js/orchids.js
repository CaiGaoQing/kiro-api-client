// State
const OrchidsState = {
    credentials: [],
    selectedIds: new Set(),
    searchQuery: '',
    currentView: 'grid',
    contextMenuTarget: null,
    detailTarget: null,
    importTab: 'json',
    isLoading: false,
    healthStatus: {}, // 账号健康状态: { accountId: boolean }
    registerTaskId: null,
    registerEventSource: null
};

// DOM Elements
const DOM = {
    // Containers
    cardsGrid: null,
    listView: null,
    emptyState: null,
    loadingState: null,

    // Modals
    addModal: null,
    batchImportModal: null,
    detailModal: null,
    registerModal: null,

    // Stats
    statTotal: null,
    statValid: null,
    statExpiring: null,
    statError: null,
    statHealthy: null,
    statRequestCount: null,
    statSuccessCount: null,
    statFailureCount: null,

    // Form Elements
    searchInput: null
};

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
    // 生成并插入侧边栏
    const sidebarContainer = document.getElementById('sidebar-container');
    if (sidebarContainer && typeof getSidebarHTML === 'function') {
        sidebarContainer.innerHTML = getSidebarHTML();
    }
    
    // 初始化侧边栏导航
    if (typeof initSidebar === 'function') {
        initSidebar('orchids');
    }
    
    initDOMReferences();
    setupEventListeners();
    await loadCredentials();
    
    // 更新侧边栏统计
    if (typeof updateSidebarStats === 'function') {
        updateSidebarStats();
    }
});

function initDOMReferences() {
    DOM.cardsGrid = document.getElementById('cards-grid');
    DOM.listView = document.getElementById('list-view');
    DOM.emptyState = document.getElementById('empty-state');
    DOM.loadingState = document.getElementById('loading-state');

    DOM.addModal = document.getElementById('add-modal');
    DOM.batchImportModal = document.getElementById('batch-import-modal');
    DOM.detailModal = document.getElementById('detail-modal');
    DOM.registerModal = document.getElementById('register-modal');

    DOM.statTotal = document.getElementById('stat-total');
    DOM.statValid = document.getElementById('stat-valid');
    DOM.statExpiring = document.getElementById('stat-expiring');
    DOM.statError = document.getElementById('stat-error');
    DOM.statHealthy = document.getElementById('stat-healthy');
    DOM.statRequestCount = document.getElementById('stat-request-count');
    DOM.statSuccessCount = document.getElementById('stat-success-count');
    DOM.statFailureCount = document.getElementById('stat-failure-count');

    DOM.searchInput = document.getElementById('search-input');
}

// 认证检查（使用 common.js 的 checkAuth）
async function checkAuthAndRedirect() {
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

function setupEventListeners() {
    // Header Actions
    document.getElementById('add-account-btn')?.addEventListener('click', openAddModal);
    document.getElementById('batch-import-btn')?.addEventListener('click', openBatchImportModal);
    document.getElementById('empty-add-btn')?.addEventListener('click', openAddModal);
    document.getElementById('refresh-all-btn')?.addEventListener('click', handleRefreshAll);
    document.getElementById('export-btn')?.addEventListener('click', handleExport);
    document.getElementById('auto-register-btn')?.addEventListener('click', openRegisterModal);

    // Search
    DOM.searchInput?.addEventListener('input', (e) => {
        OrchidsState.searchQuery = e.target.value.trim().toLowerCase();
        renderCredentials();
    });

    // View Toggle
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const view = btn.dataset.view;
            OrchidsState.currentView = view;
            
            if (view === 'grid') {
                DOM.cardsGrid.style.display = 'grid';
                DOM.listView.style.display = 'none';
            } else {
                DOM.cardsGrid.style.display = 'none';
                DOM.listView.style.display = 'block';
            }
        });
    });

    // Modals
    document.getElementById('modal-close')?.addEventListener('click', closeAddModal);
    document.getElementById('modal-cancel')?.addEventListener('click', closeAddModal);
    document.getElementById('add-account-form')?.addEventListener('submit', handleAddAccount);

    document.getElementById('batch-modal-close')?.addEventListener('click', closeBatchImportModal);
    document.getElementById('batch-cancel')?.addEventListener('click', closeBatchImportModal);
    document.getElementById('batch-import-form')?.addEventListener('submit', handleBatchImport);

    document.getElementById('detail-modal-close')?.addEventListener('click', closeDetailModal);
    document.getElementById('detail-delete-btn')?.addEventListener('click', handleDeleteAccount);
    document.getElementById('detail-edit-weight-btn')?.addEventListener('click', handleEditWeight);
    document.getElementById('detail-reset-stats-btn')?.addEventListener('click', handleResetStats);

    // Register Modal
    document.getElementById('register-modal-close')?.addEventListener('click', closeRegisterModal);
    document.getElementById('register-modal-cancel')?.addEventListener('click', closeRegisterModal);
    document.getElementById('register-start-btn')?.addEventListener('click', startRegister);
    document.getElementById('register-cancel-btn')?.addEventListener('click', cancelRegister);

    // Outside click
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            if (e.target.id === 'add-modal') closeAddModal();
            if (e.target.id === 'batch-import-modal') closeBatchImportModal();
            if (e.target.id === 'detail-modal') closeDetailModal();
            if (e.target.id === 'register-modal' && !OrchidsState.registerTaskId) closeRegisterModal();
        }
    });

    // Paste JWT
    document.getElementById('paste-jwt-btn')?.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            document.getElementById('client-jwt').value = text;
        } catch (err) {
            showToast('无法读取剪贴板', 'error');
        }
    });

    // Import Tabs
    document.querySelectorAll('.import-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            OrchidsState.importTab = tab.dataset.tab;
            
            document.getElementById('json-panel').classList.toggle('active', tab.dataset.tab === 'json');
            document.getElementById('text-panel').classList.toggle('active', tab.dataset.tab === 'text');
        });
    });
}

// Data Loading
async function loadCredentials() {
    setLoading(true);
    try {
        const response = await fetch('/api/orchids/credentials', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) throw new Error('加载失败');

        const data = await response.json();
        // 兼容不同的返回格式
        OrchidsState.credentials = Array.isArray(data) ? data : (data.data || []);
        
        renderCredentials();
        updateStats();
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        setLoading(false);
    }
}

// Rendering
function renderCredentials() {
    const query = OrchidsState.searchQuery;
    const filtered = OrchidsState.credentials.filter(cred => {
        if (!query) return true;
        return (cred.name && cred.name.toLowerCase().includes(query)) || 
               (cred.email && cred.email.toLowerCase().includes(query));
    });

    if (filtered.length === 0) {
        DOM.emptyState.style.display = 'block';
        DOM.cardsGrid.style.display = 'none';
        DOM.listView.style.display = 'none';
        return;
    }

    DOM.emptyState.style.display = 'none';
    
    // Grid View
    DOM.cardsGrid.innerHTML = filtered.map(createCardHTML).join('');
    
    // List View
    DOM.listView.innerHTML = filtered.map(createListItemHTML).join('');

    if (OrchidsState.currentView === 'grid') {
        DOM.cardsGrid.style.display = 'grid';
        DOM.listView.style.display = 'none';
    } else {
        DOM.cardsGrid.style.display = 'none';
        DOM.listView.style.display = 'block';
    }
}

function createCardHTML(cred) {
    const isHealthy = OrchidsState.healthStatus[cred.id] !== false;
    const statusClass = !cred.isActive ? 'disabled' : (isHealthy ? 'healthy' : 'error');
    const statusText = !cred.isActive ? '已禁用' : (isHealthy ? '正常' : '异常');
    const statusDot = isHealthy ? '🟢' : '🔴';

    return `
        <div class="orchids-card ${statusClass}" onclick="openDetailModal(${cred.id})">
            <div class="orchids-card-header">
                <div class="orchids-name" title="${escapeHtml(cred.name)}">${escapeHtml(cred.name)}</div>
                <div class="orchids-status ${statusClass}">${statusText}</div>
            </div>
            <div class="orchids-card-body">
                        <div class="orchids-detail-item">
                    <span class="orchids-detail-label">邮箱</span>
                    <span class="orchids-detail-value" title="${escapeHtml(cred.email)}">${escapeHtml(cred.email || '-')}</span>
                        </div>
                    <div class="orchids-detail-item">
                        <span class="orchids-detail-label">过期时间</span>
                    <span class="orchids-detail-value">${formatDate(cred.expiresAt)}</span>
                    </div>
                        <div class="orchids-detail-item">
                    <span class="orchids-detail-label">权重</span>
                    <span class="orchids-detail-value">${cred.weight || 1}</span>
                        </div>
                    <div class="orchids-detail-item">
                    <span class="orchids-detail-label">请求数</span>
                    <span class="orchids-detail-value">${cred.requestCount || 0}</span>
                    </div>
                <div class="orchids-detail-item">
                    <span class="orchids-detail-label">成功/失败</span>
                    <span class="orchids-detail-value success">${cred.successCount || 0}</span>
                    <span class="orchids-detail-value error">/${cred.failureCount || 0}</span>
                </div>
            </div>
        </div>
    `;
}

function createListItemHTML(cred) {
    // Similar to card but row layout - simplified for now
    return createCardHTML(cred); 
}

// Modal Functions
function openAddModal() { DOM.addModal.classList.add('active'); }
function closeAddModal() {
    DOM.addModal.classList.remove('active'); 
    document.getElementById('add-account-form').reset();
}

function openBatchImportModal() { DOM.batchImportModal.classList.add('active'); }
function closeBatchImportModal() { DOM.batchImportModal.classList.remove('active'); }

function openDetailModal(id) {
    const cred = OrchidsState.credentials.find(c => c.id === id);
    if (!cred) return;

    OrchidsState.detailTarget = cred;
    
    document.getElementById('detail-name').textContent = cred.name;
    document.getElementById('detail-email').textContent = cred.email || '-';
    document.getElementById('detail-weight').textContent = cred.weight || 1;
    document.getElementById('detail-request-count').textContent = cred.requestCount || 0;
    document.getElementById('detail-success-count').textContent = cred.successCount || 0;
    document.getElementById('detail-failure-count').textContent = cred.failureCount || 0;
    
    const isHealthy = OrchidsState.healthStatus[cred.id] !== false;
    const statusText = !cred.isActive ? '已禁用' : (isHealthy ? '正常' : '异常');
    const statusClass = !cred.isActive ? 'disabled' : (isHealthy ? 'success' : 'error');
    
    const statusEl = document.getElementById('detail-status');
    statusEl.textContent = statusText;
    statusEl.className = `detail-value ${statusClass}`;

    DOM.detailModal.classList.add('active');
}

function closeDetailModal() {
    DOM.detailModal.classList.remove('active');
    OrchidsState.detailTarget = null;
}

// API Actions
async function handleAddAccount(e) {
    e.preventDefault();
    const jwt = document.getElementById('client-jwt').value.trim();
    const name = document.getElementById('account-name').value.trim();
    const weight = parseInt(document.getElementById('account-weight').value) || 1;

    if (!jwt) return showToast('请输入 Client Cookie', 'error');

    setLoading(true);
    try {
        const response = await fetch('/api/orchids/credentials', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({ client_cookie: jwt, name, weight })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '添加失败');

        showToast('账号添加成功', 'success');
        closeAddModal();
        await loadCredentials();
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        setLoading(false);
    }
}

async function handleDeleteAccount() {
    if (!OrchidsState.detailTarget) return;
    if (!confirm(`确定要删除账号 "${OrchidsState.detailTarget.name}" 吗？`)) return;

    try {
        await fetch(`/api/orchids/credentials/${OrchidsState.detailTarget.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        showToast('删除成功', 'success');
        closeDetailModal();
        await loadCredentials();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function handleEditWeight() {
    if (!OrchidsState.detailTarget) return;
    const newWeight = prompt(`请输入新权重 (当前: ${OrchidsState.detailTarget.weight}):`, OrchidsState.detailTarget.weight);
    if (newWeight === null) return;
    
    const weight = parseInt(newWeight);
    if (isNaN(weight) || weight < 1) return showToast('无效权重', 'error');

    try {
        await fetch(`/api/orchids/credentials/${OrchidsState.detailTarget.id}/weight`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({ weight })
        });
        showToast('权重更新成功', 'success');
        closeDetailModal();
        await loadCredentials();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function handleResetStats() {
    if (!OrchidsState.detailTarget) return;
    if (!confirm('确定重置统计数据？')) return;

    try {
        await fetch(`/api/orchids/credentials/${OrchidsState.detailTarget.id}/reset-stats`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        showToast('统计已重置', 'success');
        closeDetailModal();
        await loadCredentials();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function handleBatchImport(e) {
    e.preventDefault();
    const type = OrchidsState.importTab;
    const content = type === 'json' 
        ? document.getElementById('batch-import-json').value 
        : document.getElementById('batch-import-text').value;

    if (!content.trim()) return showToast('请输入要导入的数据', 'error');

    let accounts = [];
    try {
        if (type === 'json') {
            accounts = JSON.parse(content);
            if (!Array.isArray(accounts)) throw new Error('JSON必须是数组格式');
        } else {
            accounts = content.split('\n')
                .filter(line => line.trim())
        .map(line => {
                    const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                return { email: parts[0], clientJwt: parts[1] };
            }
            return null;
        })
        .filter(Boolean);
        }
    } catch (err) {
        return showToast('数据格式错误: ' + err.message, 'error');
}

    setLoading(true);
    try {
        const response = await fetch('/api/orchids/credentials/batch', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({ accounts })
        });

        const result = await response.json();
        if (result.success) {
            showToast(`成功导入 ${result.count} 个账号`, 'success');
            closeBatchImportModal();
            await loadCredentials();
        } else {
            showToast(result.error || '导入失败', 'error');
        }
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        setLoading(false);
    }
}

function handleRefreshAll() {
    if(!confirm('确定刷新所有账号？')) return;
    fetch('/api/orchids/refresh-all', {
        method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
    }).then(() => {
        showToast('刷新任务已启动', 'success');
        setTimeout(loadCredentials, 2000);
    }).catch(e => showToast(e.message, 'error'));
}

function handleExport() {
    window.location.href = `/api/orchids/export?token=${localStorage.getItem('authToken')}`;
}

// Stats
async function updateStats() {
    const list = OrchidsState.credentials;
    const total = list.length;
    const valid = list.filter(c => c.isActive).length;
    const now = new Date();
    const expiring = list.filter(c => c.expiresAt && (new Date(c.expiresAt) - now) < (1000 * 60 * 60 * 24 * 3)).length;
    
    // Fetch real health status
    let healthData = { accounts: [] };
    try {
        const res = await fetch('/api/orchids/credentials/health', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        if (res.ok) healthData = await res.json();
    } catch (e) { console.error(e); }
    
    OrchidsState.healthStatus = {};
    healthData.accounts.forEach(h => OrchidsState.healthStatus[h.account_id] = h.is_healthy);
    
    const healthy = list.filter(c => OrchidsState.healthStatus[c.id] === true).length;
    const error = list.filter(c => OrchidsState.healthStatus[c.id] === false || c.errorCount > 0).length;
    
    const req = list.reduce((s, c) => s + (c.requestCount || 0), 0);
    const succ = list.reduce((s, c) => s + (c.successCount || 0), 0);
    const fail = list.reduce((s, c) => s + (c.failureCount || 0), 0);
    
    if (DOM.statTotal) DOM.statTotal.textContent = total;
    if (DOM.statValid) DOM.statValid.textContent = valid;
    if (DOM.statExpiring) DOM.statExpiring.textContent = expiring;
    if (DOM.statError) DOM.statError.textContent = error;
    if (DOM.statHealthy) DOM.statHealthy.textContent = healthy;
    if (DOM.statRequestCount) DOM.statRequestCount.textContent = req;
    if (DOM.statSuccessCount) DOM.statSuccessCount.textContent = succ;
    if (DOM.statFailureCount) DOM.statFailureCount.textContent = fail;
}

// Utils
function setLoading(show) {
    if (DOM.loadingState) DOM.loadingState.style.display = show ? 'flex' : 'none';
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString();
}

// Auto Register (Retained)
function openRegisterModal() {
    document.getElementById('register-count').value = '1';
    document.getElementById('register-config').style.display = 'block';
    document.getElementById('register-progress').style.display = 'none';
    document.getElementById('register-start-btn').style.display = 'inline-flex';
    document.getElementById('register-cancel-btn').style.display = 'none';
    document.getElementById('register-logs').innerHTML = '';
    DOM.registerModal?.classList.add('active');
}

function closeRegisterModal() {
    if (OrchidsState.registerTaskId && !confirm('确定关闭？')) return;
    if (OrchidsState.registerEventSource) {
        OrchidsState.registerEventSource.close();
        OrchidsState.registerEventSource = null;
    }
    DOM.registerModal?.classList.remove('active');
    OrchidsState.registerTaskId = null;
}

async function startRegister() {
    const count = parseInt(document.getElementById('register-count').value) || 1;
    try {
        const res = await fetch('/api/orchids/register/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({ count })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        OrchidsState.registerTaskId = data.taskId;
        document.getElementById('register-config').style.display = 'none';
        document.getElementById('register-progress').style.display = 'block';
        document.getElementById('register-start-btn').style.display = 'none';
        document.getElementById('register-cancel-btn').style.display = 'inline-flex';
        
        startRegisterStream(data.taskId);
    } catch (e) { showToast(e.message, 'error'); }
}

function startRegisterStream(taskId) {
    const logsContainer = document.getElementById('register-logs');
    OrchidsState.registerEventSource = new EventSource(`/api/orchids/register/stream/${taskId}`);
    
    OrchidsState.registerEventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            document.getElementById('progress-current').textContent = data.progress;
            document.getElementById('progress-success').textContent = data.success;
            document.getElementById('progress-failed').textContent = data.failed;
            
            const percent = data.count > 0 ? Math.round((data.progress / data.count) * 100) : 0;
            document.getElementById('progress-bar').style.width = `${percent}%`;
            document.getElementById('progress-status').textContent = data.status;
            
            if (data.newLogs) {
                data.newLogs.forEach(log => {
                    const div = document.createElement('div');
                    div.className = `register-log ${log.level.toLowerCase()}`;
                    div.innerHTML = `<span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span> ${log.message}`;
                    logsContainer.appendChild(div);
                });
                logsContainer.scrollTop = logsContainer.scrollHeight;
            }
            
            if (['completed', 'error', 'cancelled'].includes(data.status)) {
                OrchidsState.registerEventSource.close();
                document.getElementById('register-cancel-btn').style.display = 'none';
                if (data.status === 'completed') loadCredentials();
            }
        } catch (e) { console.error(e); }
    };
}

async function cancelRegister() {
    if (!OrchidsState.registerTaskId) return;
    try {
        await fetch(`/api/orchids/register/cancel/${OrchidsState.registerTaskId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
    } catch (e) { showToast(e.message, 'error'); }
}
