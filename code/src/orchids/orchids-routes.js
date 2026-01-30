/**
 * Orchids API 路由
 * 整合自 orchids-api-main 的功能
 */
import { OrchidsAPI } from './orchids-service.js';
import { OrchidsChatService, ORCHIDS_MODELS } from './orchids-chat-service.js';
import { getOrchidsLoadBalancer } from './orchids-loadbalancer.js';
import { startRegisterTask, getRegisterTask, getAllRegisterTasks, cancelRegisterTask } from './orchids-register.js';

export function setupOrchidsRoutes(app, orchidsStore) {
    
    // ============ 自动注册功能 ============

    // 启动注册任务
    app.post('/api/orchids/register/start', async (req, res) => {
        try {
            const { count = 1 } = req.body;
            
            if (count < 1 || count > 50) {
                return res.status(400).json({ success: false, error: '注册数量必须在 1-50 之间' });
            }

            // 获取当前服务器地址
            const protocol = req.protocol;
            const host = req.get('host');
            const serverUrl = `${protocol}://${host}`;

            const taskId = await startRegisterTask(count, orchidsStore, serverUrl);
            
            res.json({ 
                success: true, 
                taskId,
                message: `注册任务已启动，目标: ${count} 个账号`
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取注册任务状态
    app.get('/api/orchids/register/task/:taskId', async (req, res) => {
        try {
            const { taskId } = req.params;
            const task = getRegisterTask(taskId);
            
            if (!task) {
                return res.status(404).json({ success: false, error: '任务不存在' });
            }
            
            res.json({ success: true, data: task.toJSON() });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取所有注册任务
    app.get('/api/orchids/register/tasks', async (req, res) => {
        try {
            const tasks = getAllRegisterTasks();
            res.json({ success: true, data: tasks });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 取消注册任务
    app.post('/api/orchids/register/cancel/:taskId', async (req, res) => {
        try {
            const { taskId } = req.params;
            const cancelled = cancelRegisterTask(taskId);
            
            if (!cancelled) {
                return res.status(404).json({ success: false, error: '任务不存在或已结束' });
            }
            
            res.json({ success: true, message: '任务已取消' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // SSE 实时日志流
    app.get('/api/orchids/register/stream/:taskId', async (req, res) => {
        const { taskId } = req.params;
        const task = getRegisterTask(taskId);
        
        if (!task) {
            return res.status(404).json({ success: false, error: '任务不存在' });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        let lastLogIndex = 0;

        const sendUpdate = () => {
            const data = task.toJSON();
            
            // 只发送新日志
            const newLogs = data.logs.slice(lastLogIndex);
            lastLogIndex = data.logs.length;
            
            res.write(`data: ${JSON.stringify({ ...data, newLogs })}\n\n`);
        };

        // 立即发送当前状态
        sendUpdate();

        // 定期发送更新
        const interval = setInterval(() => {
            if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') {
                sendUpdate();
                clearInterval(interval);
                res.end();
                return;
            }
            sendUpdate();
        }, 1000);

        // 客户端断开连接
        req.on('close', () => {
            clearInterval(interval);
        });
    });

    // ============ 统计信息 API ============

    // 获取 Orchids 统计汇总
    app.get('/api/orchids/stats', async (req, res) => {
        try {
            const stats = await orchidsStore.getStats();
            res.json({ success: true, data: stats });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 强制刷新负载均衡器缓存
    app.post('/api/orchids/loadbalancer/refresh', async (req, res) => {
        try {
            const lb = await getOrchidsLoadBalancer(orchidsStore);
            if (lb) {
                await lb.forceRefresh();
                res.json({ success: true, message: '负载均衡器缓存已刷新' });
            } else {
                res.json({ success: false, error: '负载均衡器未初始化' });
            }
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    // ============ Orchids 凭证管理 ============

    // 获取所有 Orchids 凭证
    app.get('/api/orchids/credentials', async (req, res) => {
        try {
            const credentials = await orchidsStore.getAll();
            res.json({ success: true, data: credentials });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取单个 Orchids 凭证
    app.get('/api/orchids/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await orchidsStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }
            res.json({ success: true, data: credential });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取所有账号的健康状态
    app.get('/api/orchids/credentials/health', async (req, res) => {
        try {
            const credentials = await orchidsStore.getAll();
            const healthData = await OrchidsAPI.batchHealthCheck(credentials);
            res.json(healthData);
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 添加 Orchids 凭证 - 只需输入 clientJwt，自动获取其他信息
    app.post('/api/orchids/credentials', async (req, res) => {
        try {
            let { name, email, clientJwt, client_cookie, weight, enabled } = req.body;
            
            // 兼容 orchids-api-main 的字段名
            const token = clientJwt || client_cookie;

            if (!token) {
                return res.status(400).json({ success: false, error: 'clientJwt 或 client_cookie 是必需的' });
            }

            // 使用增强的方法获取完整账号信息（包括 email）
            const accountInfo = await OrchidsAPI.getFullAccountInfo(token);
            if (!accountInfo.success) {
                return res.status(400).json({ success: false, error: `Token 验证失败: ${accountInfo.error}` });
            }

            // 如果没有提供 name，使用 email 或生成一个
            const finalName = name || accountInfo.email || `orchids-${Date.now()}`;
            // 优先使用 API 返回的 email
            const finalEmail = accountInfo.email || email;

            // 检查名称是否已存在
            const existing = await orchidsStore.getByName(finalName);
            if (existing) {
                return res.status(400).json({ success: false, error: '凭证名称已存在' });
            }

            const id = await orchidsStore.add({
                name: finalName,
                email: finalEmail,
                clientJwt: token,
                clerkSessionId: accountInfo.sessionId,
                userId: accountInfo.userId,
                expiresAt: accountInfo.expiresAt,
                weight: weight || 1,
                isActive: enabled !== false
            });

            // 刷新负载均衡器缓存
            const lb = await getOrchidsLoadBalancer(orchidsStore);
            if (lb) await lb.forceRefresh();

            res.json({ 
                success: true, 
                data: { 
                    id,
                    name: finalName,
                    email: finalEmail,
                    userId: accountInfo.userId,
                    sessionId: accountInfo.sessionId,
                    expiresAt: accountInfo.expiresAt,
                    weight: weight || 1
                } 
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 批量导入 Orchids 凭证
    app.post('/api/orchids/credentials/batch-import', async (req, res) => {
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
                    const { email, clientJwt, client_jwt, refreshToken, refresh_token } = account;
                    // 支持多种字段名：clientJwt, client_jwt, refreshToken, refresh_token
                    const token = clientJwt || client_jwt || refreshToken || refresh_token;

                    if (!token) {
                        results.failed++;
                        results.errors.push({ email, error: '缺少 clientJwt/refreshToken' });
                        continue;
                    }

                    // 检查是否已存在
                    const name = email || `orchids-${Date.now()}`;
                    const existing = await orchidsStore.getByName(name);
                    if (existing) {
                        results.failed++;
                        results.errors.push({ email, error: '凭证已存在' });
                        continue;
                    }

                    // 验证 token 信息
                    const sessionResult = await OrchidsAPI.getSessionFromClerk(token);
                    if (!sessionResult.success) {
                        results.failed++;
                        results.errors.push({ email, error: `Token 验证失败: ${sessionResult.error}` });
                        continue;
                    }

                    // 添加凭证
                    await orchidsStore.add({
                        name,
                        email,
                        clientJwt: token,
                        clerkSessionId: sessionResult.sessionId,
                        userId: sessionResult.userId,
                        expiresAt: sessionResult.expiresAt
                    });

                    results.success++;
                } catch (err) {
                    results.failed++;
                    results.errors.push({ email: account.email, error: err.message });
                }
            }

            res.json({
                success: true,
                data: results,
                message: `成功导入 ${results.success} 个账号，失败 ${results.failed} 个`
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 更新 Orchids 凭证
    app.put('/api/orchids/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const { name, email, clientJwt, weight, enabled } = req.body;
            
            const updateData = { name, email, clientJwt };
            if (weight !== undefined) {
                await orchidsStore.updateWeight(id, weight);
            }
            if (enabled !== undefined) {
                updateData.isActive = enabled;
            }
            
            await orchidsStore.update(id, updateData);
            
            // 刷新负载均衡器缓存
            const lb = await getOrchidsLoadBalancer(orchidsStore);
            if (lb) await lb.forceRefresh();
            
            res.json({ success: true, message: '凭证更新成功' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 更新账号权重
    app.put('/api/orchids/credentials/:id/weight', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const { weight } = req.body;
            
            if (weight === undefined || weight < 0) {
                return res.status(400).json({ success: false, error: '权重必须是非负整数' });
            }
            
            await orchidsStore.updateWeight(id, weight);
            
            // 刷新负载均衡器缓存
            const lb = await getOrchidsLoadBalancer(orchidsStore);
            if (lb) await lb.forceRefresh();
            
            res.json({ success: true, message: '权重更新成功' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 重置账号统计计数
    app.post('/api/orchids/credentials/:id/reset-counts', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await orchidsStore.resetCounts(id);
            res.json({ success: true, message: '统计计数已重置' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除 Orchids 凭证
    app.delete('/api/orchids/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await orchidsStore.delete(id);
            res.json({ success: true, message: '凭证删除成功' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 激活 Orchids 凭证
    app.post('/api/orchids/credentials/:id/activate', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await orchidsStore.setActive(id);
            res.json({ success: true, message: '凭证已激活' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试 Orchids 凭证
    app.post('/api/orchids/credentials/:id/test', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await orchidsStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            // 验证 token
            const result = await OrchidsAPI.validateToken(credential.clientJwt);

            if (result.success && result.valid) {
                // 更新凭证信息
                await orchidsStore.update(id, {
                    expiresAt: result.expiresAt
                });
                await orchidsStore.resetErrorCount(id);

                res.json({
                    success: true,
                    valid: true,
                    data: {
                        userId: result.userId,
                        sessionId: result.sessionId,
                        expiresAt: result.expiresAt
                    },
                    message: 'Token 有效'
                });
            } else {
                await orchidsStore.incrementErrorCount(id, result.error || 'Token 无效');
                res.json({
                    success: true,
                    valid: false,
                    error: result.error,
                    message: 'Token 无效'
                });
            }
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取 Orchids 错误凭证列表
    app.get('/api/orchids/error-credentials', async (req, res) => {
        try {
            const errors = await orchidsStore.getAllErrors();
            res.json({ success: true, data: errors });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    // 删除 Orchids 错误凭证
    app.delete('/api/orchids/error-credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await orchidsStore.deleteError(id);
            res.json({ success: true, message: '错误凭证已删除' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 刷新 Orchids 错误凭证并恢复
    app.post('/api/orchids/error-credentials/:id/refresh', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const { clientJwt } = req.body;

            const errorCred = await orchidsStore.getErrorById(id);
            if (!errorCred) {
                return res.status(404).json({ success: false, error: '错误凭证不存在' });
            }

            const tokenToUse = clientJwt || errorCred.clientJwt;

            // 验证新的 token
            const sessionResult = await OrchidsAPI.getSessionFromClerk(tokenToUse);
            if (!sessionResult.success) {
                return res.status(400).json({ success: false, error: `Token 验证失败: ${sessionResult.error}` });
            }

            const newId = await orchidsStore.restoreFromError(id, tokenToUse, sessionResult.expiresAt);

            res.json({
                success: true,
                data: { newId, expiresAt: sessionResult.expiresAt },
                message: 'Token 验证成功，凭证已恢复'
            });
        } catch (error) {
            res.status(500).json({ success: false, error: `Token 验证失败: ${error.message}` });
        }
    });

    // ============ 导出/导入功能（整合自 orchids-api-main）============

    // 导出所有账号数据 (JSON)
    app.get('/api/orchids/export', async (req, res) => {
        try {
            const credentials = await orchidsStore.getAll();
            
            // 格式化为导出格式
            const exportData = credentials.map(cred => ({
                name: cred.name,
                email: cred.email,
                client_cookie: cred.clientJwt,
                user_id: cred.userId,
                session_id: cred.clerkSessionId,
                weight: cred.weight || 1,
                enabled: cred.isActive !== false
            }));

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename=orchids_accounts_${Date.now()}.json`);
            res.json(exportData);
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 导入账号数据 (JSON)
    app.post('/api/orchids/import', async (req, res) => {
        try {
            const accounts = req.body;
            
            if (!Array.isArray(accounts)) {
                return res.status(400).json({ success: false, error: '请提供账号数组' });
            }

            let imported = 0;
            let skipped = 0;

            for (const account of accounts) {
                try {
                    const token = account.client_cookie || account.clientJwt || account.client_jwt;
                    if (!token) {
                        skipped++;
                        continue;
                    }

                    // 检查是否已存在
                    const name = account.name || account.email || `orchids-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                    const existing = await orchidsStore.getByName(name);
                    if (existing) {
                        skipped++;
                        continue;
                    }

                    // 验证并获取完整信息
                    const accountInfo = await OrchidsAPI.getFullAccountInfo(token);
                    if (!accountInfo.success) {
                        skipped++;
                        continue;
                    }

                    await orchidsStore.add({
                        name,
                        email: accountInfo.email || account.email,
                        clientJwt: token,
                        clerkSessionId: accountInfo.sessionId,
                        userId: accountInfo.userId,
                        expiresAt: accountInfo.expiresAt
                    });

                    imported++;
                } catch {
                    skipped++;
                }
            }

            res.json({ success: true, imported, skipped });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 一键刷新所有账号
    app.post('/api/orchids/refresh-all', async (req, res) => {
        try {
            const credentials = await orchidsStore.getAll();
            
            res.json({ success: true, message: '刷新任务已启动' });

            // 异步执行刷新
            (async () => {
                for (const cred of credentials) {
                    try {
                        const accountInfo = await OrchidsAPI.getFullAccountInfo(cred.clientJwt);
                        if (accountInfo.success) {
                            await orchidsStore.update(cred.id, {
                                email: accountInfo.email,
                                clerkSessionId: accountInfo.sessionId,
                                userId: accountInfo.userId,
                                expiresAt: accountInfo.expiresAt
                            });
                            await orchidsStore.resetErrorCount(cred.id);
                        } else {
                            await orchidsStore.incrementErrorCount(cred.id, accountInfo.error);
                        }
                    } catch (err) {
                        await orchidsStore.incrementErrorCount(cred.id, err.message);
                    }
                }
            })();
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 批量删除账号
    app.post('/api/orchids/batch-delete', async (req, res) => {
        try {
            const { ids } = req.body;

            if (!Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, error: '请提供要删除的账号 ID 数组' });
            }

            let deleted = 0;
            let failed = 0;

            for (const id of ids) {
                try {
                    await orchidsStore.delete(id);
                    deleted++;
                } catch {
                    failed++;
                }
            }

            res.json({ success: true, deleted, failed });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试单个账号激活状态
    app.post('/api/orchids/credentials/:id/activate-test', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await orchidsStore.getById(id);
            
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            const healthResult = await OrchidsAPI.testAccountHealth(credential.clientJwt);

            if (healthResult.isHealthy) {
                // 更新凭证信息
                if (healthResult.data) {
                    await orchidsStore.update(id, {
                        email: healthResult.data.email,
                        clerkSessionId: healthResult.data.sessionId,
                        userId: healthResult.data.userId,
                        expiresAt: healthResult.data.expiresAt
                    });
                }
                await orchidsStore.resetErrorCount(id);
            }

            res.json({
                success: healthResult.success,
                duration_ms: healthResult.durationMs,
                response: healthResult.response,
                message: healthResult.error
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ============ Orchids 聊天 API ============

    // 获取 Orchids 支持的模型列表
    app.get('/api/orchids/models', async (req, res) => {
        try {
            res.json({
                success: true,
                data: ORCHIDS_MODELS.map(id => ({ id, name: id }))
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Orchids 聊天端点 - 流式 SSE (使用指定凭证)
    app.post('/api/orchids/chat/:id', async (req, res) => {
        const id = parseInt(req.params.id);

        try {
            const credential = await orchidsStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            const { messages, model, system, max_tokens, stream = true } = req.body;

            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({ success: false, error: '缺少 messages 参数' });
            }

            const service = new OrchidsChatService(credential);
            const requestBody = { messages, system, max_tokens };

            if (stream) {
                // 流式响应
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');

                try {
                    for await (const event of service.generateContentStream(model, requestBody)) {
                        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                    }
                    res.end();
                } catch (streamError) {
                    const errorEvent = {
                        type: 'error',
                        error: { type: 'api_error', message: streamError.message }
                    };
                    res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                    res.end();
                }
            } else {
                // 非流式响应
                const response = await service.generateContent(model, requestBody);
                res.json(response);
            }
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Orchids 聊天端点 - 非流式 (使用指定凭证)
    app.post('/api/orchids/chat/:id/sync', async (req, res) => {
        const id = parseInt(req.params.id);

        try {
            const credential = await orchidsStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            const { messages, model, system, max_tokens } = req.body;

            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({ success: false, error: '缺少 messages 参数' });
            }

            const service = new OrchidsChatService(credential);
            const requestBody = { messages, system, max_tokens };
            const response = await service.generateContent(model, requestBody);

            res.json(response);
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Orchids 聊天端点 - 使用活跃凭证
    app.post('/api/orchids/chat', async (req, res) => {
        try {
            // 获取活跃凭证
            const credentials = await orchidsStore.getAll();
            const activeCredential = credentials.find(c => c.isActive) || credentials[0];

            if (!activeCredential) {
                return res.status(400).json({ success: false, error: '没有可用的 Orchids 凭证' });
            }

            const { messages, model, system, max_tokens, stream = true } = req.body;

            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({ success: false, error: '缺少 messages 参数' });
            }

            const service = new OrchidsChatService(activeCredential);
            const requestBody = { messages, system, max_tokens };

            if (stream) {
                // 流式响应
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');

                try {
                    for await (const event of service.generateContentStream(model, requestBody)) {
                        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                    }
                    res.end();
                } catch (streamError) {
                    const errorEvent = {
                        type: 'error',
                        error: { type: 'api_error', message: streamError.message }
                    };
                    res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                    res.end();
                }
            } else {
                // 非流式响应
                const response = await service.generateContent(model, requestBody);
                res.json(response);
            }
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
}
