/**
 * Warp API 路由
 */
import crypto from 'crypto';
import https from 'https';
import { WarpService, WARP_MODELS, refreshAccessToken, isTokenExpired, getEmailFromToken, parseJwtToken, mapModelToWarp } from './warp-service.js';
import { ApiLogStore } from '../db.js';
import { WarpMultiAgentService } from './warp-multi-agent.js';
import { WarpProxy } from './warp-proxy.js';

// 导入新的 protobuf 模块
import { loadProtos, encodeRequest, decodeResponseEvent, responseEventToObject } from './warp-proto.js';
import { buildWarpRequest, parseWarpResponseEvent, convertToClaudeSSE, buildClaudeResponse, createSSEState, createMessageStartSSE } from './warp-message-converter.js';
import { warpToolCallToClaudeToolUse } from './warp-tool-mapper.js';

// 简单的 token 估算函数（按字符数估算）
function estimateTokens(text) {
    if (!text) return 0;
    // 粗略估算：中文约 1.5 字符/token，英文约 4 字符/token
    // 这里使用平均值约 2.5 字符/token
    return Math.ceil(text.length / 2.5);
}

// 生成请求ID
function generateRequestId() {
    return `warp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// 429 错误重试配置
const RETRY_CONFIG = {
    maxRetries: 3,           // 最大重试次数
    retryDelay: 1000,        // 重试延迟（毫秒）
    excludeCredentialIds: new Set()  // 临时排除的凭证ID（配额耗尽）
};

// 清理过期的排除凭证（每小时重置）
setInterval(() => {
    RETRY_CONFIG.excludeCredentialIds.clear();
    console.log('[Warp] 已重置配额耗尽凭证排除列表');
}, 3600000);

export async function setupWarpRoutes(app, warpStore, warpService, apiKeyStore) {
    // 初始化日志存储
    const apiLogStore = await ApiLogStore.create();
    
    // 初始化多代理服务
    const multiAgentService = new WarpMultiAgentService(warpStore, {
        maxIterations: 10
    });
    
    // WarpProxy 实例缓存（按凭证ID）
    const warpProxies = new Map();
    
    /**
     * 带 429 重试的 Warp 请求
     * 当遇到 429 错误时，自动切换到其他凭证重试
     */
    async function sendWarpRequestWithRetry(query, warpModel, warpReqOptions = {}) {
        const { sendWarpRequest } = await import('./warp-service.js');
        let lastError = null;
        let triedCredentialIds = new Set();
        
        for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
            // 获取可用凭证（排除已尝试的和配额耗尽的）
            const allCredentials = await warpStore.getAllActive();
            const availableCredentials = allCredentials.filter(c => 
                !triedCredentialIds.has(c.id) && 
                !RETRY_CONFIG.excludeCredentialIds.has(c.id)
            );
            
            if (availableCredentials.length === 0) {
                // 没有更多可用凭证
                if (lastError) throw lastError;
                throw new Error('没有可用的 Warp 账号（所有账号配额已耗尽）');
            }
            
            // 随机选择一个凭证
            const credential = availableCredentials[Math.floor(Math.random() * availableCredentials.length)];
            triedCredentialIds.add(credential.id);
            
            try {
                const accessToken = await warpService.getValidAccessToken(credential);
                console.log(`  -> [attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries}] using credential #${credential.id} (${credential.name || credential.email})`);
                
                const warpResponse = await sendWarpRequest(query, accessToken, warpModel, warpReqOptions);
                await warpStore.incrementUseCount(credential.id);
                
                return { response: warpResponse, credentialId: credential.id };
            } catch (error) {
                lastError = error;
                
                // 检查是否是 429 配额耗尽错误
                if (error.message && error.message.includes('429')) {
                    console.log(`  <- [429] credential #${credential.id} quota exhausted, trying next...`);
                    RETRY_CONFIG.excludeCredentialIds.add(credential.id);
                    
                    // 标记凭证配额耗尽
                    await warpStore.markQuotaExhausted(credential.id).catch(() => {});
                    
                    // 短暂延迟后重试
                    await new Promise(resolve => setTimeout(resolve, RETRY_CONFIG.retryDelay));
                    continue;
                }
                
                // 其他错误直接抛出
                throw error;
            }
        }
        
        // 所有重试都失败
        throw lastError || new Error('所有重试都失败');
    }
    
    /**
     * 获取 WarpProxy 实例
     */
    async function getWarpProxy(credentialId = null) {
        const credential = credentialId 
            ? await warpStore.getById(credentialId)
            : await warpStore.getRandomActive();
            
        if (!credential) {
            throw new Error('没有可用的 Warp 凭证');
        }
        
        // 检查缓存
        if (warpProxies.has(credential.id)) {
            const proxy = warpProxies.get(credential.id);
            // 检查 token 是否过期
            if (!isTokenExpired(proxy.accessToken)) {
                return { proxy, credential };
            }
        }
        
        // 刷新 token
        let accessToken = credential.accessToken;
        if (!accessToken || isTokenExpired(accessToken)) {
            const result = await refreshAccessToken(credential.refreshToken);
            accessToken = result.accessToken;
            await warpStore.updateToken(credential.id, accessToken, new Date(Date.now() + result.expiresIn * 1000));
        }
        
        // 创建新的 proxy
        const proxy = new WarpProxy({ 
            accessToken,
            maxIterations: 20,
            autoExecuteTools: true
        });
        warpProxies.set(credential.id, proxy);
        
        return { proxy, credential };
    }
    
    /**
     * 验证 API 密钥中间件
     */
    async function verifyWarpApiKey(req, res, next) {
        // 从 Authorization header 或 X-API-Key 获取密钥
        const authHeader = req.headers.authorization;
        const xApiKey = req.headers['x-api-key'];
        
        let apiKey = null;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            apiKey = authHeader.substring(7);
        } else if (xApiKey) {
            apiKey = xApiKey;
        }
        
        if (!apiKey) {
            return res.status(401).json({
                error: {
                    message: 'Missing API key. Please include your API key in the Authorization header as "Bearer YOUR_API_KEY" or in the X-API-Key header.',
                    type: 'authentication_error',
                    code: 'missing_api_key'
                }
            });
        }
        
        // 验证密钥
        const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const keyRecord = await apiKeyStore.getByKeyHash(hash);
        
        if (!keyRecord) {
            return res.status(401).json({
                error: {
                    message: 'Invalid API key provided.',
                    type: 'authentication_error',
                    code: 'invalid_api_key'
                }
            });
        }
        
        if (!keyRecord.isActive) {
            return res.status(401).json({
                error: {
                    message: 'API key is disabled.',
                    type: 'authentication_error',
                    code: 'disabled_api_key'
                }
            });
        }
        
        // 将密钥信息附加到请求对象
        req.apiKey = keyRecord;
        
        // 更新最后使用时间
        await apiKeyStore.updateLastUsed(keyRecord.id);
        
        next();
    }

    // Warp API 配置
    const WARP_CONFIG = {
        host: 'app.warp.dev',
        path: '/ai/multi-agent',
        headers: {
            'x-warp-client-id': 'warp-app',
            'x-warp-client-version': 'v0.2026.01.14.08.15.stable_02',
            'x-warp-os-category': 'macOS',
            'x-warp-os-name': 'macOS',
            'x-warp-os-version': '15.7.2',
            'content-type': 'application/x-protobuf',
            'accept': 'text/event-stream',
            'accept-encoding': 'identity',
        }
    };

    /**
     * 使用 protobufjs 发送 Warp 请求
     * @param {Object} claudeRequest - Claude API 格式的请求
     * @param {string} accessToken - Warp 访问令牌
     * @param {Object} context - 上下文信息
     * @returns {Promise<Object>} 响应结果
     */
    async function sendProtobufRequest(claudeRequest, accessToken, context = {}) {
        // 确保 proto 已加载
        await loadProtos();

        // 构建 Warp 请求
        const warpRequest = buildWarpRequest(claudeRequest, context);

        // 编码为 protobuf
        const requestBuffer = encodeRequest(warpRequest);

        return new Promise((resolve, reject) => {
            const options = {
                hostname: WARP_CONFIG.host,
                port: 443,
                path: WARP_CONFIG.path,
                method: 'POST',
                headers: {
                    ...WARP_CONFIG.headers,
                    'authorization': `Bearer ${accessToken}`,
                    'content-length': requestBuffer.length
                }
            };

            const req = https.request(options, (res) => {
                if (res.statusCode !== 200) {
                    let errorData = '';
                    res.on('data', chunk => errorData += chunk);
                    res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errorData}`)));
                    return;
                }

                const state = createSSEState(`msg_${Date.now()}`, claudeRequest.model || 'auto', 0);
                let buffer = '';

                res.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data:')) {
                            const eventData = line.substring(5).trim();
                            if (eventData) {
                                try {
                                    const decoded = Buffer.from(eventData, 'base64');
                                    const responseEvent = decodeResponseEvent(decoded);
                                    const eventObj = responseEventToObject(responseEvent);
                                    const events = parseWarpResponseEvent(eventObj);

                                    for (const event of events) {
                                        if (event.type === 'text_delta' || event.type === 'agent_output') {
                                            state.fullText = (state.fullText || '') + (event.text || '');
                                        } else if (event.type === 'tool_use') {
                                            state.toolCalls = state.toolCalls || [];
                                            state.toolCalls.push(event.toolUse);
                                        } else if (event.type === 'stream_finished') {
                                            state.finished = true;
                                            state.usage = event.usage;
                                            state.stopReason = event.reason;
                                        }
                                    }
                                } catch (e) {
                                    // 解码失败，忽略
                                    if (process.env.WARP_DEBUG === 'true') {
                                        console.log(`  [PROTO DEBUG] decode error: ${e.message}`);
                                    }
                                }
                            }
                        }
                    }
                });

                res.on('end', () => {
                    // 处理剩余的 buffer
                    if (buffer.startsWith('data:')) {
                        const eventData = buffer.substring(5).trim();
                        if (eventData) {
                            try {
                                const decoded = Buffer.from(eventData, 'base64');
                                const responseEvent = decodeResponseEvent(decoded);
                                const eventObj = responseEventToObject(responseEvent);
                                const events = parseWarpResponseEvent(eventObj);

                                for (const event of events) {
                                    if (event.type === 'text_delta' || event.type === 'agent_output') {
                                        state.fullText = (state.fullText || '') + (event.text || '');
                                    } else if (event.type === 'tool_use') {
                                        state.toolCalls = state.toolCalls || [];
                                        state.toolCalls.push(event.toolUse);
                                    }
                                }
                            } catch (e) { }
                        }
                    }

                    resolve({
                        text: state.fullText || '',
                        toolCalls: state.toolCalls || [],
                        usage: state.usage || { input_tokens: 0, output_tokens: 0 },
                        stopReason: state.stopReason || 'end_turn'
                    });
                });

                res.on('error', reject);
            });

            req.on('error', reject);
            req.write(requestBuffer);
            req.end();
        });
    }

    /**
     * 使用 protobufjs 发送流式 Warp 请求
     * @param {Object} claudeRequest - Claude API 格式的请求
     * @param {string} accessToken - Warp 访问令牌
     * @param {Object} context - 上下文信息
     * @param {Function} onEvent - 事件回调
     * @returns {Promise<void>}
     */
    async function sendProtobufStreamRequest(claudeRequest, accessToken, context, onEvent) {
        // 确保 proto 已加载
        await loadProtos();

        // 构建 Warp 请求
        const warpRequest = buildWarpRequest(claudeRequest, context);

        // 编码为 protobuf
        const requestBuffer = encodeRequest(warpRequest);

        return new Promise((resolve, reject) => {
            const options = {
                hostname: WARP_CONFIG.host,
                port: 443,
                path: WARP_CONFIG.path,
                method: 'POST',
                headers: {
                    ...WARP_CONFIG.headers,
                    'authorization': `Bearer ${accessToken}`,
                    'content-length': requestBuffer.length
                }
            };

            const req = https.request(options, (res) => {
                if (res.statusCode !== 200) {
                    let errorData = '';
                    res.on('data', chunk => errorData += chunk);
                    res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errorData}`)));
                    return;
                }

                let buffer = '';

                res.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data:')) {
                            const eventData = line.substring(5).trim();
                            if (eventData) {
                                try {
                                    const decoded = Buffer.from(eventData, 'base64');
                                    const responseEvent = decodeResponseEvent(decoded);
                                    const eventObj = responseEventToObject(responseEvent);
                                    const events = parseWarpResponseEvent(eventObj);

                                    for (const event of events) {
                                        onEvent(event);
                                    }
                                } catch (e) {
                                    if (process.env.WARP_DEBUG === 'true') {
                                        console.log(`  [PROTO DEBUG] decode error: ${e.message}`);
                                    }
                                }
                            }
                        }
                    }
                });

                res.on('end', () => {
                    // 处理剩余的 buffer
                    if (buffer.startsWith('data:')) {
                        const eventData = buffer.substring(5).trim();
                        if (eventData) {
                            try {
                                const decoded = Buffer.from(eventData, 'base64');
                                const responseEvent = decodeResponseEvent(decoded);
                                const eventObj = responseEventToObject(responseEvent);
                                const events = parseWarpResponseEvent(eventObj);

                                for (const event of events) {
                                    onEvent(event);
                                }
                            } catch (e) { }
                        }
                    }
                    resolve();
                });

                res.on('error', reject);
            });

            req.on('error', reject);
            req.write(requestBuffer);
            req.end();
        });
    }

    /**
     * 带重试的 protobuf 请求
     */
    async function sendProtobufRequestWithRetry(claudeRequest, context = {}) {
        let lastError = null;
        let triedCredentialIds = new Set();

        for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
            const allCredentials = await warpStore.getAllActive();
            const availableCredentials = allCredentials.filter(c =>
                !triedCredentialIds.has(c.id) &&
                !RETRY_CONFIG.excludeCredentialIds.has(c.id)
            );

            if (availableCredentials.length === 0) {
                if (lastError) throw lastError;
                throw new Error('没有可用的 Warp 账号（所有账号配额已耗尽）');
            }

            const credential = availableCredentials[Math.floor(Math.random() * availableCredentials.length)];
            triedCredentialIds.add(credential.id);

            try {
                const accessToken = await warpService.getValidAccessToken(credential);
                console.log(`  -> [protobuf attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries}] using credential #${credential.id}`);

                const response = await sendProtobufRequest(claudeRequest, accessToken, context);
                await warpStore.incrementUseCount(credential.id);

                return { response, credentialId: credential.id };
            } catch (error) {
                lastError = error;

                if (error.message && error.message.includes('429')) {
                    console.log(`  <- [429] credential #${credential.id} quota exhausted, trying next...`);
                    RETRY_CONFIG.excludeCredentialIds.add(credential.id);
                    await warpStore.markQuotaExhausted(credential.id).catch(() => { });
                    await new Promise(resolve => setTimeout(resolve, RETRY_CONFIG.retryDelay));
                    continue;
                }

                throw error;
            }
        }

        throw lastError || new Error('所有重试都失败');
    }

    // ============ 测试端点（无需 API Key） ============
    
    // 测试 /w/v1/messages 端点功能（无需验证）
    app.post('/api/warp/test/messages', async (req, res) => {
        const startTime = Date.now();
        const requestId = generateRequestId();
        
        try {
            const { model, messages, system, metadata } = req.body;
            const workingDir = metadata?.working_dir || '/tmp';

            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({
                    type: 'error',
                    error: { type: 'invalid_request_error', message: 'messages is required' }
                });
            }

            // 构建查询
            let query = '';
            if (system) query += `[System] ${system}\n\n`;
            
            for (const m of messages) {
                if (m.role === 'user') {
                    if (typeof m.content === 'string') {
                        query += m.content + '\n\n';
                    } else if (Array.isArray(m.content)) {
                        for (const block of m.content) {
                            if (block.type === 'text') query += block.text + '\n\n';
                            else if (block.type === 'tool_result') {
                                query += `[工具执行结果]\n命令ID: ${block.tool_use_id}\n输出:\n${block.content}\n\n`;
                            }
                        }
                    }
                } else if (m.role === 'assistant') {
                    if (typeof m.content === 'string') query += `[Assistant] ${m.content}\n\n`;
                }
            }

            const warpModel = mapModelToWarp(model || 'claude-4.1-opus');
            
            // 获取凭证
            const credential = await warpStore.getRandomActive();
            if (!credential) {
                return res.status(503).json({ type: 'error', error: { message: '没有可用的 Warp 账号' } });
            }
            
            const accessToken = await warpService.getValidAccessToken(credential);
            const { sendWarpRequest } = await import('./warp-service.js');
            const warpResponse = await sendWarpRequest(query, accessToken, warpModel);
            await warpStore.incrementUseCount(credential.id);
            
            const toolCalls = warpResponse.toolCalls || [];
            const contentBlocks = [];
            
            if (warpResponse.text) {
                contentBlocks.push({ type: 'text', text: warpResponse.text });
            }
            
            if (toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    contentBlocks.push({
                        type: 'tool_use',
                        id: tc.callId || `toolu_${Date.now()}`,
                        name: 'Bash',
                        input: { command: tc.command }
                    });
                }
            }
            
            if (contentBlocks.length === 0) {
                contentBlocks.push({ type: 'text', text: '请问有什么可以帮助你的？' });
            }

            res.json({
                id: `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                content: contentBlocks,
                model: warpModel,
                stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
                usage: { input_tokens: query.length, output_tokens: (warpResponse.text || '').length }
            });
        } catch (error) {
            res.status(500).json({ type: 'error', error: { message: error.message } });
        }
    });

    // ============ Warp 凭证管理 ============

    // 获取所有 Warp 凭证
    app.get('/api/warp/credentials', async (req, res) => {
        try {
            const credentials = await warpStore.getAll();
            // 隐藏敏感信息
            const safeCredentials = credentials.map(c => ({
                ...c,
                refreshToken: c.refreshToken ? `${c.refreshToken.substring(0, 20)}...` : null,
                accessToken: c.accessToken ? `${c.accessToken.substring(0, 20)}...` : null
            }));
            res.json({ success: true, data: safeCredentials });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取 Warp 统计信息
    app.get('/api/warp/statistics', async (req, res) => {
        try {
            const stats = await warpStore.getStatistics();
            res.json({ success: true, data: stats });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取单个 Warp 凭证
    app.get('/api/warp/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await warpStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }
            // 隐藏敏感信息
            const safeCredential = {
                ...credential,
                refreshToken: credential.refreshToken ? `${credential.refreshToken.substring(0, 20)}...` : null,
                accessToken: credential.accessToken ? `${credential.accessToken.substring(0, 20)}...` : null
            };
            res.json({ success: true, data: safeCredential });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 添加 Warp 凭证
    app.post('/api/warp/credentials', async (req, res) => {
        try {
            const { name, refreshToken } = req.body;

            if (!refreshToken) {
                return res.status(400).json({ success: false, error: 'refreshToken 是必需的' });
            }

            // 尝试刷新 token 来验证
            let accessToken = null;
            let email = null;
            let tokenExpiresAt = null;

            try {
                const result = await refreshAccessToken(refreshToken);
                accessToken = result.accessToken;
                tokenExpiresAt = new Date(Date.now() + result.expiresIn * 1000);
                email = getEmailFromToken(accessToken);
            } catch (e) {
                return res.status(400).json({ success: false, error: `Token 验证失败: ${e.message}` });
            }

            // 生成名称
            const credName = name || email || `warp-${Date.now()}`;

            // 检查是否已存在
            const existing = await warpStore.getByName(credName);
            if (existing) {
                return res.status(400).json({ success: false, error: '凭证名称已存在' });
            }

            const id = await warpStore.add({
                name: credName,
                email,
                refreshToken,
                accessToken,
                tokenExpiresAt
            });

            res.json({ success: true, data: { id, name: credName, email } });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 批量导入 Warp 凭证
    app.post('/api/warp/credentials/batch-import', async (req, res) => {
        try {
            const { accounts } = req.body;

            if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
                return res.status(400).json({ success: false, error: '请提供账号数组' });
            }

            const results = {
                success: 0,
                failed: 0,
                errors: []
            };

            for (const account of accounts) {
                try {
                    // 支持多种字段名
                    const refreshToken = account.refreshToken || account.refresh_token || account.token;
                    const name = account.name || account.email;

                    if (!refreshToken) {
                        results.failed++;
                        results.errors.push({ name, error: '缺少 refreshToken' });
                        continue;
                    }

                    // 尝试刷新 token 来验证
                    let accessToken = null;
                    let email = null;
                    let tokenExpiresAt = null;

                    try {
                        const result = await refreshAccessToken(refreshToken);
                        accessToken = result.accessToken;
                        tokenExpiresAt = new Date(Date.now() + result.expiresIn * 1000);
                        email = getEmailFromToken(accessToken);
                    } catch (e) {
                        results.failed++;
                        results.errors.push({ name, error: `Token 验证失败: ${e.message}` });
                        continue;
                    }

                    // 生成名称
                    const credName = name || email || `warp-${Date.now()}-${results.success}`;

                    // 检查是否已存在
                    const existing = await warpStore.getByName(credName);
                    if (existing) {
                        // 更新现有凭证
                        await warpStore.update(existing.id, {
                            refreshToken,
                            accessToken,
                            tokenExpiresAt,
                            email
                        });
                        results.success++;
                        continue;
                    }

                    await warpStore.add({
                        name: credName,
                        email,
                        refreshToken,
                        accessToken,
                        tokenExpiresAt
                    });

                    results.success++;
                } catch (e) {
                    results.failed++;
                    results.errors.push({ name: account.name || account.email, error: e.message });
                }
            }

            res.json({ success: true, data: results });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 更新 Warp 凭证
    app.put('/api/warp/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const { name, isActive } = req.body;

            const credential = await warpStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            await warpStore.update(id, { name, isActive });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除 Warp 凭证
    app.delete('/api/warp/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await warpStore.delete(id);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 刷新单个凭证的 Token
    app.post('/api/warp/credentials/:id/refresh', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await warpStore.getById(id);

            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            const result = await refreshAccessToken(credential.refreshToken);
            const tokenExpiresAt = new Date(Date.now() + result.expiresIn * 1000);

            await warpStore.updateToken(id, result.accessToken, tokenExpiresAt);

            res.json({
                success: true,
                data: {
                    expiresAt: tokenExpiresAt,
                    expiresIn: result.expiresIn
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 批量刷新所有 Token
    app.post('/api/warp/credentials/refresh-all', async (req, res) => {
        try {
            const results = await warpService.refreshAllTokens();
            res.json({ success: true, data: results });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 健康检查
    app.get('/api/warp/health', async (req, res) => {
        try {
            const health = await warpService.healthCheck();
            res.json({ success: true, data: health });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取 Warp 模型列表
    app.get('/api/warp/models', async (req, res) => {
        res.json({ success: true, data: WARP_MODELS });
    });

    // ============ 错误凭证管理 ============

    // 获取所有错误凭证
    app.get('/api/warp/errors', async (req, res) => {
        try {
            const errors = await warpStore.getAllErrors();
            res.json({ success: true, data: errors });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 恢复错误凭证
    app.post('/api/warp/errors/:id/restore', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const { refreshToken } = req.body;

            const newId = await warpStore.restoreFromError(id, refreshToken);
            if (!newId) {
                return res.status(404).json({ success: false, error: '错误凭证不存在' });
            }

            res.json({ success: true, data: { id: newId } });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除错误凭证
    app.delete('/api/warp/errors/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await warpStore.deleteError(id);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ============ Warp 对话 API ============

    // 简单对话接口（支持指定账号）
    app.post('/api/warp/chat', async (req, res) => {
        try {
            const { query, model, credentialId } = req.body;

            if (!query) {
                return res.status(400).json({ success: false, error: '请提供 query' });
            }

            let result;
            if (credentialId) {
                // 使用指定账号
                const credential = await warpStore.getById(credentialId);
                if (!credential) {
                    return res.status(404).json({ success: false, error: '账号不存在' });
                }
                const accessToken = await warpService.getValidAccessToken(credential);
                const { sendWarpRequest } = await import('./warp-service.js');
                const warpResponse = await sendWarpRequest(query, accessToken, model || 'claude-4.1-opus');
                await warpStore.incrementUseCount(credentialId);
                result = { response: warpResponse.text, credentialId, credentialName: credential.name };
            } else {
                // 自动选择账号
                result = await warpService.chat(query, model || 'claude-4.1-opus');
            }
            
            res.json({
                success: true,
                data: {
                    response: result.response,
                    credentialName: result.credentialName
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 多代理对话接口（支持工具调用循环）
    app.post('/api/warp/agent', async (req, res) => {
        try {
            const { query, model, workingDir, sessionId } = req.body;

            if (!query) {
                return res.status(400).json({ success: false, error: '请提供 query' });
            }

            // 使用多代理服务处理请求
            const result = await multiAgentService.chat(query, {
                model: model || 'claude-4.1-opus',
                workingDir: workingDir || process.cwd(),
                sessionId
            });
            
            res.json({
                success: true,
                data: {
                    response: result.response,
                    toolCalls: result.toolCalls
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 多代理流式对话接口
    app.post('/api/warp/agent/stream', async (req, res) => {
        const { query, model, workingDir, sessionId } = req.body;

        if (!query) {
            return res.status(400).json({ success: false, error: '请提供 query' });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        try {
            for await (const event of multiAgentService.processQuery(query, {
                model: model || 'claude-4.1-opus',
                workingDir: workingDir || process.cwd(),
                sessionId
            })) {
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
        } catch (error) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    });

    // ============ 交互式工具调用 API ============
    // 会话存储（内存中，生产环境应使用 Redis）
    const agentSessions = new Map();

    // 开始对话 - 返回 AI 响应和工具调用请求（需要用户确认）
    app.post('/api/warp/agent/start', async (req, res) => {
        try {
            const { query, model, workingDir } = req.body;

            if (!query) {
                return res.status(400).json({ success: false, error: '请提供 query' });
            }

            // 获取凭证
            const credential = await warpStore.getRandomActive();
            if (!credential) {
                return res.status(503).json({ success: false, error: '没有可用的 Warp 账号' });
            }

            const accessToken = await warpService.getValidAccessToken(credential);
            const { sendWarpRequest } = await import('./warp-service.js');
            
            // 发送请求
            const warpResponse = await sendWarpRequest(query, accessToken, model || 'claude-4.1-opus');
            await warpStore.incrementUseCount(credential.id);

            // 生成会话 ID
            const sessionId = crypto.randomUUID();
            
            // 保存会话状态
            agentSessions.set(sessionId, {
                credentialId: credential.id,
                credentialName: credential.name,
                query,
                model: model || 'claude-4.1-opus',
                workingDir: workingDir || '/tmp',
                toolCalls: warpResponse.toolCalls || [],
                history: [{ role: 'user', content: query }, { role: 'assistant', content: warpResponse.text }],
                createdAt: Date.now()
            });

            // 清理过期会话（30分钟）
            for (const [id, session] of agentSessions) {
                if (Date.now() - session.createdAt > 30 * 60 * 1000) {
                    agentSessions.delete(id);
                }
            }

            res.json({
                success: true,
                data: {
                    sessionId,
                    response: warpResponse.text,
                    toolCalls: warpResponse.toolCalls || [],
                    needsConfirmation: (warpResponse.toolCalls || []).length > 0,
                    credentialName: credential.name
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 执行命令 - 用户确认后执行 bash 命令
    app.post('/api/warp/agent/execute', async (req, res) => {
        try {
            const { sessionId, command, workingDir } = req.body;

            if (!command) {
                return res.status(400).json({ success: false, error: '请提供 command' });
            }

            const session = sessionId ? agentSessions.get(sessionId) : null;
            const cwd = workingDir || (session ? session.workingDir : '/tmp');

            // 执行命令
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);

            let result;
            try {
                const { stdout, stderr } = await execAsync(command, { 
                    cwd, 
                    timeout: 30000,
                    maxBuffer: 1024 * 1024 
                });
                result = {
                    success: true,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    command,
                    cwd
                };
            } catch (execError) {
                result = {
                    success: false,
                    error: execError.message,
                    stdout: execError.stdout?.trim() || '',
                    stderr: execError.stderr?.trim() || '',
                    command,
                    cwd
                };
            }

            // 更新会话
            if (session) {
                session.lastToolResult = result;
                session.history.push({ role: 'tool', content: result.stdout || result.stderr || result.error });
            }

            res.json({ success: true, data: result });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 继续对话 - 将工具结果发回 Warp
    app.post('/api/warp/agent/continue', async (req, res) => {
        try {
            const { sessionId, toolResult } = req.body;

            if (!sessionId) {
                return res.status(400).json({ success: false, error: '请提供 sessionId' });
            }

            const session = agentSessions.get(sessionId);
            if (!session) {
                return res.status(404).json({ success: false, error: '会话不存在或已过期' });
            }

            // 获取凭证
            const credential = await warpStore.getById(session.credentialId);
            if (!credential) {
                return res.status(503).json({ success: false, error: '账号不可用' });
            }

            const accessToken = await warpService.getValidAccessToken(credential);
            const { sendWarpRequest } = await import('./warp-service.js');

            // 构建包含工具结果的查询
            const result = toolResult || session.lastToolResult;
            const continueQuery = `${session.query}\n\n[工具执行结果]\n命令: ${result.command}\n输出:\n${result.stdout || result.stderr || result.error}`;

            // 发送请求
            const warpResponse = await sendWarpRequest(continueQuery, accessToken, session.model);
            await warpStore.incrementUseCount(credential.id);

            // 更新会话
            session.history.push({ role: 'assistant', content: warpResponse.text });
            session.toolCalls = warpResponse.toolCalls || [];

            res.json({
                success: true,
                data: {
                    sessionId,
                    response: warpResponse.text,
                    toolCalls: warpResponse.toolCalls || [],
                    needsConfirmation: (warpResponse.toolCalls || []).length > 0,
                    credentialName: session.credentialName
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取会话状态
    app.get('/api/warp/agent/session/:sessionId', async (req, res) => {
        const session = agentSessions.get(req.params.sessionId);
        if (!session) {
            return res.status(404).json({ success: false, error: '会话不存在或已过期' });
        }
        res.json({
            success: true,
            data: {
                sessionId: req.params.sessionId,
                query: session.query,
                model: session.model,
                workingDir: session.workingDir,
                toolCalls: session.toolCalls,
                historyLength: session.history.length,
                createdAt: session.createdAt
            }
        });
    });

    // ============ OpenAI 兼容端点（需要 API 密钥验证） ============

    // Warp OpenAI 兼容 - /w/v1/chat/completions
    app.post('/w/v1/chat/completions', verifyWarpApiKey, async (req, res) => {
        const startTime = Date.now();
        const apiKeyId = req.apiKey?.id || null;
        const requestId = generateRequestId();
        
        // 打印请求详情
        console.log('\n' + '='.repeat(80));
        console.log(`[${new Date().toISOString()}] /w/v1/chat/completions 请求`);
        console.log('='.repeat(80));
        console.log(`请求ID: ${requestId}`);
        console.log(`API Key: ${req.apiKey?.keyPrefix || 'unknown'}***`);
        console.log(`IP: ${req.ip || req.connection?.remoteAddress}`);
        console.log(`User-Agent: ${req.headers['user-agent']}`);
        console.log('-'.repeat(40));
        console.log('请求体:');
        console.log(JSON.stringify(req.body, null, 2));
        console.log('='.repeat(80));
        
        try {
            const { model, messages, stream } = req.body;

            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({
                    error: {
                        message: 'messages is required',
                        type: 'invalid_request_error'
                    }
                });
            }

            // 将 messages 转换为单个查询
            const query = messages.map(m => {
                if (m.role === 'system') return `[System] ${m.content}`;
                if (m.role === 'user') return m.content;
                if (m.role === 'assistant') return `[Assistant] ${m.content}`;
                return m.content;
            }).join('\n\n');

            // 将外部模型名转换为 Warp 支持的模型名
            const warpModel = mapModelToWarp(model);
            const inputTokens = estimateTokens(query);

            if (stream) {
                // 流式响应
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                const responseId = `chatcmpl-${Date.now()}`;
                let fullContent = '';
                let usedCredentialId = null;

                warpService.chatStream(
                    query,
                    warpModel,
                    (content, credentialId) => {
                        fullContent += content;
                        if (credentialId) usedCredentialId = credentialId;
                        const chunk = {
                            id: responseId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: warpModel,
                            choices: [{
                                index: 0,
                                delta: { content },
                                finish_reason: null
                            }]
                        };
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    },
                    async (credentialId) => {
                        if (credentialId) usedCredentialId = credentialId;
                        // 发送结束标记
                        const endChunk = {
                            id: responseId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: warpModel,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: 'stop'
                            }]
                        };
                        res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                        
                        // 记录统计到 api_logs（不记录消息内容）
                        const outputTokens = estimateTokens(fullContent);
                        await apiLogStore.create({
                            requestId: generateRequestId(),
                            apiKeyId,
                            apiKeyPrefix: req.apiKey?.keyPrefix || null,
                            credentialId: usedCredentialId || null,
                            ipAddress: req.ip || req.connection?.remoteAddress,
                            userAgent: req.headers['user-agent'],
                            method: 'POST',
                            path: '/w/v1/chat/completions',
                            model: warpModel,
                            stream: true,
                            inputTokens,
                            outputTokens,
                            requestMessages: null,
                            responseContent: null,
                            statusCode: 200,
                            durationMs: Date.now() - startTime
                        });
                    },
                    async (error) => {
                        const errorChunk = {
                            error: {
                                message: error.message,
                                type: 'server_error'
                            }
                        };
                        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                        res.end();
                        
                        // 记录错误统计到 api_logs
                        await apiLogStore.create({
                            requestId: generateRequestId(),
                            apiKeyId,
                            apiKeyPrefix: req.apiKey?.keyPrefix || null,
                            credentialId: usedCredentialId || null,
                            ipAddress: req.ip || req.connection?.remoteAddress,
                            userAgent: req.headers['user-agent'],
                            method: 'POST',
                            path: '/w/v1/chat/completions',
                            model: warpModel,
                            stream: true,
                            inputTokens,
                            outputTokens: 0,
                            requestMessages: null,
                            responseContent: null,
                            statusCode: 500,
                            errorMessage: error.message,
                            durationMs: Date.now() - startTime
                        });
                    }
                );
            } else {
                // 非流式响应
                const result = await warpService.chat(query, warpModel);
                const outputTokens = estimateTokens(result.response);

                // 打印非流式响应详情
                const durationMs = Date.now() - startTime;
                console.log('\n' + '-'.repeat(80));
                console.log(`[${new Date().toISOString()}] /w/v1/chat/completions 非流式响应`);
                console.log('-'.repeat(80));
                console.log(`请求ID: ${requestId}`);
                console.log(`模型: ${warpModel}`);
                console.log(`凭证ID: ${result.credentialId || 'unknown'}`);
                console.log(`输入tokens: ${inputTokens}, 输出tokens: ${outputTokens}`);
                console.log(`耗时: ${durationMs}ms`);
                console.log('-'.repeat(40));
                console.log('响应内容:');
                console.log(result.response);
                console.log('='.repeat(80) + '\n');

                // 记录统计到 api_logs（不记录消息内容）
                await apiLogStore.create({
                    requestId,
                    apiKeyId,
                    apiKeyPrefix: req.apiKey?.keyPrefix || null,
                    credentialId: result.credentialId || null,
                    ipAddress: req.ip || req.connection?.remoteAddress,
                    userAgent: req.headers['user-agent'],
                    method: 'POST',
                    path: '/w/v1/chat/completions',
                    model: warpModel,
                    stream: false,
                    inputTokens,
                    outputTokens,
                    requestMessages: null,
                    responseContent: null,
                    statusCode: 200,
                    durationMs
                });

                res.json({
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: warpModel,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: result.response
                        },
                        finish_reason: 'stop'
                    }],
                    usage: {
                        prompt_tokens: inputTokens,
                        completion_tokens: outputTokens,
                        total_tokens: inputTokens + outputTokens
                    }
                });
            }
        } catch (error) {
            // 记录错误统计到 api_logs
            await apiLogStore.create({
                requestId: generateRequestId(),
                apiKeyId,
                apiKeyPrefix: req.apiKey?.keyPrefix || null,
                credentialId: null,
                ipAddress: req.ip || req.connection?.remoteAddress,
                userAgent: req.headers['user-agent'],
                method: 'POST',
                path: '/w/v1/chat/completions',
                model: req.body?.model || 'unknown',
                stream: req.body?.stream || false,
                inputTokens: 0,
                outputTokens: 0,
                requestMessages: null,
                responseContent: null,
                statusCode: 500,
                errorMessage: error.message,
                durationMs: Date.now() - startTime
            });
            
            res.status(500).json({
                error: {
                    message: error.message,
                    type: 'server_error'
                }
            });
        }
    });

    // Warp 模型列表 - /w/v1/models
    app.get('/w/v1/models', async (req, res) => {
        const models = WARP_MODELS.map(m => ({
            id: m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'warp'
        }));

        res.json({
            object: 'list',
            data: models
        });
    });

    // ============ Claude 格式端点 ============

    // 会话存储（用于工具调用的连续对话）
    const messagesSessions = new Map();

    // Warp Claude 格式 (Protobuf 版本) - /w/v1/messages/proto
    // 使用 protobufjs 进行编解码，支持完整的工具映射
    app.post('/w/v1/messages/proto', verifyWarpApiKey, async (req, res) => {
        const startTime = Date.now();
        const apiKeyId = req.apiKey?.id || null;
        const requestId = generateRequestId();

        try {
            const { model, messages, max_tokens, stream, system, metadata, tools } = req.body;
            const workingDir = metadata?.working_dir || '/tmp';

            console.log(`\n[${new Date().toISOString()}] /w/v1/messages/proto | id=${requestId} | key=${req.apiKey?.keyPrefix || '?'}***`);
            console.log(`  stream=${Boolean(stream)} model=${model || '?'} msgs=${Array.isArray(messages) ? messages.length : 0} tools=${Array.isArray(tools) ? tools.length : 0} working_dir=${workingDir}`);

            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({
                    type: 'error',
                    error: { type: 'invalid_request_error', message: 'messages is required' }
                });
            }

            // 构建 Claude 请求对象
            const claudeRequest = { model, messages, system, tools, metadata };
            const context = { workingDir, homeDir: process.env.HOME || '/root' };

            // 将外部模型名转换为 Warp 支持的模型名
            const warpModel = mapModelToWarp(model);
            const inputTokens = estimateTokens(JSON.stringify(messages));

            if (stream) {
                // 流式响应
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                const messageId = `msg_${Date.now()}`;
                const state = createSSEState(messageId, warpModel, inputTokens);
                let usedCredentialId = null;

                // 发送 message_start
                const startEvent = createMessageStartSSE(state);
                res.write(`event: ${startEvent.event}\ndata: ${JSON.stringify(startEvent.data)}\n\n`);

                try {
                    // 获取凭证
                    const allCredentials = await warpStore.getAllActive();
                    const availableCredentials = allCredentials.filter(c =>
                        !RETRY_CONFIG.excludeCredentialIds.has(c.id)
                    );

                    if (availableCredentials.length === 0) {
                        throw new Error('没有可用的 Warp 账号');
                    }

                    const credential = availableCredentials[Math.floor(Math.random() * availableCredentials.length)];
                    usedCredentialId = credential.id;
                    const accessToken = await warpService.getValidAccessToken(credential);

                    console.log(`  -> [protobuf stream] using credential #${credential.id}`);

                    // 发送流式请求
                    await sendProtobufStreamRequest(claudeRequest, accessToken, context, (event) => {
                        const sseEvents = convertToClaudeSSE([event], state);
                        for (const sse of sseEvents) {
                            res.write(`event: ${sse.event}\ndata: ${JSON.stringify(sse.data)}\n\n`);
                        }
                    });

                    // 确保发送结束事件
                    if (!state.finished) {
                        // 结束文本块
                        if (state.textBlockStarted) {
                            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: state.blockIndex })}\n\n`);
                        }

                        const stopReason = (state.toolCalls && state.toolCalls.length > 0) ? 'tool_use' : 'end_turn';
                        res.write(`event: message_delta\ndata: ${JSON.stringify({
                            type: 'message_delta',
                            delta: { stop_reason: stopReason, stop_sequence: null },
                            usage: { output_tokens: estimateTokens(state.fullText || '') }
                        })}\n\n`);

                        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                    }

                    await warpStore.incrementUseCount(credential.id);
                    res.end();

                    // 记录日志
                    const durationMs = Date.now() - startTime;
                    await apiLogStore.create({
                        requestId,
                        apiKeyId,
                        apiKeyPrefix: req.apiKey?.keyPrefix || null,
                        credentialId: usedCredentialId,
                        ipAddress: req.ip || req.connection?.remoteAddress,
                        userAgent: req.headers['user-agent'],
                        method: 'POST',
                        path: '/w/v1/messages/proto',
                        model: warpModel,
                        stream: true,
                        inputTokens,
                        outputTokens: estimateTokens(state.fullText || ''),
                        statusCode: 200,
                        durationMs
                    });

                } catch (error) {
                    console.error(`  [ERROR] ${error.message}`);
                    res.write(`event: error\ndata: ${JSON.stringify({
                        type: 'error',
                        error: { type: 'server_error', message: error.message }
                    })}\n\n`);
                    res.end();
                }

            } else {
                // 非流式响应
                try {
                    const { response, credentialId } = await sendProtobufRequestWithRetry(claudeRequest, context);

                    console.log(`  <- [protobuf] text=${(response.text || '').length}c toolCalls=${(response.toolCalls || []).length}`);

                    // 构建响应内容
                    const contentBlocks = [];

                    if (response.text) {
                        contentBlocks.push({ type: 'text', text: response.text });
                    }

                    if (response.toolCalls && response.toolCalls.length > 0) {
                        for (const toolUse of response.toolCalls) {
                            contentBlocks.push(toolUse);
                        }
                    }

                    if (contentBlocks.length === 0) {
                        contentBlocks.push({ type: 'text', text: '' });
                    }

                    const outputTokens = estimateTokens(response.text || '');
                    const stopReason = (response.toolCalls && response.toolCalls.length > 0) ? 'tool_use' : 'end_turn';

                    // 记录日志
                    const durationMs = Date.now() - startTime;
                    await apiLogStore.create({
                        requestId,
                        apiKeyId,
                        apiKeyPrefix: req.apiKey?.keyPrefix || null,
                        credentialId,
                        ipAddress: req.ip || req.connection?.remoteAddress,
                        userAgent: req.headers['user-agent'],
                        method: 'POST',
                        path: '/w/v1/messages/proto',
                        model: warpModel,
                        stream: false,
                        inputTokens,
                        outputTokens,
                        statusCode: 200,
                        durationMs
                    });

                    res.json({
                        id: `msg_${Date.now()}`,
                        type: 'message',
                        role: 'assistant',
                        content: contentBlocks,
                        model: warpModel,
                        stop_reason: stopReason,
                        stop_sequence: null,
                        usage: {
                            input_tokens: inputTokens,
                            output_tokens: outputTokens
                        }
                    });

                } catch (error) {
                    console.error(`  [ERROR] ${error.message}`);

                    const durationMs = Date.now() - startTime;
                    await apiLogStore.create({
                        requestId,
                        apiKeyId,
                        apiKeyPrefix: req.apiKey?.keyPrefix || null,
                        credentialId: null,
                        ipAddress: req.ip || req.connection?.remoteAddress,
                        userAgent: req.headers['user-agent'],
                        method: 'POST',
                        path: '/w/v1/messages/proto',
                        model: warpModel,
                        stream: false,
                        inputTokens,
                        outputTokens: 0,
                        statusCode: 500,
                        errorMessage: error.message,
                        durationMs
                    });

                    res.status(500).json({
                        type: 'error',
                        error: { type: 'server_error', message: error.message }
                    });
                }
            }

        } catch (error) {
            console.error(`  [ERROR] ${error.message}`);
            res.status(500).json({
                type: 'error',
                error: { type: 'server_error', message: error.message }
            });
        }
    });

    // Warp Claude 格式 - /w/v1/messages
    // 支持工具调用、用户确认、连续对话
    app.post('/w/v1/messages', verifyWarpApiKey, async (req, res) => {
        const startTime = Date.now();
        const apiKeyId = req.apiKey?.id || null;
        const requestId = generateRequestId();
        
        try {
            const { model, messages, max_tokens, stream, system, metadata, tools } = req.body;
            const workingDir = metadata?.working_dir || '/tmp';
            const authHeader = req.headers.authorization;
            const hasBearer = Boolean(authHeader && authHeader.startsWith('Bearer '));
            const hasXApiKey = Boolean(req.headers['x-api-key']);

            // 简洁日志（不打印完整 req.body）
            const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '?';
            console.log(`[${new Date().toISOString()}] /w/v1/messages | ip=${clientIp} | key=${req.apiKey?.keyPrefix || '?'}*** | model=${model || '?'} | stream=${Boolean(stream)}`);

            if (Array.isArray(tools) && tools.length > 0) {
                const toolNames = tools.map(t => t.name).join(', ');
                console.log(`  tools: ${toolNames}`);
            }

            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: 'messages is required'
                    }
                });
            }

            // 检查是否有 tool_result 消息（用户确认执行后的结果）
            const lastMessage = messages[messages.length - 1];
            let toolResultContent = null;
            let toolCommand = null;
            let sessionId = metadata?.session_id;
            
            if (lastMessage.role === 'user' && Array.isArray(lastMessage.content)) {
                for (const block of lastMessage.content) {
                    if (block.type === 'tool_result') {
                        toolResultContent = block;
                        // 从之前的 assistant 消息中查找对应的 tool_use 获取命令
                        for (let i = messages.length - 2; i >= 0; i--) {
                            const m = messages[i];
                            if (m.role === 'assistant' && Array.isArray(m.content)) {
                                for (const b of m.content) {
                                    if (b.type === 'tool_use' && b.id === block.tool_use_id) {
                                        toolCommand = b.input?.command || 'bash';
                                        break;
                                    }
                                }
                            }
                            if (toolCommand) break;
                        }
                        break;
                    }
                }
            }

            // 只在有 tool_result 时打印额外日志
            if (toolResultContent) {
                console.log(`  tool_result: id=${toolResultContent.tool_use_id || '?'} cmd=${toolCommand || '?'} len=${(toolResultContent.content || '').length}`);
            }

            // 构建查询
            let query = '';
            if (system) {
                // system 可能是字符串或数组
                if (typeof system === 'string') {
                    query += `[System] ${system}\n\n`;
                } else if (Array.isArray(system)) {
                    for (const s of system) {
                        if (typeof s === 'string') {
                            query += `[System] ${s}\n\n`;
                        } else if (s.text) {
                            query += `[System] ${s.text}\n\n`;
                        }
                    }
                }
            }
            
            // 处理消息，包括工具调用和结果
            for (const m of messages) {
                if (m.role === 'user') {
                    if (typeof m.content === 'string') {
                        query += m.content + '\n\n';
                    } else if (Array.isArray(m.content)) {
                        for (const block of m.content) {
                            if (block.type === 'text') {
                                query += block.text + '\n\n';
                            } else if (block.type === 'tool_result') {
                                // 工具执行结果
                                query += `[工具执行结果]\n命令ID: ${block.tool_use_id}\n输出:\n${block.content}\n\n`;
                            }
                        }
                    }
                } else if (m.role === 'assistant') {
                    if (typeof m.content === 'string') {
                        query += `[Assistant] ${m.content}\n\n`;
                    } else if (Array.isArray(m.content)) {
                        for (const block of m.content) {
                            if (block.type === 'text') {
                                query += `[Assistant] ${block.text}\n\n`;
                            } else if (block.type === 'tool_use') {
                                query += `[Assistant 请求执行工具] ${block.name}: ${JSON.stringify(block.input)}\n\n`;
                            }
                        }
                    }
                }
            }

            // 将外部模型名转换为 Warp 支持的模型名
            const warpModel = mapModelToWarp(model);
            const inputTokens = estimateTokens(query);

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                const messageId = `msg_${Date.now()}`;
                let fullContent = '';
                let usedCredentialId = null;

                res.write(`event: message_start\ndata: ${JSON.stringify({
                    type: 'message_start',
                    message: {
                        id: messageId,
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: warpModel,
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: inputTokens, output_tokens: 0 }
                    }
                })}\n\n`);

                try {
                    // 构建请求选项
                    const warpReqOptions = { workingDir };
                    if (toolResultContent) {
                        warpReqOptions.toolResult = {
                            callId: toolResultContent.tool_use_id,
                            command: toolCommand || 'bash',
                            output: toolResultContent.content || ''
                        };
                        console.log(`  -> calling Warp API with tool_result:`);
                        console.log(`     callId: ${warpReqOptions.toolResult.callId}`);
                        console.log(`     command: ${warpReqOptions.toolResult.command}`);
                        console.log(`     output: "${warpReqOptions.toolResult.output.substring(0, 80)}..."`);
                        console.log(`     query: "${query.substring(0, 100)}..."`);
                    } else {
                        console.log(`  -> calling Warp API (query len=${query.length})...`);
                    }
                    
                    // 使用带 429 重试的请求函数
                    const { response: warpResponse, credentialId } = await sendWarpRequestWithRetry(query, warpModel, warpReqOptions);
                    usedCredentialId = credentialId;
                    console.log(`  <- Warp response: text=${(warpResponse.text || '').length}c toolCalls=${(warpResponse.toolCalls || []).length}`);

                    let toolCalls = warpResponse.toolCalls || [];
                    const text = warpResponse.text || '';
                    fullContent = text;
                    
                    // 调试：打印实际响应内容
                    if (text) {
                        console.log(`  [SSE] sending text: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
                    }
                    if (toolCalls.length > 0) {
                        console.log(`  [SSE] sending ${toolCalls.length} tool_use blocks`);
                    }

                    res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'text', text: '' }
                    })}\n\n`);

                    if (text) {
                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                            type: 'content_block_delta',
                            index: 0,
                            delta: { type: 'text_delta', text }
                        })}\n\n`);
                    }

                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                        type: 'content_block_stop',
                        index: 0
                    })}\n\n`);

                    let blockIndex = 1;
                    if (toolCalls.length > 0) {
                        for (const tc of toolCalls) {
                            const toolUseId = tc.callId || `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                            
                            // 根据工具类型选择正确的工具名称和输入格式
                            let toolName = 'Bash';
                            let input = { command: tc.command };
                            
                            if (tc.toolName === 'Write' || tc.command === 'create_documents') {
                                toolName = 'Write';

                                // 调试：打印原始工具调用信息
                                console.log(`  [TOOL DEBUG] Original tool call:`, {
                                    toolName: tc.toolName,
                                    command: tc.command,
                                    filePath: tc.filePath,
                                    file_path: tc.file_path,
                                    path: tc.path,
                                    content: tc.content?.substring(0, 100) + '...',
                                    input: tc.input
                                });

                                // 更智能的文件路径提取
                                let filePath = tc.filePath || tc.file_path || tc.path ||
                                              (tc.input && tc.input.file_path) ||
                                              (tc.input && tc.input.path);

                                // 如果没有明确的文件路径，根据内容推断
                                if (!filePath) {
                                    const contentToCheck = tc.content || text || '';
                                    if (contentToCheck.includes('<!doctype html') || contentToCheck.includes('<html')) {
                                        filePath = 'login.html';
                                    } else if (contentToCheck.includes('function ') || contentToCheck.includes('const ') || contentToCheck.includes('import ')) {
                                        filePath = 'script.js';
                                    } else if (contentToCheck.includes('{') && contentToCheck.includes('}') && contentToCheck.includes(':')) {
                                        filePath = 'data.json';
                                    } else {
                                        filePath = 'output.md';
                                    }
                                    console.log(`  [TOOL] Inferred file type: ${filePath}`);
                                }

                                // 更完整的内容提取 - 关键修复：优先使用 text 内容
                                let writeContent = '';

                                // 1. 首先尝试工具调用中的内容
                                if (tc.content && tc.content.trim()) {
                                    writeContent = tc.content;
                                } else if (tc.input && tc.input.content && tc.input.content.trim()) {
                                    writeContent = tc.input.content;
                                }
                                // 2. 如果工具调用内容为空或只是描述，使用响应文本
                                else if (text && text.trim() && text.length > 100) {
                                    writeContent = text;
                                    console.log(`  [TOOL FIX] Using response text as Write content (${text.length} chars)`);
                                }
                                // 3. 最后的回退
                                else {
                                    writeContent = tc.content || text || '';
                                }

                                // 参数验证
                                if (!writeContent || writeContent.length < 10) {
                                    console.warn(`  [TOOL WARN] Write tool has insufficient content (${writeContent.length} chars)`);
                                }

                                input = {
                                    file_path: filePath,
                                    content: writeContent
                                };

                                console.log(`  [TOOL] Write: file_path=${input.file_path}, content.length=${writeContent.length}`);
                                console.log(`  [TOOL DEBUG] Processed input:`, {
                                    file_path: input.file_path,
                                    content_length: input.content?.length || 0,
                                    content_preview: input.content?.substring(0, 100) + '...'
                                });
                            }
                            
                            // 确保只传递必要的字段，移除可能的额外字段
                            const cleanInput = {};
                            if (toolName === 'Write') {
                                // 参数验证和修复
                                if (!input.file_path || input.file_path === 'undefined') {
                                    console.warn(`  [TOOL WARN] Invalid file_path: ${input.file_path}, using default`);
                                    input.file_path = 'output.md';
                                }
                                if (!input.content) {
                                    console.warn(`  [TOOL WARN] Empty content for Write tool`);
                                    input.content = '';
                                }

                                cleanInput.file_path = input.file_path;
                                cleanInput.content = input.content;

                                console.log(`  [TOOL FINAL] Write params: file_path="${cleanInput.file_path}", content_length=${cleanInput.content.length}`);
                            } else {
                                cleanInput.command = input.command;
                            }
                            const inputJson = JSON.stringify(cleanInput);

                            res.write(`event: content_block_start\ndata: ${JSON.stringify({
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} }
                            })}\n\n`);

                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'input_json_delta', partial_json: inputJson }
                            })}\n\n`);

                            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                                type: 'content_block_stop',
                                index: blockIndex
                            })}\n\n`);

                            blockIndex++;
                        }
                    }

                    const outputTokens = estimateTokens(fullContent);
                    const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

                    res.write(`event: message_delta\ndata: ${JSON.stringify({
                        type: 'message_delta',
                        delta: { stop_reason: stopReason, stop_sequence: null },
                        usage: { output_tokens: outputTokens }
                    })}\n\n`);

                    res.write(`event: message_stop\ndata: ${JSON.stringify({
                        type: 'message_stop'
                    })}\n\n`);

                    res.end();

                    const durationMs = Date.now() - startTime;
                    console.log(`  ✓ ${durationMs}ms | in=${inputTokens} out=${outputTokens}`);

                    await apiLogStore.create({
                        requestId,
                        apiKeyId,
                        apiKeyPrefix: req.apiKey?.keyPrefix || null,
                        credentialId: usedCredentialId || null,
                        ipAddress: req.ip || req.connection?.remoteAddress,
                        userAgent: req.headers['user-agent'],
                        method: 'POST',
                        path: '/w/v1/messages',
                        model: warpModel,
                        stream: true,
                        inputTokens,
                        outputTokens,
                        requestMessages: null,
                        responseContent: null,
                        statusCode: 200,
                        durationMs
                    });
                } catch (error) {
                    const durationMs = Date.now() - startTime;
                    console.error(`  ✗ ${durationMs}ms | error: ${error.message}`);

                    res.write(`event: error\ndata: ${JSON.stringify({
                        type: 'error',
                        error: { type: 'server_error', message: error.message }
                    })}\n\n`);
                    res.end();

                    await apiLogStore.create({
                        requestId,
                        apiKeyId,
                        apiKeyPrefix: req.apiKey?.keyPrefix || null,
                        credentialId: usedCredentialId || null,
                        ipAddress: req.ip || req.connection?.remoteAddress,
                        userAgent: req.headers['user-agent'],
                        method: 'POST',
                        path: '/w/v1/messages',
                        model: warpModel,
                        stream: true,
                        inputTokens,
                        outputTokens: 0,
                        requestMessages: null,
                        responseContent: null,
                        statusCode: 500,
                        errorMessage: error.message,
                        durationMs
                    });
                }
            } else {
                // 非流式响应 - 支持工具调用
                // 构建请求选项（与流式分支相同逻辑）
                const warpReqOptions = { workingDir };
                if (toolResultContent) {
                    warpReqOptions.toolResult = {
                        callId: toolResultContent.tool_use_id,
                        command: toolCommand || 'bash',
                        output: toolResultContent.content || ''
                    };
                }
                
                // 使用带 429 重试的请求函数
                const { response: warpResponse, credentialId: usedCredId } = await sendWarpRequestWithRetry(query, warpModel, warpReqOptions);
                
                let finalResponse = warpResponse.text || '';
                const toolCalls = warpResponse.toolCalls || [];
                
                // 构建响应内容
                const contentBlocks = [];
                
                // 添加文本内容
                if (finalResponse) {
                    contentBlocks.push({
                        type: 'text',
                        text: finalResponse
                    });
                }
                
                // 如果有工具调用，添加 tool_use 块
                if (toolCalls.length > 0) {
                    for (const tc of toolCalls) {
                        const toolUseId = tc.callId || `toolu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                        
                        // 根据工具类型选择正确的工具名称和输入格式
                        let toolName = 'Bash';
                        let input = { command: tc.command };
                        
                        if (tc.toolName === 'Write' || tc.command === 'create_documents') {
                            toolName = 'Write';

                            // 调试：打印原始工具调用信息
                            console.log(`  [TOOL DEBUG] Original tool call (non-stream):`, {
                                toolName: tc.toolName,
                                command: tc.command,
                                filePath: tc.filePath,
                                file_path: tc.file_path,
                                path: tc.path,
                                content: tc.content?.substring(0, 100) + '...',
                                input: tc.input
                            });

                            // 更智能的文件路径提取
                            let filePath = tc.filePath || tc.file_path || tc.path ||
                                          (tc.input && tc.input.file_path) ||
                                          (tc.input && tc.input.path);

                            // 如果没有明确的文件路径，根据内容推断
                            if (!filePath) {
                                const contentToCheck = tc.content || finalResponse || '';
                                if (contentToCheck.includes('<!doctype html') || contentToCheck.includes('<html')) {
                                    filePath = 'login.html';
                                } else if (contentToCheck.includes('function ') || contentToCheck.includes('const ') || contentToCheck.includes('import ')) {
                                    filePath = 'script.js';
                                } else if (contentToCheck.includes('{') && contentToCheck.includes('}') && contentToCheck.includes(':')) {
                                    filePath = 'data.json';
                                } else {
                                    filePath = 'output.md';
                                }
                                console.log(`  [TOOL] Inferred file type (non-stream): ${filePath}`);
                            }

                            // 更完整的内容提取 - 关键修复：优先使用 finalResponse 内容
                            let writeContent = '';

                            // 1. 首先尝试工具调用中的内容
                            if (tc.content && tc.content.trim()) {
                                writeContent = tc.content;
                            } else if (tc.input && tc.input.content && tc.input.content.trim()) {
                                writeContent = tc.input.content;
                            }
                            // 2. 如果工具调用内容为空或只是描述，使用响应文本
                            else if (finalResponse && finalResponse.trim() && finalResponse.length > 100) {
                                writeContent = finalResponse;
                                console.log(`  [TOOL FIX] Using response text as Write content (${finalResponse.length} chars)`);
                            }
                            // 3. 最后的回退
                            else {
                                writeContent = tc.content || finalResponse || '';
                            }

                            // 参数验证
                            if (!writeContent || writeContent.length < 10) {
                                console.warn(`  [TOOL WARN] Write tool has insufficient content (${writeContent.length} chars)`);
                            }

                            input = {
                                file_path: filePath,
                                content: writeContent
                            };

                            console.log(`  [TOOL] Write: file_path=${input.file_path}, content.length=${writeContent.length}`);
                            console.log(`  [TOOL DEBUG] Processed input (non-stream):`, {
                                file_path: input.file_path,
                                content_length: input.content?.length || 0,
                                content_preview: input.content?.substring(0, 100) + '...'
                            });
                        }
                        
                        // 确保只传递必要的字段，移除可能的额外字段如 description
                        const cleanInput = {};
                        if (toolName === 'Write') {
                            // 参数验证和修复
                            if (!input.file_path || input.file_path === 'undefined') {
                                console.warn(`  [TOOL WARN] Invalid file_path: ${input.file_path}, using default`);
                                input.file_path = 'output.md';
                            }
                            if (!input.content) {
                                console.warn(`  [TOOL WARN] Empty content for Write tool`);
                                input.content = '';
                            }

                            cleanInput.file_path = input.file_path;
                            cleanInput.content = input.content;

                            console.log(`  [TOOL FINAL] Write params (non-stream): file_path="${cleanInput.file_path}", content_length=${cleanInput.content.length}`);
                        } else {
                            cleanInput.command = input.command;
                        }
                        
                        contentBlocks.push({
                            type: 'tool_use',
                            id: toolUseId,
                            name: toolName,
                            input: cleanInput
                        });
                    }
                }
                
                // 如果没有内容，添加默认提示
                if (contentBlocks.length === 0) {
                    contentBlocks.push({
                        type: 'text',
                        text: '请问有什么可以帮助你的？'
                    });
                }

                const outputTokens = estimateTokens(finalResponse);
                const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

                const durationMs = Date.now() - startTime;
                console.log(`  ✓ ${durationMs}ms | in=${inputTokens} out=${outputTokens}`);

                // 记录统计到 api_logs
                await apiLogStore.create({
                    requestId,
                    apiKeyId,
                    apiKeyPrefix: req.apiKey?.keyPrefix || null,
                    credentialId: usedCredId,
                    ipAddress: req.ip || req.connection?.remoteAddress,
                    userAgent: req.headers['user-agent'],
                    method: 'POST',
                    path: '/w/v1/messages',
                    model: warpModel,
                    stream: false,
                    inputTokens,
                    outputTokens,
                    requestMessages: null,
                    responseContent: null,
                    statusCode: 200,
                    durationMs
                });

                // 生成会话 ID 用于连续对话
                const newSessionId = crypto.randomUUID();
                messagesSessions.set(newSessionId, {
                    credentialId: usedCredId,
                    query,
                    model: warpModel,
                    workingDir,
                    toolCalls,
                    createdAt: Date.now()
                });
                
                // 清理过期会话
                for (const [id, session] of messagesSessions) {
                    if (Date.now() - session.createdAt > 30 * 60 * 1000) {
                        messagesSessions.delete(id);
                    }
                }

                res.json({
                    id: `msg_${Date.now()}`,
                    type: 'message',
                    role: 'assistant',
                    content: contentBlocks,
                    model: warpModel,
                    stop_reason: stopReason,
                    stop_sequence: null,
                    usage: {
                        input_tokens: inputTokens,
                        output_tokens: outputTokens
                    },
                    // 扩展字段：会话 ID 用于连续对话
                    metadata: {
                        session_id: newSessionId,
                        has_tool_calls: toolCalls.length > 0
                    }
                });
            }
        } catch (error) {
            const durationMs = Date.now() - startTime;
            console.error(`  ✗ ${durationMs}ms | error: ${error.message}`);

            // 记录错误统计到 api_logs
            await apiLogStore.create({
                requestId,
                apiKeyId,
                apiKeyPrefix: req.apiKey?.keyPrefix || null,
                credentialId: null,
                ipAddress: req.ip || req.connection?.remoteAddress,
                userAgent: req.headers['user-agent'],
                method: 'POST',
                path: '/w/v1/messages',
                model: req.body?.model || 'unknown',
                stream: req.body?.stream || false,
                inputTokens: 0,
                outputTokens: 0,
                requestMessages: null,
                responseContent: null,
                statusCode: 500,
                errorMessage: error.message,
                durationMs
            });

            res.status(500).json({
                type: 'error',
                error: {
                    type: 'server_error',
                    message: error.message
                }
            });
        }
    });

    // 工具执行端点 - 用户确认后执行 bash 命令
    // 配合 /w/v1/messages 的 tool_use 返回使用
    app.post('/w/v1/tools/execute', verifyWarpApiKey, async (req, res) => {
        try {
            const { tool_use_id, command, working_dir } = req.body;

            console.log('\n' + '-'.repeat(80));
            console.log(`[${new Date().toISOString()}] /w/v1/tools/execute 请求`);
            console.log('-'.repeat(80));
            console.log(`API Key: ${req.apiKey?.keyPrefix || 'unknown'}***`);
            console.log(`IP: ${req.ip || req.connection?.remoteAddress}`);
            console.log(`User-Agent: ${req.headers['user-agent']}`);
            console.log(`tool_use_id: ${tool_use_id || 'unknown'}`);
            console.log(`command: ${command || 'unknown'}`);
            console.log(`working_dir: ${working_dir || '/tmp'}`);
            console.log('-'.repeat(80));

            if (!command) {
                return res.status(400).json({
                    type: 'error',
                    error: { type: 'invalid_request_error', message: '请提供 command' }
                });
            }

            const cwd = working_dir || '/tmp';

            // 执行命令
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);

            let result;
            try {
                const { stdout, stderr } = await execAsync(command, { 
                    cwd, 
                    timeout: 60000,
                    maxBuffer: 5 * 1024 * 1024 
                });
                result = {
                    success: true,
                    tool_use_id: tool_use_id || `toolu_${Date.now()}`,
                    output: stdout.trim() || stderr.trim() || '命令执行成功（无输出）',
                    command,
                    working_dir: cwd
                };
            } catch (execError) {
                result = {
                    success: false,
                    tool_use_id: tool_use_id || `toolu_${Date.now()}`,
                    output: execError.stderr?.trim() || execError.stdout?.trim() || execError.message,
                    error: execError.message,
                    command,
                    working_dir: cwd
                };
            }

            console.log(`[${new Date().toISOString()}] /w/v1/tools/execute: ${command} -> ${result.success ? 'success' : 'error'}`);

            res.json({
                type: 'tool_result',
                ...result
            });
        } catch (error) {
            res.status(500).json({
                type: 'error',
                error: { type: 'server_error', message: error.message }
            });
        }
    });

    // ============ W2 Claude 格式端点（完整多轮工具调用） ============
    
    // Warp Claude 格式 V2 - /w2/v1/messages
    // 支持完整的多轮对话和工具自动执行
    app.post('/w2/v1/messages', verifyWarpApiKey, async (req, res) => {
        const startTime = Date.now();
        const apiKeyId = req.apiKey?.id || null;
        const requestId = generateRequestId();
        
        console.log('\n' + '='.repeat(80));
        console.log(`[${new Date().toISOString()}] /w2/v1/messages 请求 (多轮工具模式)`);
        console.log('='.repeat(80));
        console.log(`请求ID: ${requestId}`);
        console.log(`API Key: ${req.apiKey?.keyPrefix || 'unknown'}***`);
        console.log('-'.repeat(40));
        
        try {
            const { model, messages, max_tokens, stream, system } = req.body;
            
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: 'messages is required'
                    }
                });
            }
            
            // 获取 WarpProxy 实例
            const { proxy, credential } = await getWarpProxy();
            
            // 构建查询
            let query = '';
            if (system) {
                query += `[System] ${system}\n\n`;
            }
            query += messages.map(m => {
                if (m.role === 'user') {
                    if (typeof m.content === 'string') return m.content;
                    if (Array.isArray(m.content)) {
                        return m.content.map(c => c.type === 'text' ? c.text : '').join('');
                    }
                    return '';
                }
                if (m.role === 'assistant') {
                    if (typeof m.content === 'string') return `[Assistant] ${m.content}`;
                    if (Array.isArray(m.content)) {
                        return `[Assistant] ${m.content.map(c => c.type === 'text' ? c.text : '').join('')}`;
                    }
                    return '';
                }
                return '';
            }).join('\n\n');
            
            const warpModel = mapModelToWarp(model);
            const inputTokens = estimateTokens(query);
            
            // 从请求中获取或创建 sessionId
            const sessionId = req.headers['x-session-id'] || `session-${Date.now()}`;
            
            // 设置上下文
            const context = {
                workingDir: req.headers['x-working-dir'] || process.cwd(),
                homeDir: process.env.HOME || '/tmp',
                shell: 'zsh',
                shellVersion: '5.9',
                repoName: req.headers['x-repo-name'] || '',
                gitBranch: req.headers['x-git-branch'] || 'master'
            };
            
            if (stream) {
                // 流式响应
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Session-Id', sessionId);
                
                const messageId = `msg_${Date.now()}`;
                let fullContent = '';
                let totalToolCalls = [];
                
                // 发送 message_start
                res.write(`event: message_start\ndata: ${JSON.stringify({
                    type: 'message_start',
                    message: {
                        id: messageId,
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: warpModel,
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: inputTokens, output_tokens: 0 }
                    }
                })}\n\n`);
                
                // 发送 content_block_start
                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' }
                })}\n\n`);
                
                try {
                    // 使用 WarpProxy 的流式接口
                    for await (const event of proxy.chatStream(sessionId, query, { model: warpModel, context })) {
                        if (event.type === 'text') {
                            fullContent += event.content;
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'text_delta', text: event.content }
                            })}\n\n`);
                        } else if (event.type === 'tool_call') {
                            // 发送工具调用信息（作为文本）
                            const toolInfo = `\n[执行工具: ${event.command}]\n`;
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'text_delta', text: toolInfo }
                            })}\n\n`);
                        } else if (event.type === 'tool_result') {
                            totalToolCalls.push(event);
                            // 发送工具结果（简略版）
                            const resultInfo = `[结果: ${event.result?.output?.substring(0, 200) || ''}...]\n`;
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'text_delta', text: resultInfo }
                            })}\n\n`);
                        } else if (event.type === 'iteration_start') {
                            console.log(`[迭代 ${event.iteration}] 开始...`);
                        }
                    }
                    
                    const outputTokens = estimateTokens(fullContent);
                    
                    // content_block_stop
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                        type: 'content_block_stop',
                        index: 0
                    })}\n\n`);
                    
                    // message_delta
                    res.write(`event: message_delta\ndata: ${JSON.stringify({
                        type: 'message_delta',
                        delta: { stop_reason: 'end_turn', stop_sequence: null },
                        usage: { output_tokens: outputTokens }
                    })}\n\n`);
                    
                    // message_stop
                    res.write(`event: message_stop\ndata: ${JSON.stringify({
                        type: 'message_stop'
                    })}\n\n`);
                    
                    res.end();
                    
                    // 记录日志
                    const durationMs = Date.now() - startTime;
                    console.log(`[${new Date().toISOString()}] /w2/v1/messages 完成`);
                    console.log(`耗时: ${durationMs}ms, 工具调用: ${totalToolCalls.length}次`);
                    console.log('='.repeat(80) + '\n');
                    
                    await apiLogStore.create({
                        requestId,
                        apiKeyId,
                        apiKeyPrefix: req.apiKey?.keyPrefix || null,
                        credentialId: credential.id,
                        ipAddress: req.ip || req.connection?.remoteAddress,
                        userAgent: req.headers['user-agent'],
                        method: 'POST',
                        path: '/w2/v1/messages',
                        model: warpModel,
                        stream: true,
                        inputTokens,
                        outputTokens,
                        requestMessages: null,
                        responseContent: null,
                        statusCode: 200,
                        durationMs
                    });
                    
                    await warpStore.incrementUseCount(credential.id);
                    
                } catch (streamError) {
                    res.write(`event: error\ndata: ${JSON.stringify({
                        type: 'error',
                        error: { type: 'server_error', message: streamError.message }
                    })}\n\n`);
                    res.end();
                }
                
            } else {
                // 非流式响应
                const result = await proxy.chat(sessionId, query, { model: warpModel, context });
                
                const finalResponse = result.response || '';
                const outputTokens = estimateTokens(finalResponse);
                
                const durationMs = Date.now() - startTime;
                console.log(`[${new Date().toISOString()}] /w2/v1/messages 完成`);
                console.log(`耗时: ${durationMs}ms, 工具调用: ${result.toolCalls?.length || 0}次, 迭代: ${result.iterations}次`);
                console.log('='.repeat(80) + '\n');
                
                await apiLogStore.create({
                    requestId,
                    apiKeyId,
                    apiKeyPrefix: req.apiKey?.keyPrefix || null,
                    credentialId: credential.id,
                    ipAddress: req.ip || req.connection?.remoteAddress,
                    userAgent: req.headers['user-agent'],
                    method: 'POST',
                    path: '/w2/v1/messages',
                    model: warpModel,
                    stream: false,
                    inputTokens,
                    outputTokens,
                    requestMessages: null,
                    responseContent: null,
                    statusCode: 200,
                    durationMs
                });
                
                await warpStore.incrementUseCount(credential.id);
                
                res.setHeader('X-Session-Id', result.sessionId);
                res.setHeader('X-Tool-Calls', result.toolCalls?.length || 0);
                res.setHeader('X-Iterations', result.iterations);
                
                res.json({
                    id: `msg_${Date.now()}`,
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'text',
                        text: finalResponse
                    }],
                    model: warpModel,
                    stop_reason: 'end_turn',
                    stop_sequence: null,
                    usage: {
                        input_tokens: inputTokens,
                        output_tokens: outputTokens
                    }
                });
            }
            
        } catch (error) {
            const durationMs = Date.now() - startTime;
            console.log(`[${new Date().toISOString()}] /w2/v1/messages 错误: ${error.message}`);
            console.log('='.repeat(80) + '\n');
            
            await apiLogStore.create({
                requestId,
                apiKeyId,
                apiKeyPrefix: req.apiKey?.keyPrefix || null,
                credentialId: null,
                ipAddress: req.ip || req.connection?.remoteAddress,
                userAgent: req.headers['user-agent'],
                method: 'POST',
                path: '/w2/v1/messages',
                model: req.body?.model || 'unknown',
                stream: req.body?.stream || false,
                inputTokens: 0,
                outputTokens: 0,
                requestMessages: null,
                responseContent: null,
                statusCode: 500,
                errorMessage: error.message,
                durationMs
            });
            
            res.status(500).json({
                type: 'error',
                error: {
                    type: 'server_error',
                    message: error.message
                }
            });
        }
    });

    // ============ Gemini 格式端点 ============

    // Warp Gemini 格式 - /w/v1beta/models/:model:generateContent
    app.post('/w/v1beta/models/:model\\:generateContent', verifyWarpApiKey, async (req, res) => {
        const startTime = Date.now();
        const apiKeyId = req.apiKey?.id || null;
        
        try {
            const { contents, systemInstruction } = req.body;
            const model = req.params.model || 'claude-4.1-opus';

            if (!contents || !Array.isArray(contents) || contents.length === 0) {
                return res.status(400).json({
                    error: {
                        code: 400,
                        message: 'contents is required',
                        status: 'INVALID_ARGUMENT'
                    }
                });
            }

            // 构建查询
            let query = '';
            if (systemInstruction && systemInstruction.parts) {
                query += `[System] ${systemInstruction.parts.map(p => p.text).join('')}\n\n`;
            }
            query += contents.map(c => {
                const text = c.parts ? c.parts.map(p => p.text).join('') : '';
                if (c.role === 'user') return text;
                if (c.role === 'model') return `[Assistant] ${text}`;
                return text;
            }).join('\n\n');

            // 将外部模型名转换为 Warp 支持的模型名
            const warpModel = mapModelToWarp(model);
            const inputTokens = estimateTokens(query);
            const result = await warpService.chat(query, warpModel);
            const outputTokens = estimateTokens(result.response);

            // 记录统计到 api_logs（不记录消息内容）
            await apiLogStore.create({
                requestId: generateRequestId(),
                apiKeyId,
                apiKeyPrefix: req.apiKey?.keyPrefix || null,
                credentialId: result.credentialId || null,
                ipAddress: req.ip || req.connection?.remoteAddress,
                userAgent: req.headers['user-agent'],
                method: 'POST',
                path: '/w/v1beta/generateContent',
                model: warpModel,
                stream: false,
                inputTokens,
                outputTokens,
                requestMessages: null,
                responseContent: null,
                statusCode: 200,
                durationMs: Date.now() - startTime
            });

            res.json({
                candidates: [{
                    content: {
                        parts: [{ text: result.response }],
                        role: 'model'
                    },
                    finishReason: 'STOP',
                    index: 0
                }],
                usageMetadata: {
                    promptTokenCount: inputTokens,
                    candidatesTokenCount: outputTokens,
                    totalTokenCount: inputTokens + outputTokens
                }
            });
        } catch (error) {
            // 记录错误统计到 api_logs
            await apiLogStore.create({
                requestId: generateRequestId(),
                apiKeyId,
                apiKeyPrefix: req.apiKey?.keyPrefix || null,
                credentialId: null,
                ipAddress: req.ip || req.connection?.remoteAddress,
                userAgent: req.headers['user-agent'],
                method: 'POST',
                path: '/w/v1beta/generateContent',
                model: req.params?.model || 'unknown',
                stream: false,
                inputTokens: 0,
                outputTokens: 0,
                requestMessages: null,
                responseContent: null,
                statusCode: 500,
                errorMessage: error.message,
                durationMs: Date.now() - startTime
            });
            
            res.status(500).json({
                error: {
                    code: 500,
                    message: error.message,
                    status: 'INTERNAL'
                }
            });
        }
    });

    // Warp Gemini 流式 - /w/v1beta/models/:model:streamGenerateContent
    app.post('/w/v1beta/models/:model\\:streamGenerateContent', verifyWarpApiKey, async (req, res) => {
        const startTime = Date.now();
        const apiKeyId = req.apiKey?.id || null;
        
        try {
            const { contents, systemInstruction } = req.body;

            if (!contents || !Array.isArray(contents) || contents.length === 0) {
                return res.status(400).json({
                    error: {
                        code: 400,
                        message: 'contents is required',
                        status: 'INVALID_ARGUMENT'
                    }
                });
            }

            // 构建查询
            let query = '';
            if (systemInstruction && systemInstruction.parts) {
                query += `[System] ${systemInstruction.parts.map(p => p.text).join('')}\n\n`;
            }
            query += contents.map(c => {
                const text = c.parts ? c.parts.map(p => p.text).join('') : '';
                if (c.role === 'user') return text;
                if (c.role === 'model') return `[Assistant] ${text}`;
                return text;
            }).join('\n\n');

            // 将外部模型名转换为 Warp 支持的模型名
            const warpModel = mapModelToWarp(req.params.model);
            const inputTokens = estimateTokens(query);
            let fullContent = '';
            let usedCredentialId = null;

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            warpService.chatStream(
                query,
                warpModel,
                (content, credentialId) => {
                    fullContent += content;
                    if (credentialId) usedCredentialId = credentialId;
                    const chunk = {
                        candidates: [{
                            content: {
                                parts: [{ text: content }],
                                role: 'model'
                            },
                            index: 0
                        }]
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                },
                async (credentialId) => {
                    if (credentialId) usedCredentialId = credentialId;
                    const outputTokens = estimateTokens(fullContent);
                    
                    const endChunk = {
                        candidates: [{
                            content: {
                                parts: [{ text: '' }],
                                role: 'model'
                            },
                            finishReason: 'STOP',
                            index: 0
                        }],
                        usageMetadata: {
                            promptTokenCount: inputTokens,
                            candidatesTokenCount: outputTokens,
                            totalTokenCount: inputTokens + outputTokens
                        }
                    };
                    res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
                    res.end();
                    
                    // 记录统计到 api_logs（不记录消息内容）
                    await apiLogStore.create({
                        requestId: generateRequestId(),
                        apiKeyId,
                        apiKeyPrefix: req.apiKey?.keyPrefix || null,
                        credentialId: usedCredentialId || null,
                        ipAddress: req.ip || req.connection?.remoteAddress,
                        userAgent: req.headers['user-agent'],
                        method: 'POST',
                        path: '/w/v1beta/streamGenerateContent',
                        model: warpModel,
                        stream: true,
                        inputTokens,
                        outputTokens,
                        requestMessages: null,
                        responseContent: null,
                        statusCode: 200,
                        durationMs: Date.now() - startTime
                    });
                },
                async (error, credentialId) => {
                    res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                    res.end();
                    
                    // 记录错误统计到 api_logs
                    await apiLogStore.create({
                        requestId: generateRequestId(),
                        apiKeyId,
                        apiKeyPrefix: req.apiKey?.keyPrefix || null,
                        credentialId: credentialId || null,
                        ipAddress: req.ip || req.connection?.remoteAddress,
                        userAgent: req.headers['user-agent'],
                        method: 'POST',
                        path: '/w/v1beta/streamGenerateContent',
                        model: warpModel,
                        stream: true,
                        inputTokens,
                        outputTokens: 0,
                        requestMessages: null,
                        responseContent: null,
                        statusCode: 500,
                        errorMessage: error.message,
                        durationMs: Date.now() - startTime
                    });
                }
            );
        } catch (error) {
            // 记录错误统计到 api_logs
            await apiLogStore.create({
                requestId: generateRequestId(),
                apiKeyId,
                apiKeyPrefix: req.apiKey?.keyPrefix || null,
                credentialId: null,
                ipAddress: req.ip || req.connection?.remoteAddress,
                userAgent: req.headers['user-agent'],
                method: 'POST',
                path: '/w/v1beta/streamGenerateContent',
                model: req.params?.model || 'unknown',
                stream: true,
                inputTokens: 0,
                outputTokens: 0,
                requestMessages: null,
                responseContent: null,
                statusCode: 500,
                errorMessage: error.message,
                durationMs: Date.now() - startTime
            });
            
            res.status(500).json({
                error: {
                    code: 500,
                    message: error.message,
                    status: 'INTERNAL'
                }
            });
        }
    });

    // ============ 用量查询端点 ============

    // 查询单个账户用量（并保存到数据库）
    app.get('/w/api/quota', async (req, res) => {
        try {
            const { credentialId } = req.query;
            const quota = await warpService.getQuota(credentialId);
            
            // 保存用量到数据库
            if (quota.credentialId && !quota.error) {
                await warpStore.updateQuota(quota.credentialId, quota.requestLimit, quota.requestsUsed);
            }
            
            res.json({ success: true, data: quota });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 查询所有账户用量（并保存到数据库）
    app.get('/w/api/quotas', async (req, res) => {
        try {
            const quotas = await warpService.getAllQuotas();
            
            // 计算汇总信息并保存用量到数据库
            const summary = {
                totalAccounts: quotas.length,
                totalLimit: 0,
                totalUsed: 0,
                totalRemaining: 0,
                unlimitedAccounts: 0,
                errorAccounts: 0
            };
            
            for (const q of quotas) {
                if (q.error) {
                    summary.errorAccounts++;
                } else if (q.isUnlimited) {
                    summary.unlimitedAccounts++;
                    // 保存用量到数据库
                    await warpStore.updateQuota(q.credentialId, -1, 0);
                } else {
                    summary.totalLimit += q.requestLimit;
                    summary.totalUsed += q.requestsUsed;
                    summary.totalRemaining += q.requestsRemaining;
                    // 保存用量到数据库
                    await warpStore.updateQuota(q.credentialId, q.requestLimit, q.requestsUsed);
                }
            }
            
            res.json({ 
                success: true, 
                data: {
                    summary,
                    accounts: quotas
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    console.log('[Warp] 路由已设置');
    console.log('[Warp] 支持的端点:');
    console.log('[Warp]   OpenAI 格式: /w/v1/chat/completions');
    console.log('[Warp]   Claude 格式: /w/v1/messages');
    console.log('[Warp]   Gemini 格式: /w/v1beta/models/{model}:generateContent');
    console.log('[Warp]   模型列表:   /w/v1/models');
    console.log('[Warp]   用量查询:   /w/api/quota, /w/api/quotas');
}
