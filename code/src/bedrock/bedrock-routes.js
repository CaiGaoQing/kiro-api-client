/**
 * Amazon Bedrock API 路由
 */
import express from 'express';
import { BedrockCredentialStore } from '../db.js';
import { BedrockClient, BedrockAPI } from './bedrock.js';
import { BEDROCK_CONSTANTS, BEDROCK_MODELS, BEDROCK_MODEL_MAPPING } from '../constants.js';
import { logger } from '../logger.js';

const log = logger.api;
const router = express.Router();

// ==================== 凭据管理 API ====================

/**
 * 获取所有 Bedrock 凭据
 */
router.get('/credentials', async (req, res) => {
    try {
        const store = await BedrockCredentialStore.create();
        const credentials = await store.getAll();
        
        // 隐藏敏感信息
        const safeCredentials = credentials.map(cred => ({
            ...cred,
            accessKeyId: cred.accessKeyId ? cred.accessKeyId.substring(0, 8) + '****' : null,
            secretAccessKey: '********',
            sessionToken: cred.sessionToken ? '****' : null
        }));
        
        res.json({ success: true, data: safeCredentials });
    } catch (error) {
        log.error(`获取 Bedrock 凭据列表失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取单个 Bedrock 凭据
 */
router.get('/credentials/:id', async (req, res) => {
    try {
        const store = await BedrockCredentialStore.create();
        const credential = await store.getById(parseInt(req.params.id));
        
        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }
        
        // 隐藏敏感信息
        const safeCredential = {
            ...credential,
            accessKeyId: credential.accessKeyId ? credential.accessKeyId.substring(0, 8) + '****' : null,
            secretAccessKey: '********',
            sessionToken: credential.sessionToken ? '****' : null
        };
        
        res.json({ success: true, data: safeCredential });
    } catch (error) {
        log.error(`获取 Bedrock 凭据失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 添加 Bedrock 凭据
 */
router.post('/credentials', async (req, res) => {
    try {
        const { name, accessKeyId, secretAccessKey, sessionToken, region } = req.body;
        
        if (!name || !accessKeyId || !secretAccessKey) {
            return res.status(400).json({ success: false, error: '缺少必要参数: name, accessKeyId, secretAccessKey' });
        }
        
        const store = await BedrockCredentialStore.create();
        
        // 检查名称是否已存在
        const existing = await store.getByName(name);
        if (existing) {
            return res.status(400).json({ success: false, error: `名称 "${name}" 已存在` });
        }
        
        const id = await store.add({
            name,
            accessKeyId,
            secretAccessKey,
            sessionToken,
            region: region || BEDROCK_CONSTANTS.DEFAULT_REGION
        });
        
        log.info(`添加 Bedrock 凭据成功: ${name} (ID: ${id})`);
        res.json({ success: true, data: { id, name } });
    } catch (error) {
        log.error(`添加 Bedrock 凭据失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 更新 Bedrock 凭据
 */
router.put('/credentials/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const store = await BedrockCredentialStore.create();
        
        const existing = await store.getById(id);
        if (!existing) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }
        
        const updates = {};
        if (req.body.name !== undefined) updates.name = req.body.name;
        if (req.body.accessKeyId !== undefined) updates.accessKeyId = req.body.accessKeyId;
        if (req.body.secretAccessKey !== undefined) updates.secretAccessKey = req.body.secretAccessKey;
        if (req.body.sessionToken !== undefined) updates.sessionToken = req.body.sessionToken;
        if (req.body.region !== undefined) updates.region = req.body.region;
        if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
        
        await store.update(id, updates);
        
        log.info(`更新 Bedrock 凭据成功: ID ${id}`);
        res.json({ success: true });
    } catch (error) {
        log.error(`更新 Bedrock 凭据失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 删除 Bedrock 凭据
 */
router.delete('/credentials/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const store = await BedrockCredentialStore.create();
        
        const existing = await store.getById(id);
        if (!existing) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }
        
        await store.delete(id);
        
        log.info(`删除 Bedrock 凭据成功: ${existing.name} (ID: ${id})`);
        res.json({ success: true });
    } catch (error) {
        log.error(`删除 Bedrock 凭据失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 激活 Bedrock 凭据
 */
router.post('/credentials/:id/activate', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const store = await BedrockCredentialStore.create();
        
        const existing = await store.getById(id);
        if (!existing) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }
        
        await store.update(id, { isActive: true });
        
        log.info(`激活 Bedrock 凭据成功: ${existing.name} (ID: ${id})`);
        res.json({ success: true });
    } catch (error) {
        log.error(`激活 Bedrock 凭据失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 停用 Bedrock 凭据
 */
router.post('/credentials/:id/deactivate', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const store = await BedrockCredentialStore.create();
        
        const existing = await store.getById(id);
        if (!existing) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }
        
        await store.update(id, { isActive: false });
        
        log.info(`停用 Bedrock 凭据成功: ${existing.name} (ID: ${id})`);
        res.json({ success: true });
    } catch (error) {
        log.error(`停用 Bedrock 凭据失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 测试 Bedrock 凭据
 */
router.post('/credentials/:id/test', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const store = await BedrockCredentialStore.create();
        
        const credential = await store.getById(id);
        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }
        
        // 使用简单消息测试
        const client = BedrockClient.fromCredentials(credential);
        const response = await client.chat(
            [{ role: 'user', content: 'Hi, respond with just "OK".' }],
            'claude-3-haiku-20240307',
            { max_tokens: 10 }
        );
        
        // 重置错误计数
        await store.resetErrorCount(id);
        
        log.info(`测试 Bedrock 凭据成功: ${credential.name} (ID: ${id})`);
        res.json({
            success: true,
            data: {
                response: response.content?.[0]?.text || 'OK',
                usage: response.usage
            }
        });
    } catch (error) {
        const id = parseInt(req.params.id);
        const store = await BedrockCredentialStore.create();
        await store.incrementErrorCount(id, error.message);
        
        log.error(`测试 Bedrock 凭据失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取 Bedrock 凭据统计
 */
router.get('/statistics', async (req, res) => {
    try {
        const store = await BedrockCredentialStore.create();
        const stats = await store.getStatistics();
        res.json({ success: true, data: stats });
    } catch (error) {
        log.error(`获取 Bedrock 统计失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 模型和区域信息 ====================

/**
 * 获取支持的模型列表
 */
router.get('/models', (req, res) => {
    res.json({
        success: true,
        data: BEDROCK_MODELS,
        mapping: BEDROCK_MODEL_MAPPING
    });
});

/**
 * 获取支持的区域列表
 */
router.get('/regions', (req, res) => {
    res.json({
        success: true,
        data: BEDROCK_CONSTANTS.SUPPORTED_REGIONS
    });
});

// ==================== 聊天 API ====================

/**
 * 聊天接口（非流式）- 使用指定凭据
 */
router.post('/chat/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { messages, model, system, max_tokens, temperature, tools } = req.body;
        
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, error: '缺少 messages 参数' });
        }
        
        const store = await BedrockCredentialStore.create();
        const credential = await store.getById(id);
        
        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }
        
        if (!credential.isActive) {
            return res.status(400).json({ success: false, error: '凭据已停用' });
        }
        
        const client = BedrockClient.fromCredentials(credential);
        const response = await client.chat(messages, model || BEDROCK_CONSTANTS.DEFAULT_MODEL, {
            system,
            max_tokens,
            temperature,
            tools
        });
        
        // 更新使用计数
        await store.incrementUseCount(id);
        
        res.json(response);
    } catch (error) {
        log.error(`Bedrock 聊天失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 聊天接口（流式）- 使用指定凭据
 */
router.post('/chat/:id/stream', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { messages, model, system, max_tokens, temperature, tools } = req.body;
        
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, error: '缺少 messages 参数' });
        }
        
        const store = await BedrockCredentialStore.create();
        const credential = await store.getById(id);
        
        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }
        
        if (!credential.isActive) {
            return res.status(400).json({ success: false, error: '凭据已停用' });
        }
        
        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        
        const client = BedrockClient.fromCredentials(credential);
        
        for await (const event of client.chatStream(messages, model || BEDROCK_CONSTANTS.DEFAULT_MODEL, {
            system,
            max_tokens,
            temperature,
            tools
        })) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        
        // 更新使用计数
        await store.incrementUseCount(id);
        
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        log.error(`Bedrock 流式聊天失败: ${error.message}`);
        
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        } else {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    }
});

/**
 * 使用随机活跃凭据聊天（非流式）
 */
router.post('/chat', async (req, res) => {
    try {
        const { messages, model, system, max_tokens, temperature, tools } = req.body;
        
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, error: '缺少 messages 参数' });
        }
        
        const store = await BedrockCredentialStore.create();
        const credential = await store.getRandomActive();
        
        if (!credential) {
            return res.status(400).json({ success: false, error: '没有可用的 Bedrock 凭据' });
        }
        
        const client = BedrockClient.fromCredentials(credential);
        const response = await client.chat(messages, model || BEDROCK_CONSTANTS.DEFAULT_MODEL, {
            system,
            max_tokens,
            temperature,
            tools
        });
        
        // 更新使用计数
        await store.incrementUseCount(credential.id);
        
        res.json(response);
    } catch (error) {
        log.error(`Bedrock 聊天失败: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 使用随机活跃凭据聊天（流式）
 */
router.post('/chat/stream', async (req, res) => {
    try {
        const { messages, model, system, max_tokens, temperature, tools } = req.body;
        
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, error: '缺少 messages 参数' });
        }
        
        const store = await BedrockCredentialStore.create();
        const credential = await store.getRandomActive();
        
        if (!credential) {
            return res.status(400).json({ success: false, error: '没有可用的 Bedrock 凭据' });
        }
        
        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        
        const client = BedrockClient.fromCredentials(credential);
        
        for await (const event of client.chatStream(messages, model || BEDROCK_CONSTANTS.DEFAULT_MODEL, {
            system,
            max_tokens,
            temperature,
            tools
        })) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        
        // 更新使用计数
        await store.incrementUseCount(credential.id);
        
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        log.error(`Bedrock 流式聊天失败: ${error.message}`);
        
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        } else {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    }
});

export default router;
