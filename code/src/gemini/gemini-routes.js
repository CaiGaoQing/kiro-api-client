/**
 * Gemini Antigravity 凭证管理路由
 */
import {
    AntigravityApiService,
    GEMINI_MODELS,
    refreshGeminiToken,
    startOAuthFlow as startGeminiOAuthFlow
} from './antigravity-core.js';

export function setupGeminiRoutes(app, geminiStore, getTimestamp) {
    // Gemini OAuth 开始授权（使用独立回调服务器，端口 8086）
    app.post('/api/gemini/oauth/start', async (req, res) => {
        try {
            const { name } = req.body;
            const credentialName = name || `Gemini-${Date.now()}`;

            // 启动独立的 OAuth 回调服务器（端口 8086）
            const { authUrl, port } = await startGeminiOAuthFlow({
                port: 8086,
                onSuccess: async (tokens) => {
                    try {
                        // 保存到数据库
                        const id = await geminiStore.add({
                            name: credentialName,
                            accessToken: tokens.accessToken,
                            refreshToken: tokens.refreshToken,
                            expiresAt: tokens.expiresAt
                        });
                        // console.log(`[${getTimestamp()}] [Gemini OAuth] 新凭证已添加: ${credentialName} (ID: ${id})`);
                    } catch (err) {
                        console.error(`[${getTimestamp()}] [Gemini OAuth] 保存凭证失败:`, err.message);
                    }
                },
                onError: (error) => {
                    console.error(`[${getTimestamp()}] [Gemini OAuth] 授权失败:`, error.message);
                }
            });

            // console.log(`[${getTimestamp()}] [Gemini OAuth] 回调服务器已启动于端口 ${port}`);
            res.json({ success: true, authUrl });
        } catch (error) {
            console.error(`[${getTimestamp()}] [Gemini OAuth] 启动失败:`, error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取所有 Gemini 凭证
    app.get('/api/gemini/credentials', async (req, res) => {
        try {
            const credentials = await geminiStore.getAll();
            res.json({
                success: true,
                data: credentials.map(c => ({
                    ...c,
                    accessToken: c.accessToken ? '***' : null,
                    refreshToken: c.refreshToken ? '***' : null
                }))
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取单个 Gemini 凭证
    app.get('/api/gemini/credentials/:id', async (req, res) => {
        try {
            const credential = await geminiStore.getById(parseInt(req.params.id));
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }
            res.json({
                success: true,
                data: {
                    ...credential,
                    accessToken: credential.accessToken ? '***' : null,
                    refreshToken: credential.refreshToken ? '***' : null
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 添加 Gemini 凭证
    app.post('/api/gemini/credentials', async (req, res) => {
        try {
            const { name, email, accessToken, refreshToken, projectId, expiresAt } = req.body;

            if (!name || !accessToken) {
                return res.status(400).json({ success: false, error: '名称和 accessToken 是必需的' });
            }

            const existing = await geminiStore.getByName(name);
            if (existing) {
                return res.status(400).json({ success: false, error: '凭证名称已存在' });
            }

            const id = await geminiStore.add({
                name,
                email,
                accessToken,
                refreshToken,
                projectId,
                expiresAt
            });

            res.json({ success: true, data: { id } });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 批量导入 Gemini 凭证
    app.post('/api/gemini/credentials/batch-import', async (req, res) => {
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
                    const { email, refresh_token, refreshToken } = account;
                    const token = refresh_token || refreshToken;

                    if (!token) {
                        results.failed++;
                        results.errors.push({ email, error: '缺少 refresh_token' });
                        continue;
                    }

                    // 检查是否已存在
                    const name = email || `gemini-${Date.now()}`;
                    const existing = await geminiStore.getByName(name);
                    if (existing) {
                        results.failed++;
                        results.errors.push({ email, error: '凭证已存在' });
                        continue;
                    }

                    // 使用 refresh_token 获取 access_token
                    let accessToken = '';
                    let expiresAt = null;

                    try {
                        const tokenResult = await refreshGeminiToken(token);
                        accessToken = tokenResult.accessToken;
                        expiresAt = tokenResult.expiresAt;
                    } catch (tokenError) {
                        results.failed++;
                        results.errors.push({ email, error: `Token 刷新失败: ${tokenError.message}` });
                        continue;
                    }

                    // 添加凭证
                    await geminiStore.add({
                        name,
                        email,
                        accessToken,
                        refreshToken: token,
                        projectId: null,
                        expiresAt
                    });

                    results.success++;
                } catch (err) {
                    results.failed++;
                    results.errors.push({ email: account.email, error: err.message });
                }
            }

            res.json({
                success: true,
                data: results
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 更新 Gemini 凭证
    app.put('/api/gemini/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await geminiStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            await geminiStore.update(id, req.body);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除 Gemini 凭证
    app.delete('/api/gemini/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await geminiStore.delete(id);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 激活 Gemini 凭证
    app.post('/api/gemini/credentials/:id/activate', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await geminiStore.setActive(id);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 刷新 Gemini 凭证 Token
    app.post('/api/gemini/credentials/:id/refresh', async (req, res) => {
        const id = parseInt(req.params.id);
        try {
            const credential = await geminiStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            if (!credential.refreshToken) {
                return res.status(400).json({ success: false, error: '凭证没有 refreshToken' });
            }

            const result = await refreshGeminiToken(credential.refreshToken);
            await geminiStore.update(id, {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt
            });
            await geminiStore.resetErrorCount(id);

            res.json({ success: true, data: { expiresAt: result.expiresAt } });
        } catch (error) {
            await geminiStore.incrementErrorCount(id, error.message);
            res.status(500).json({ success: false, error: `Token 刷新失败: ${error.message}` });
        }
    });

    // 测试 Gemini 凭证
    app.post('/api/gemini/credentials/:id/test', async (req, res) => {
        const id = parseInt(req.params.id);
        try {
            const credential = await geminiStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            const service = AntigravityApiService.fromCredentials(credential);
            await service.initialize(); // 确保初始化（会自动 onboard）

            // 如果 projectId 发生变化，保存到数据库
            if (service.projectId && service.projectId !== credential.projectId) {
                await geminiStore.update(id, { projectId: service.projectId });
            }

            const models = await service.listModels();

            await geminiStore.resetErrorCount(id);
            res.json({ success: true, data: { models, projectId: service.projectId } });
        } catch (error) {
            await geminiStore.incrementErrorCount(id, error.message);
            res.status(500).json({ success: false, error: `测试失败: ${error.message}` });
        }
    });

    // 获取 Gemini 可用模型列表
    app.get('/api/gemini/models', async (req, res) => {
        try {
            res.json({ success: true, data: GEMINI_MODELS });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取 Gemini 凭证用量
    app.get('/api/gemini/credentials/:id/usage', async (req, res) => {
        const id = parseInt(req.params.id);
        try {
            const credential = await geminiStore.getById(id);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            const service = AntigravityApiService.fromCredentials({
                accessToken: credential.accessToken,
                refreshToken: credential.refreshToken,
                projectId: credential.projectId,
                expiresAt: credential.expiresAt
            });

            // getUsageLimits 内部会调用 initialize
            const usage = await service.getUsageLimits();

            // 如果 projectId 发生变化，保存到数据库
            if (service.projectId && service.projectId !== credential.projectId) {
                await geminiStore.update(id, { projectId: service.projectId });
            }

            res.json({ success: true, data: usage });
        } catch (error) {
            res.status(500).json({ success: false, error: `获取用量失败: ${error.message}` });
        }
    });

    // Gemini 流式对话
    app.post('/api/gemini/chat/:id', async (req, res) => {
        const credentialId = parseInt(req.params.id);

        try {
            const credential = await geminiStore.getById(credentialId);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            const { message, model, history } = req.body;
            if (!message) {
                return res.status(400).json({ success: false, error: '消息内容是必需的' });
            }

            const service = AntigravityApiService.fromCredentials({
                accessToken: credential.accessToken,
                refreshToken: credential.refreshToken,
                projectId: credential.projectId,
                expiresAt: credential.expiresAt
            });

            // 确保初始化（会自动 onboard 如果需要）
            await service.initialize();

            // 如果 projectId 发生变化，保存到数据库
            if (service.projectId && service.projectId !== credential.projectId) {
                await geminiStore.update(credentialId, { projectId: service.projectId });
            }

            // 构建 Gemini 格式的消息
            const contents = [];
            if (history && Array.isArray(history)) {
                for (const msg of history) {
                    contents.push({
                        role: msg.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: msg.content }]
                    });
                }
            }
            contents.push({ role: 'user', parts: [{ text: message }] });

            // 设置 SSE 响应头
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const selectedModel = model || 'gemini-3-flash-preview';

            // 流式输出
            for await (const chunk of service.generateContentStream(selectedModel, { contents })) {
                if (chunk && chunk.candidates && chunk.candidates[0]) {
                    const candidate = chunk.candidates[0];
                    if (candidate.content && candidate.content.parts) {
                        for (const part of candidate.content.parts) {
                            if (part.text) {
                              res.write(`data: ${JSON.stringify({ content: part.text })}\n\n`);
                            }
                        }
                    }
                }
            }

            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            res.end();
        } catch (error) {
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: `对话失败: ${error.message}` });
            } else {
                res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
                res.end();
            }
        }
    });

    // Gemini 非流式对话
    app.post('/api/gemini/chat/:id/sync', async (req, res) => {
        const credentialId = parseInt(req.params.id);

        try {
            const credential = await geminiStore.getById(credentialId);
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            const { message, model, history } = req.body;
            if (!message) {
                return res.status(400).json({ success: false, error: '消息内容是必需的' });
            }

            const service = AntigravityApiService.fromCredentials({
                accessToken: credential.accessToken,
                refreshToken: credential.refreshToken,
                projectId: credential.projectId,
                expiresAt: credential.expiresAt
            });

            // 确保初始化（会自动 onboard 如果需要）
            await service.initialize();

            // 如果 projectId 发生变化，保存到数据库
            if (service.projectId && service.projectId !== credential.projectId) {
                await geminiStore.update(credentialId, { projectId: service.projectId });
            }

            // 构建 Gemini 格式的消息
            const contents = [];
            if (history && Array.isArray(history)) {
                for (const msg of history) {
                    contents.push({
                        role: msg.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: msg.content }]
                    });
                }
            }
            contents.push({ role: 'user', parts: [{ text: message }] });

            const selectedModel = model || 'gemini-3-flash-preview';
            const response = await service.generateContent(selectedModel, { contents });

            // 提取响应文本
            let responseText = '';
            if (response && response.candidates && response.candidates[0]) {
                const candidate = response.candidates[0];
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.text) {
                            responseText += part.text;
                        }
                    }
                }
            }

            res.json({
                success: true,
                data: {
                    response: responseText,
                    usage: response?.usageMetadata || {}
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: `对话失败: ${error.message}` });
        }
    });

    // 获取 Gemini 错误凭证列表
    app.get('/api/gemini/error-credentials', async (req, res) => {
        try {
            const credentials = await geminiStore.getAllErrors();
            res.json({
                success: true,
                data: credentials.map(c => ({
                    ...c,
                    accessToken: c.accessToken ? '***' : null,
                    refreshToken: c.refreshToken ? '***' : null
                }))
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除 Gemini 错误凭证
    app.delete('/api/gemini/error-credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await geminiStore.deleteError(id);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 刷新 Gemini 错误凭证并恢复
    app.post('/api/gemini/error-credentials/:id/refresh', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const errorCred = await geminiStore.getErrorById(id);
            if (!errorCred) {
                return res.status(404).json({ success: false, error: '错误凭证不存在' });
            }

            if (!errorCred.refreshToken) {
                return res.status(400).json({ success: false, error: '凭证没有 refreshToken' });
            }

            const result = await refreshGeminiToken(errorCred.refreshToken);

            // 恢复到正常凭证表
            await geminiStore.restoreFromError(id, {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt
            });

            res.json({ success: true, data: { expiresAt: result.expiresAt } });
        } catch (error) {
            res.status(500).json({ success: false, error: `恢复失败: ${error.message}` });
        }
    });
}
