/**
 * Orchids API 路由
 */
import { OrchidsAPI } from './orchids-service.js';
import { OrchidsChatService, ORCHIDS_MODELS } from './orchids-chat-service.js';

export function setupOrchidsRoutes(app, orchidsStore) {
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

    // 添加 Orchids 凭证
    app.post('/api/orchids/credentials', async (req, res) => {
        try {
            const { name, email, clientJwt } = req.body;

            if (!name || !clientJwt) {
                return res.status(400).json({ success: false, error: '名称和 clientJwt 是必需的' });
            }

            const existing = await orchidsStore.getByName(name);
            if (existing) {
                return res.status(400).json({ success: false, error: '凭证名称已存在' });
            }

            // 验证 clientJwt 并获取 session 信息
            const sessionResult = await OrchidsAPI.getSessionFromClerk(clientJwt);
            if (!sessionResult.success) {
                return res.status(400).json({ success: false, error: `Token 验证失败: ${sessionResult.error}` });
            }

            const id = await orchidsStore.add({
                name,
                email,
                clientJwt,
                clerkSessionId: sessionResult.sessionId,
                userId: sessionResult.userId,
                expiresAt: sessionResult.expiresAt
            });

            res.json({ success: true, data: { id } });
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
            const { name, email, clientJwt } = req.body;
            await orchidsStore.update(id, { name, email, clientJwt });
            res.json({ success: true, message: '凭证更新成功' });
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
