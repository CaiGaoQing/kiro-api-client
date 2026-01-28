// Gemini 账号管理页面 JS

let credentials = [];
let filteredCredentials = [];
let selectedIds = new Set();
let contextMenuTarget = null;
let usageCache = {}; // 用量缓存

document.addEventListener('DOMContentLoaded', async () => {
    // 检查登录状态
    if (!authToken) {
        window.location.href = '/login.html';
        return;
    }

    // 初始化侧边栏
    document.getElementById('sidebar-container').innerHTML = getSidebarHTML();
    initSidebar('gemini');
    updateSidebarStats();

    // 加载数据
    await loadCredentials();

    // 绑定事件
    bindEvents();

    // 不自动加载用量，改为手动刷新
    // loadAllUsage();
});

// ============ 数据加载 ============
async function loadCredentials() {
    try {
        const response = await fetch('/api/gemini/credentials', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const result = await response.json();

        if (result.success) {
            credentials = result.data;
            filteredCredentials = [...credentials];
            renderCards();
            updateCounts();
        } else {
            showToast('加载失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('加载失败: ' + error.message, 'error');
    }
}

// ============ 渲染卡片 ============
function renderCards() {
    const grid = document.getElementById('cards-grid');
    const emptyState = document.getElementById('empty-state');

    if (filteredCredentials.length === 0) {
        grid.innerHTML = '';
        emptyState.style.display = 'flex';
        return;
    }

    emptyState.style.display = 'none';
    grid.innerHTML = filteredCredentials.map(cred => createCardHTML(cred)).join('');

    // 绑定卡片事件
    grid.querySelectorAll('.account-card').forEach(card => {
        card.addEventListener('contextmenu', handleContextMenu);
        const id = parseInt(card.dataset.id);

        // 复选框事件
        const checkbox = card.querySelector('.card-checkbox input');
        if (checkbox) {
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                if (e.target.checked) {
                    selectedIds.add(id);
                    card.classList.add('selected');
                } else {
                    selectedIds.delete(id);
                    card.classList.remove('selected');
                }
                updateSelectionUI();
            });
        }

        // 刷新额度按钮事件
        const refreshUsageBtn = card.querySelector('.btn-refresh-usage');
        if (refreshUsageBtn) {
            refreshUsageBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                refreshSingleUsage(id);
            });
        }

        // 刷新模型按钮事件
        const refreshModelsBtn = card.querySelector('.btn-refresh-models');
        if (refreshModelsBtn) {
            refreshModelsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                refreshSingleUsage(id);
            });
        }
    });
}

function createCardHTML(cred) {
    const isSelected = selectedIds.has(cred.id);
    const usage = usageCache[cred.id];
    const displayName = cred.email || cred.name || 'Unknown';

    // 截断显示名称
    const truncateName = (name, maxLen) => {
        if (name.length <= maxLen) return name;
        const atIndex = name.indexOf('@');
        if (atIndex === -1) return name.substring(0, maxLen - 3) + '...';
        const prefix = name.substring(0, atIndex);
        const domain = name.substring(atIndex);
        if (domain.length >= maxLen - 3) {
            return prefix.substring(0, 3) + '...' + domain.substring(0, maxLen - 6);
        }
        const availableLen = maxLen - domain.length - 3;
        if (availableLen <= 0) return name.substring(0, maxLen - 3) + '...';
        return prefix.substring(0, availableLen) + '...' + domain;
    };
    const shortName = truncateName(displayName, 28);

    return `
        <div class="account-card gemini-card ${isSelected ? 'selected' : ''}" data-id="${cred.id}">
            <div class="card-header">
                <div class="card-checkbox">
                    <input type="checkbox" class="checkbox-custom card-checkbox" ${isSelected ? 'checked' : ''}>
                </div>
                <div class="card-title">
                    <span class="card-email" title="${escapeHtml(displayName)}">${escapeHtml(shortName)}</span>
                    ${cred.isActive ? '<span class="pro-badge">活跃</span>' : ''}
                </div>
            </div>
            <div class="card-models" data-id="${cred.id}">
                ${generateModelTagsHTML(usage)}
            </div>
            <div class="card-footer">
                <span class="card-date">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    ${formatDateShort(cred.createdAt)}
                </span>
                <div class="card-actions">
                    <button class="action-btn" title="详情" onclick="event.stopPropagation(); showCredentialDetail(${cred.id})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <path d="M12 16v-4"/>
                            <path d="M12 8h.01"/>
                        </svg>
                    </button>
                    <button class="action-btn" title="对话" onclick="event.stopPropagation(); openChat(${cred.id})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                    </button>
                    <button class="action-btn" title="刷新Token" onclick="event.stopPropagation(); refreshToken(${cred.id})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="23 4 23 10 17 10"/>
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                        </svg>
                    </button>
                    <button class="action-btn ${cred.isActive ? 'active' : ''}" title="${cred.isActive ? '当前活跃' : '设为活跃'}" onclick="event.stopPropagation(); activateCredential(${cred.id})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                            <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                    </button>
                    <button class="action-btn danger" title="删除" onclick="event.stopPropagation(); deleteCredential(${cred.id})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    `;
}

// 生成模型标签网格 HTML
function generateModelTagsHTML(usage) {
    if (!usage || !usage.models || Object.keys(usage.models).length === 0) {
        return `<div class="model-tags-empty">
            <span class="empty-text">点击刷新查看模型额度</span>
            <button class="btn-refresh-models" onclick="event.stopPropagation();">刷新</button>
        </div>`;
    }

    const models = usage.models;
    const modelNames = Object.keys(models);

    let tagsHTML = '<div class="model-tags-grid">';
    for (const modelName of modelNames) {
        const modelInfo = models[modelName];
        const remaining = modelInfo.remaining || 0;
        const remainingPercent = Math.round(remaining * 100);
        const statusClass = remainingPercent < 20 ? 'danger' : remainingPercent < 50 ? 'warning' : 'success';

        // 简化模型名称
        let shortName = modelName
            .replace('gemini-', 'G')
            .replace('-preview', '')
            .replace('-latest', '')
            .replace('2.0-flash-exp', '2 Fla...')
            .replace('2.0-pro-exp', '2 Pro')
            .replace('1.5-pro', '1.5 Pro')
            .replace('1.5-flash', '1.5 Fla...')
            .replace('-thinking-exp', ' Think')
            .replace('exp-', '')
            .replace('imagen-3.0-generate-002', 'G3 Ima...')
            .replace('claude-3-5-sonnet', 'Claude...');

        if (shortName.length > 10) {
            shortName = shortName.substring(0, 8) + '...';
        }

        // 格式化重置时间
        let resetText = '';
        if (modelInfo.resetTime) {
            const resetDate = new Date(modelInfo.resetTime);
            const now = new Date();
            const diffMs = resetDate - now;
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            if (diffMs < 0) {
                resetText = '已重置';
            } else if (diffDays > 0) {
                resetText = diffDays + 'd ' + diffHours + 'h';
            } else if (diffHours > 0) {
                resetText = diffHours + 'h ' + diffMins + 'm';
            } else {
                resetText = diffMins + 'm';
            }
        }

        tagsHTML += `
            <div class="model-tag ${statusClass}" title="${modelName}">
                <span class="model-name">${shortName}</span>
                <span class="model-reset"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${resetText}</span>
                <span class="model-percent">${remainingPercent}%</span>
            </div>
        `;
    }
    tagsHTML += '</div>';

    return tagsHTML;
}

// 显示凭证详情
function showCredentialDetail(id) {
    const cred = credentials.find(c => c.id === id);
    if (!cred) return;

    // TODO: 实现详情弹窗
    showToast('详情功能开发中', 'info');
}

// 格式化日期（短格式）
function formatDateShort(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).replace(/\//g, '/');
}

// ============ 事件绑定 ============
function bindEvents() {
    // 添加账号按钮
    document.getElementById('add-account-btn').addEventListener('click', openAddModal);
    document.getElementById('empty-add-btn')?.addEventListener('click', openAddModal);

    // 批量导入按钮
    document.getElementById('batch-import-btn')?.addEventListener('click', openBatchImportModal);

    // 添加账号模态框
    document.getElementById('modal-close').addEventListener('click', closeAddModal);
    document.getElementById('modal-cancel').addEventListener('click', closeAddModal);
    document.getElementById('modal-submit').addEventListener('click', submitAddForm);

    // 批量导入模态框
    document.getElementById('batch-modal-close')?.addEventListener('click', closeBatchImportModal);
    document.getElementById('batch-modal-cancel')?.addEventListener('click', closeBatchImportModal);
    document.getElementById('batch-modal-submit')?.addEventListener('click', submitBatchImport);

    // 批量刷新
    document.getElementById('refresh-all-btn').addEventListener('click', refreshAllTokens);

    // 全选
    document.getElementById('select-all')?.addEventListener('change', handleSelectAll);

    // 批量删除
    document.getElementById('batch-delete-btn')?.addEventListener('click', batchDelete);

    // 搜索
    document.getElementById('search-input').addEventListener('input', handleSearch);

    // 右键菜单
    document.addEventListener('click', () => {
        document.getElementById('context-menu').style.display = 'none';
    });

    document.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', handleContextMenuAction);
    });

    // ESC 关闭模态框
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAddModal();
            closeBatchImportModal();
        }
    });
}

// ============ 模态框 ============
function openAddModal() {
    document.getElementById('add-modal').classList.add('active');
    document.getElementById('add-account-form').reset();
}

function closeAddModal() {
    document.getElementById('add-modal').classList.remove('active');
}

function openBatchImportModal() {
    const modal = document.getElementById('batch-import-modal');
    if (modal) {
        modal.classList.add('active');
        document.getElementById('batch-json').value = '';
    }
}

function closeBatchImportModal() {
    const modal = document.getElementById('batch-import-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function submitAddForm() {
    const name = document.getElementById('account-name').value.trim();
    const email = document.getElementById('account-email').value.trim();
    const accessToken = document.getElementById('access-token').value.trim();
    const refreshToken = document.getElementById('refresh-token').value.trim();
    const projectId = document.getElementById('project-id').value.trim();

    if (!name || !accessToken) {
        showToast('请填写名称和 Access Token', 'error');
        return;
    }

    const submitBtn = document.getElementById('modal-submit');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="loading-spinner"></span> 添加中...';

    try {
        const response = await fetch('/api/gemini/credentials', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ name, email, accessToken, refreshToken, projectId })
        });

        const result = await response.json();
        if (result.success) {
            showToast('添加成功', 'success');
            closeAddModal();
            await loadCredentials();
            updateSidebarStats();
        } else {
            showToast('添加失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('添加失败: ' + error.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
            <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            添加账号
        `;
    }
}

async function submitBatchImport() {
    const jsonText = document.getElementById('batch-json').value.trim();

    if (!jsonText) {
        showToast('请输入账号数据', 'error');
        return;
    }

    let accounts = [];
    try {
        // 尝试解析为 JSON
        if (jsonText.startsWith('[')) {
            accounts = JSON.parse(jsonText);
        } else {
            // 文本格式解析：每行一个账号，格式为 "name email accessToken refreshToken projectId"
            const lines = jsonText.split('\n').filter(line => line.trim());
            accounts = lines.map(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    return {
                        name: parts[0],
                        email: parts[0].includes('@') ? parts[0] : '',
                        accessToken: parts[1],
                        refreshToken: parts[2] || '',
                        projectId: parts[3] || ''
                    };
                }
                return null;
            }).filter(Boolean);
        }
    } catch (e) {
        showToast('数据格式错误: ' + e.message, 'error');
        return;
    }

    if (accounts.length === 0) {
        showToast('没有有效的账号数据', 'error');
        return;
    }

    const submitBtn = document.getElementById('batch-modal-submit');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="loading-spinner"></span> 导入中...';

    let success = 0, failed = 0;
    for (const account of accounts) {
        try {
            const response = await fetch('/api/gemini/credentials', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify(account)
            });
            const result = await response.json();
            if (result.success) success++;
            else failed++;
        } catch {
            failed++;
        }
    }

    showToast(`导入完成: ${success} 成功, ${failed} 失败`, success > 0 ? 'success' : 'error');
    closeBatchImportModal();
    await loadCredentials();
    updateSidebarStats();

    submitBtn.disabled = false;
    submitBtn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        导入
    `;
}

// ============ 操作函数 ============
function openChat(id) {
    window.location.href = '/pages/chat.html?gemini=' + id;
}

async function refreshToken(id) {
    showToast('正在刷新 Token...', 'info');
    try {
        const response = await fetch(`/api/gemini/credentials/${id}/refresh`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const result = await response.json();
        if (result.success) {
            showToast('Token 刷新成功', 'success');
            await loadCredentials();
        } else {
            showToast('刷新失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('刷新失败: ' + error.message, 'error');
    }
}

async function testCredential(id) {
    showToast('正在测试连接...', 'info');
    try {
        const response = await fetch(`/api/gemini/credentials/${id}/test`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const result = await response.json();
        if (result.success) {
            const modelCount = result.data?.models?.length || 0;
            showToast(`测试成功${modelCount > 0 ? `，支持 ${modelCount} 个模型` : ''}`, 'success');
            await loadCredentials();
        } else {
            showToast('测试失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('测试失败: ' + error.message, 'error');
    }
}

async function deleteCredential(id) {
    if (!confirm('确定要删除这个账号吗？')) return;

    try {
        const response = await fetch(`/api/gemini/credentials/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const result = await response.json();
        if (result.success) {
            showToast('删除成功', 'success');
            selectedIds.delete(id);
            await loadCredentials();
            updateSidebarStats();
        } else {
            showToast('删除失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
    }
}

async function activateCredential(id) {
    try {
        const response = await fetch(`/api/gemini/credentials/${id}/activate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const result = await response.json();
        if (result.success) {
            showToast('已设为活跃', 'success');
            await loadCredentials();
        } else {
            showToast('操作失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('操作失败: ' + error.message, 'error');
    }
}

async function refreshAllTokens() {
    if (credentials.length === 0) {
        showToast('没有可刷新的账号', 'warning');
        return;
    }

    const btn = document.getElementById('refresh-all-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> 刷新中...';

    showToast(`正在刷新 ${credentials.length} 个账号...`, 'info');

    let success = 0, failed = 0;
    for (const cred of credentials) {
        try {
            const response = await fetch(`/api/gemini/credentials/${cred.id}/refresh`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            const result = await response.json();
            if (result.success) success++;
            else failed++;
        } catch {
            failed++;
        }
    }

    showToast(`刷新完成: ${success} 成功, ${failed} 失败`, success > 0 ? 'success' : 'error');
    await loadCredentials();

    btn.disabled = false;
    btn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        批量刷新Token
    `;
}

// ============ 选择功能 ============
function handleSelectAll(e) {
    const isChecked = e.target.checked;
    if (isChecked) {
        filteredCredentials.forEach(c => selectedIds.add(c.id));
    } else {
        selectedIds.clear();
    }
    renderCards();
    updateSelectionUI();
}

function updateSelectionUI() {
    const selectAllCheckbox = document.getElementById('select-all');
    const batchDeleteBtn = document.getElementById('batch-delete-btn');

    if (selectAllCheckbox) {
        selectAllCheckbox.checked = selectedIds.size > 0 && selectedIds.size === filteredCredentials.length;
        selectAllCheckbox.indeterminate = selectedIds.size > 0 && selectedIds.size < filteredCredentials.length;
    }

    if (batchDeleteBtn) {
        batchDeleteBtn.style.display = selectedIds.size > 0 ? 'inline-flex' : 'none';
    }
}

async function batchDelete() {
    if (selectedIds.size === 0) return;

    if (!confirm(`确定要删除选中的 ${selectedIds.size} 个账号吗？`)) return;

    const btn = document.getElementById('batch-delete-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> 删除中...';

    let success = 0, failed = 0;
    for (const id of selectedIds) {
        try {
            const response = await fetch(`/api/gemini/credentials/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            const result = await response.json();
            if (result.success) success++;
            else failed++;
        } catch {
            failed++;
        }
    }

    showToast(`删除完成: ${success} 成功, ${failed} 失败`, success > 0 ? 'success' : 'error');
    selectedIds.clear();
    await loadCredentials();
    updateSidebarStats();
    updateSelectionUI();

    btn.disabled = false;
    btn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
        批量删除
    `;
}

// ============ 搜索 ============
function handleSearch(e) {
    const query = e.target.value.toLowerCase().trim();
    if (!query) {
        filteredCredentials = [...credentials];
    } else {
        filteredCredentials = credentials.filter(c =>
            c.name.toLowerCase().includes(query) ||
            (c.email && c.email.toLowerCase().includes(query)) ||
            (c.projectId && c.projectId.toLowerCase().includes(query))
        );
    }
    renderCards();
    updateCounts();
}

// ============ 右键菜单 ============
function handleContextMenu(e) {
    e.preventDefault();
    const card = e.currentTarget;
    contextMenuTarget = parseInt(card.dataset.id);

    const menu = document.getElementById('context-menu');
    menu.style.display = 'block';
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';

    // 确保菜单不超出视口
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = (e.pageX - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = (e.pageY - rect.height) + 'px';
    }
}

function handleContextMenuAction(e) {
    const action = e.currentTarget.dataset.action;
    if (!contextMenuTarget) return;

    switch (action) {
        case 'chat':
            openChat(contextMenuTarget);
            break;
        case 'activate':
            activateCredential(contextMenuTarget);
            break;
        case 'refresh':
            refreshToken(contextMenuTarget);
            break;
        case 'test':
            testCredential(contextMenuTarget);
            break;
        case 'delete':
            deleteCredential(contextMenuTarget);
            break;
    }

    document.getElementById('context-menu').style.display = 'none';
    contextMenuTarget = null;
}

// ============ 工具函数 ============
function updateCounts() {
    document.getElementById('displayed-count').textContent = filteredCredentials.length;
    updateStatsCards();
}

// 更新统计卡片
function updateStatsCards() {
    const totalAccounts = credentials.length;
    const activeAccounts = credentials.filter(c => c.isActive).length;

    // 统计可用模型数和平均额度
    let totalModels = new Set();
    let totalQuotaPercent = 0;
    let accountsWithUsage = 0;

    for (const cred of credentials) {
        const usage = usageCache[cred.id];
        if (usage && usage.models) {
            const models = Object.keys(usage.models);
            models.forEach(m => totalModels.add(m));

            // 计算平均额度
            let avgRemaining = 0;
            models.forEach(m => {
                avgRemaining += (usage.models[m].remaining || 0);
            });
            if (models.length > 0) {
                totalQuotaPercent += (avgRemaining / models.length) * 100;
                accountsWithUsage++;
            }
        }
    }

    const avgQuota = accountsWithUsage > 0 ? Math.round(totalQuotaPercent / accountsWithUsage) : 0;

    document.getElementById('stat-total-accounts').textContent = totalAccounts;
    document.getElementById('stat-active-accounts').textContent = activeAccounts;
    document.getElementById('stat-total-models').textContent = totalModels.size;
    document.getElementById('stat-avg-quota').textContent = accountsWithUsage > 0 ? avgQuota + '%' : '-';
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDate(dateStr) {
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

function isExpiringSoon(dateStr) {
    if (!dateStr) return false;
    const expiresAt = new Date(dateStr);
    const now = new Date();
    const hoursDiff = (expiresAt - now) / (1000 * 60 * 60);
    return hoursDiff < 24 && hoursDiff > 0;
}

// ============ 额度显示功能 ============

// 生成额度显示 HTML
function generateUsageHTML(usage) {
    if (!usage) {
        return `<div class="usage-header" style="display: flex; justify-content: space-between; align-items: center;">
            <span class="usage-label">模型额度</span>
            <button class="btn-refresh-usage" style="background: none; border: none; color: var(--accent-primary); cursor: pointer; font-size: 12px; padding: 2px 8px;">点击查看</button>
        </div>`;
    }

    // Gemini 返回的是 models 对象，包含每个模型的 remaining
    const models = usage.models || {};
    const modelNames = Object.keys(models);

    if (modelNames.length === 0) {
        return `<div class="usage-header" style="display: flex; justify-content: space-between; align-items: center;">
            <span class="usage-label">模型额度</span>
            <button class="btn-refresh-usage" style="background: none; border: none; color: var(--accent-primary); cursor: pointer; font-size: 12px; padding: 2px 8px;">点击查看</button>
        </div>`;
    }

    // 生成每个模型的额度显示
    let modelsHTML = '';
    for (const modelName of modelNames) {
        const modelInfo = models[modelName];
        const remaining = modelInfo.remaining || 0;
        const remainingPercent = Math.round(remaining * 100);
        const usedPercent = 100 - remainingPercent;
        const usageClass = usedPercent > 80 ? 'danger' : usedPercent > 50 ? 'warning' : '';

        // 简化模型名称显示
        const shortName = modelName.replace('gemini-', '').replace('-preview', '');

        // 格式化重置时间
        let resetText = '';
        if (modelInfo.resetTime) {
            const resetDate = new Date(modelInfo.resetTime);
            const now = new Date();
            const diffMs = resetDate - now;
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            if (diffMs < 0) {
                resetText = '已重置';
            } else if (diffDays > 0) {
                resetText = diffDays + '天后';
            } else {
                resetText = diffHours + '小时后';
            }
        }

        modelsHTML += '<div class="model-usage-item" style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px;">' +
            '<span class="model-name" style="flex: 0 0 160px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + modelName + '">' + shortName + '</span>' +
            '<div class="usage-bar" style="flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden;">' +
            '<div class="usage-bar-fill ' + usageClass + '" style="width: ' + usedPercent + '%; height: 100%;"></div>' +
            '</div>' +
            '<span class="model-remaining ' + usageClass + '" style="flex: 0 0 40px; text-align: right;">' + remainingPercent + '%</span>' +
            '<span class="model-reset" style="flex: 0 0 50px; text-align: right; color: var(--text-muted); font-size: 11px;">' + resetText + '</span>' +
            '</div>';
    }

    return '<div class="usage-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
        '<span class="usage-label">模型额度 (' + modelNames.length + '个)</span>' +
        '<button class="btn-refresh-usage" style="background: none; border: none; color: var(--accent-primary); cursor: pointer; font-size: 12px; padding: 2px 8px;">刷新</button>' +
        '</div>' +
        '<div class="models-usage-list">' + modelsHTML + '</div>';
}

// 异步加载所有账号的额度
async function loadAllUsage() {
    for (const cred of credentials) {
        refreshSingleUsage(cred.id, false);
    }
}

// 刷新单个账号的额度
async function refreshSingleUsage(id, showToastMsg = true) {
    const modelsSection = document.querySelector(`.card-models[data-id="${id}"]`);
    if (modelsSection) {
        modelsSection.innerHTML = `<div class="model-tags-empty">
            <span class="empty-text">加载中...</span>
        </div>`;
    }

    try {
        const response = await fetch(`/api/gemini/credentials/${id}/usage`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const result = await response.json();

        if (result.success && result.data) {
            usageCache[id] = result.data;
            // 更新卡片显示
            if (modelsSection) {
                modelsSection.innerHTML = generateModelTagsHTML(result.data);
                // 重新绑定刷新按钮事件
                const refreshBtn = modelsSection.querySelector('.btn-refresh-models');
                if (refreshBtn) {
                    refreshBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        refreshSingleUsage(id);
                    });
                }
            }
            updateStatsCards();
            if (showToastMsg) showToast('额度刷新成功', 'success');
        } else {
            if (modelsSection) {
                modelsSection.innerHTML = `<div class="model-tags-empty">
                    <span class="empty-text" style="color: var(--accent-danger);">获取失败</span>
                    <button class="btn-refresh-models">重试</button>
                </div>`;
                const refreshBtn = modelsSection.querySelector('.btn-refresh-models');
                if (refreshBtn) {
                    refreshBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        refreshSingleUsage(id);
                    });
                }
            }
            if (showToastMsg) showToast('额度刷新失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        if (modelsSection) {
            modelsSection.innerHTML = `<div class="model-tags-empty">
                <span class="empty-text" style="color: var(--accent-danger);">获取失败</span>
                <button class="btn-refresh-models">重试</button>
            </div>`;
            const refreshBtn = modelsSection.querySelector('.btn-refresh-models');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    refreshSingleUsage(id);
                });
            }
        }
        if (showToastMsg) showToast('额度刷新失败: ' + error.message, 'error');
    }
}
