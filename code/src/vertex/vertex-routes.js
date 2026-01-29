/**
 * Vertex AI 路由
 * 提供 Vertex AI 凭据管理和聊天 API
 * 支持 Claude 模型（通过 Vertex AI）和 Gemini 模型（通过 Vertex AI 或 Antigravity）
 */
import { VertexClient, VERTEX_MODEL_MAPPING, VERTEX_GEMINI_MODEL_MAPPING, VERTEX_REGIONS } from './vertex.js';
import { VertexCredentialStore, GeminiCredentialStore } from '../db.js';
import {
    AntigravityApiService,
    GEMINI_MODELS,
    claudeToGeminiMessages,
    geminiToClaudeResponse,
    refreshGeminiToken
} from '../gemini/antigravity-core.js';

let vertexStore = null;
let geminiStore = null;

/**
 * 检测是否为 Gemini 模型
 */
function isGeminiModel(model) {
    if (!model) return false;
    return model.startsWith('gemini') || GEMINI_MODELS.includes(model) || VERTEX_GEMINI_MODEL_MAPPING[model];
}

/**
 * 检查 Gemini Token 是否即将过期（提前 50 分钟刷新）
 */
function isGeminiTokenExpiringSoon(credential, minutes = 50) {
    if (!credential.expiresAt) return false;
    try {
        const expirationTime = new Date(credential.expiresAt).getTime();
        const currentTime = Date.now();
        const thresholdTime = currentTime + minutes * 60 * 1000;
        return expirationTime <= thresholdTime;
    } catch {
        return false;
    }
}

/**
 * 选择一个可用的 Gemini 凭据（LRU 策略）
 */
async function selectGeminiCredential() {
    const allCredentials = await geminiStore.getAllActive();
    if (allCredentials.length === 0) return null;

    // 过滤健康的凭据（错误次数小于阈值 且 projectId 不为空）
    const maxErrorCount = 5;
    let healthyCredentials = allCredentials.filter(c =>
        (c.errorCount || 0) < maxErrorCount && c.projectId
    );

    // 如果没有健康凭证，尝试只过滤 projectId 不为空的
    if (healthyCredentials.length === 0) {
        healthyCredentials = allCredentials.filter(c => c.projectId);
    }

    // 如果仍然没有，使用所有可用凭证（会触发 onboarding）
    if (healthyCredentials.length === 0) {
        healthyCredentials = allCredentials;
    }

    // LRU 策略：按最后使用时间排序，优先选择最久未使用的
    healthyCredentials.sort((a, b) => {
        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        if (timeA !== timeB) return timeA - timeB;
        return (a.errorCount || 0) - (b.errorCount || 0);
    });

    return healthyCredentials[0];
}

/**
 * 设置 Vertex AI 路由
 */
export async function setupVertexRoutes(app) {
    vertexStore = await VertexCredentialStore.create();
    geminiStore = await GeminiCredentialStore.create();

    // ============ 凭据管理 API ============

    // 获取所有 Vertex 凭据
    app.get('/api/vertex/credentials', async (req, res) => {
        try {
            const credentials = await vertexStore.getAll();
            // 隐藏私钥
            const safeCredentials = credentials.map(c => ({
                ...c,
                privateKey: c.privateKey ? '******' : null
            }));
            res.json(safeCredentials);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 获取单个 Vertex 凭据
    app.get('/api/vertex/credentials/:id', async (req, res) => {
        try {
            const credential = await vertexStore.getById(parseInt(req.params.id));
            if (!credential) {
                return res.status(404).json({ error: '凭据不存在' });
            }
            // 隐藏私钥
            res.json({
                ...credential,
                privateKey: credential.privateKey ? '******' : null
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 添加 Vertex 凭据
    app.post('/api/vertex/credentials', async (req, res) => {
        try {
            const { name, projectId, clientEmail, privateKey, region } = req.body;

            if (!name || !projectId || !clientEmail || !privateKey) {
                return res.status(400).json({ error: '缺少必要字段: name, projectId, clientEmail, privateKey' });
            }

            // 检查名称是否已存在
            const existing = await vertexStore.getByName(name);
            if (existing) {
                return res.status(400).json({ error: '凭据名称已存在' });
            }

            const id = await vertexStore.add({
                name,
                projectId,
                clientEmail,
                privateKey,
                region: region || 'global'
            });

            res.json({ success: true, id, message: '凭据添加成功' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 从 JSON 文件导入凭据
    app.post('/api/vertex/credentials/import', async (req, res) => {
        try {
            const { name, keyJson, region } = req.body;

            if (!name || !keyJson) {
                return res.status(400).json({ error: '缺少必要字段: name, keyJson' });
            }

            let keyData;
            try {
                keyData = typeof keyJson === 'string' ? JSON.parse(keyJson) : keyJson;
            } catch (e) {
                return res.status(400).json({ error: '无效的 JSON 格式' });
            }

            if (!keyData.project_id || !keyData.client_email || !keyData.private_key) {
                return res.status(400).json({ error: 'JSON 缺少必要字段: project_id, client_email, private_key' });
            }

            // 检查名称是否已存在
            const existing = await vertexStore.getByName(name);
            if (existing) {
                return res.status(400).json({ error: '凭据名称已存在' });
            }

            const id = await vertexStore.add({
                name,
                projectId: keyData.project_id,
                clientEmail: keyData.client_email,
                privateKey: keyData.private_key,
                region: region || 'global'
            });

            res.json({ success: true, id, message: '凭据导入成功' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 更新 Vertex 凭据
    app.put('/api/vertex/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await vertexStore.getById(id);
            if (!credential) {
                return res.status(404).json({ error: '凭据不存在' });
            }

            const updateData = {};
            if (req.body.name !== undefined) updateData.name = req.body.name;
            if (req.body.projectId !== undefined) updateData.projectId = req.body.projectId;
            if (req.body.clientEmail !== undefined) updateData.clientEmail = req.body.clientEmail;
            if (req.body.privateKey !== undefined && req.body.privateKey !== '******') {
                updateData.privateKey = req.body.privateKey;
            }
            if (req.body.region !== undefined) updateData.region = req.body.region;
            if (req.body.isActive !== undefined) updateData.isActive = req.body.isActive;

            await vertexStore.update(id, updateData);
            res.json({ success: true, message: '凭据更新成功' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 删除 Vertex 凭据
    app.delete('/api/vertex/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await vertexStore.delete(id);
            res.json({ success: true, message: '凭据删除成功' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 激活 Vertex 凭据
    app.post('/api/vertex/credentials/:id/activate', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            await vertexStore.setActive(id);
            res.json({ success: true, message: '凭据已激活' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 测试 Vertex 凭据
    app.post('/api/vertex/credentials/:id/test', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await vertexStore.getById(id);
            if (!credential) {
                return res.status(404).json({ error: '凭据不存在' });
            }

            const gcpCredentials = vertexStore.toGcpCredentials(credential);
            const client = VertexClient.fromCredentials(gcpCredentials, credential.region);

            // 尝试获取访问令牌来测试凭据
            await client.getAccessToken();

            await vertexStore.resetErrorCount(id);
            res.json({ success: true, message: '凭据测试成功' });
        } catch (error) {
            await vertexStore.incrementErrorCount(id, error.message);
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 获取 Vertex 统计信息
    app.get('/api/vertex/statistics', async (req, res) => {
        try {
            const stats = await vertexStore.getStatistics();
            res.json(stats);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 获取支持的模型列表
    app.get('/api/vertex/models', (req, res) => {
        res.json({
            models: Object.keys(VERTEX_MODEL_MAPPING),
            mapping: VERTEX_MODEL_MAPPING
        });
    });

    // 获取支持的区域列表
    app.get('/api/vertex/regions', (req, res) => {
        res.json({ regions: VERTEX_REGIONS });
    });

    // ============ 聊天 API ============

    // 非流式聊天
    app.post('/api/vertex/chat/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await vertexStore.getById(id);
            if (!credential) {
                return res.status(404).json({ error: '凭据不存在' });
            }

            const { messages, model, system, max_tokens, temperature, top_p, top_k } = req.body;

            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({ error: '缺少 messages 参数' });
            }

            const gcpCredentials = vertexStore.toGcpCredentials(credential);
            const client = VertexClient.fromCredentials(gcpCredentials, credential.region);

            const response = await client.chat(messages, model || 'claude-sonnet-4-5', {
                system,
                max_tokens,
                temperature,
                top_p,
                top_k
            });

            await vertexStore.incrementUseCount(id);
            await vertexStore.resetErrorCount(id);

            res.json(response);
        } catch (error) {
            const id = parseInt(req.params.id);
            await vertexStore.incrementErrorCount(id, error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // 流式聊天
    app.post('/api/vertex/chat/:id/stream', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await vertexStore.getById(id);
            if (!credential) {
                return res.status(404).json({ error: '凭据不存在' });
            }

            const { messages, model, system, max_tokens, temperature, top_p, top_k } = req.body;

            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({ error: '缺少 messages 参数' });
            }

            const gcpCredentials = vertexStore.toGcpCredentials(credential);
            const client = VertexClient.fromCredentials(gcpCredentials, credential.region);

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            for await (const event of client.chatStream(messages, model || 'claude-sonnet-4-5', {
                system,
                max_tokens,
                temperature,
                top_p,
                top_k
            })) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }

            res.write('data: [DONE]\n\n');
            res.end();

            await vertexStore.incrementUseCount(id);
            await vertexStore.resetErrorCount(id);
        } catch (error) {
            const id = parseInt(req.params.id);
            await vertexStore.incrementErrorCount(id, error.message);

            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            } else {
                res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
                res.end();
            }
        }
    });

    // ============ Claude API 兼容端点 ============

    // /vertex/v1/messages - Claude API 格式（支持 Claude 和 Gemini 模型）
    app.post('/vertex/v1/messages', async (req, res) => {
        const { messages, model, system, max_tokens, temperature, top_p, top_k, stream } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: '缺少 messages 参数' });
        }

        // 检测是否为 Gemini 模型
        if (isGeminiModel(model)) {
            // ============ Gemini 模型处理 ============
            // 优先使用 Vertex AI（GCP JSON 凭据），如果没有则回退到 Antigravity
            const vertexCredential = await vertexStore.getRandomActive();

            if (vertexCredential) {
                // ============ 通过 Vertex AI 调用 Gemini ============
                console.log(`[Vertex/Gemini] 收到请求 | model=${model} | stream=${stream}`);
                console.log(`[Vertex/Gemini] 使用 Vertex AI 凭据: ${vertexCredential.name}`);

                try {
                    const gcpCredentials = vertexStore.toGcpCredentials(vertexCredential);
                    const client = VertexClient.fromCredentials(gcpCredentials, vertexCredential.region);

                    const requestModel = model || 'gemini-1.5-flash';

                    if (stream) {
                        // 流式响应
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.setHeader('Connection', 'keep-alive');

                        const messageId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 8);
                        const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);

                        // 发送 message_start 事件
                        res.write(`event: message_start\ndata: ${JSON.stringify({
                            type: 'message_start',
                            message: {
                                id: messageId,
                                type: 'message',
                                role: 'assistant',
                                content: [],
                                model: requestModel,
                                stop_reason: null,
                                stop_sequence: null,
                                usage: { input_tokens: inputTokens, output_tokens: 0 }
                            }
                        })}\n\n`);

                        // 发送 content_block_start 事件
                        res.write(`event: content_block_start\ndata: ${JSON.stringify({
                            type: 'content_block_start',
                            index: 0,
                            content_block: { type: 'text', text: '' }
                        })}\n\n`);

                        let outputTokens = 0;

                        for await (const event of client.geminiChatStream(messages, requestModel, {
                            system,
                            max_tokens: max_tokens || 8192,
                            temperature,
                            top_p,
                            top_k
                        })) {
                            if (event.type === 'content_block_delta' && event.delta?.text) {
                                outputTokens += Math.ceil(event.delta.text.length / 4);
                                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                                    type: 'content_block_delta',
                                    index: 0,
                                    delta: { type: 'text_delta', text: event.delta.text }
                                })}\n\n`);
                            }
                            if (event.type === 'usage' && event.usage) {
                                outputTokens = event.usage.output_tokens || outputTokens;
                            }
                        }

                        // 发送结束事件
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                        res.write(`event: message_delta\ndata: ${JSON.stringify({
                            type: 'message_delta',
                            delta: { stop_reason: 'end_turn', stop_sequence: null },
                            usage: { output_tokens: outputTokens }
                        })}\n\n`);
                        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                        res.end();

                        console.log('[Vertex/Gemini] 流式请求完成');
                    } else {
                        // 非流式响应
                        const response = await client.geminiChat(messages, requestModel, {
                            system,
                            max_tokens: max_tokens || 8192,
                            temperature,
                            top_p,
                            top_k
                        });

                        console.log('[Vertex/Gemini] 请求成功');
                        res.json(response);
                    }

                    await vertexStore.incrementUseCount(vertexCredential.id);
                    await vertexStore.resetErrorCount(vertexCredential.id);
                } catch (error) {
                    console.error(`[Vertex/Gemini] 错误: ${error.message}`);
                    if (!res.headersSent) {
                        res.status(500).json({ error: error.message });
                    } else {
                        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: error.message } })}\n\n`);
                        res.end();
                    }
                }
            } else {
                // ============ 回退到 Antigravity（OAuth 凭据）============
                console.log('[Vertex/Gemini] 没有 Vertex AI 凭据，回退到 Antigravity');
                try {
                    let credential = await selectGeminiCredential();
                    if (!credential) {
                        return res.status(503).json({ error: '没有可用的 Gemini 凭据' });
                    }

                    // 检查并刷新 Token（如果即将过期）
                    if (credential.refreshToken && isGeminiTokenExpiringSoon(credential)) {
                        try {
                            const result = await refreshGeminiToken(credential.refreshToken);
                            await geminiStore.update(credential.id, {
                                accessToken: result.accessToken,
                                refreshToken: result.refreshToken,
                                expiresAt: result.expiresAt
                            });
                            credential = await geminiStore.getById(credential.id);
                        } catch (refreshError) {
                            console.error(`[Vertex/Gemini] Token 刷新失败: ${refreshError.message}`);
                        }
                    }

                    // 创建 Antigravity 服务
                    const service = AntigravityApiService.fromCredentials(credential);

                    // 转换消息格式
                    const contents = claudeToGeminiMessages(messages);
                    const requestBody = { contents };

                    // 添加系统提示
                    if (system) {
                        const systemText = typeof system === 'string'
                            ? system
                            : (Array.isArray(system) ? system.map(s => s.text || s).join('\n') : String(system));
                        requestBody.systemInstruction = { parts: [{ text: systemText }] };
                    }

                    // 添加生成配置
                    if (max_tokens) {
                        requestBody.generationConfig = { maxOutputTokens: max_tokens };
                    }

                    const requestModel = model || 'gemini-3-flash-preview';

                    if (stream) {
                        // 流式响应
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.setHeader('Connection', 'keep-alive');

                        const messageId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 8);
                        const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);

                        // 发送 message_start 事件
                        res.write(`event: message_start\ndata: ${JSON.stringify({
                            type: 'message_start',
                            message: {
                                id: messageId,
                                type: 'message',
                                role: 'assistant',
                                content: [],
                                model: requestModel,
                                stop_reason: null,
                                stop_sequence: null,
                                usage: { input_tokens: inputTokens, output_tokens: 0 }
                            }
                        })}\n\n`);

                        // 发送 content_block_start 事件
                        res.write(`event: content_block_start\ndata: ${JSON.stringify({
                            type: 'content_block_start',
                            index: 0,
                            content_block: { type: 'text', text: '' }
                        })}\n\n`);

                        let outputTokens = 0;

                        for await (const chunk of service.generateContentStream(requestModel, requestBody)) {
                            if (chunk && chunk.candidates && chunk.candidates[0]?.content?.parts) {
                                for (const part of chunk.candidates[0].content.parts) {
                                    if (part.text) {
                                        outputTokens += Math.ceil(part.text.length / 4);
                                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                                            type: 'content_block_delta',
                                            index: 0,
                                            delta: { type: 'text_delta', text: part.text }
                                        })}\n\n`);
                                    }
                                }
                            }
                            if (chunk?.usageMetadata?.candidatesTokenCount) {
                                outputTokens = chunk.usageMetadata.candidatesTokenCount;
                            }
                        }

                        // 发送结束事件
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                        res.write(`event: message_delta\ndata: ${JSON.stringify({
                            type: 'message_delta',
                            delta: { stop_reason: 'end_turn', stop_sequence: null },
                            usage: { output_tokens: outputTokens }
                        })}\n\n`);
                        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                        res.end();

                        await geminiStore.resetErrorCount(credential.id);
                    } else {
                        // 非流式响应
                        const response = await service.generateContent(requestModel, requestBody);
                        const claudeResponse = geminiToClaudeResponse(response, requestModel);

                        await geminiStore.resetErrorCount(credential.id);
                        res.json(claudeResponse);
                    }
                } catch (error) {
                    console.error(`[Vertex/Gemini/Antigravity] 错误: ${error.message}`);
                    if (!res.headersSent) {
                        res.status(500).json({ error: error.message });
                    } else {
                        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: error.message } })}\n\n`);
                        res.end();
                    }
                }
            }
        } else {
            // ============ Claude 模型处理（通过 Vertex AI）============
            console.log(`[Vertex/Claude] 收到请求 | model=${model} | stream=${stream}`);
            try {
                console.log('[Vertex/Claude] 获取凭据...');
                const credential = await vertexStore.getRandomActive();
                if (!credential) {
                    console.log('[Vertex/Claude] 错误: 没有可用的凭据');
                    return res.status(503).json({ error: '没有可用的 Vertex AI 凭据' });
                }
                console.log(`[Vertex/Claude] 使用凭据: ${credential.name} (ID: ${credential.id})`);

                const gcpCredentials = vertexStore.toGcpCredentials(credential);
                console.log(`[Vertex/Claude] 创建客户端 | region=${credential.region}`);
                const client = VertexClient.fromCredentials(gcpCredentials, credential.region);

                if (stream) {
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');

                    console.log('[Vertex/Claude] 开始流式请求...');
                    for await (const event of client.chatStream(messages, model || 'claude-sonnet-4-5', {
                        system,
                        max_tokens: max_tokens || 8192,
                        temperature,
                        top_p,
                        top_k
                    })) {
                        res.write(`data: ${JSON.stringify(event)}\n\n`);
                    }

                    res.write('data: [DONE]\n\n');
                    res.end();
                    console.log('[Vertex/Claude] 流式请求完成');
                } else {
                    console.log('[Vertex/Claude] 开始非流式请求...');
                    console.log('[Vertex/Claude] 获取 access token...');
                    const response = await client.chat(messages, model || 'claude-sonnet-4-5', {
                        system,
                        max_tokens: max_tokens || 8192,
                        temperature,
                        top_p,
                        top_k
                    });

                    console.log('[Vertex/Claude] 请求成功，返回响应');
                    res.json(response);
                }

                await vertexStore.incrementUseCount(credential.id);
                await vertexStore.resetErrorCount(credential.id);
            } catch (error) {
                console.error(`[Vertex/Claude] 错误: ${error.message}`);
                console.error(`[Vertex/Claude] 错误堆栈: ${error.stack}`);
                if (!res.headersSent) {
                    res.status(500).json({ error: error.message });
                } else {
                    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
                    res.end();
                }
            }
        }
    });

    // /vertex/v1/models - 模型列表（包含 Claude 和 Gemini）
    app.get('/vertex/v1/models', (req, res) => {
        // Claude 模型（通过 Vertex AI）
        const claudeModels = Object.keys(VERTEX_MODEL_MAPPING).map(id => ({
            id,
            object: 'model',
            created: Date.now(),
            owned_by: 'anthropic'
        }));

        // Gemini 模型（通过 Antigravity）
        const geminiModels = GEMINI_MODELS.map(id => ({
            id,
            object: 'model',
            created: Date.now(),
            owned_by: 'google'
        }));

        res.json({ object: 'list', data: [...claudeModels, ...geminiModels] });
    });

    console.log('[Vertex] 路由已设置');
    return vertexStore;
}

export { vertexStore };
