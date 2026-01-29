/**
 * GCP Vertex AI 客户端
 * 通过 GCP Vertex AI 访问 Claude 模型
 */
import axios from 'axios';
import fs from 'fs/promises';
import { logger } from '../logger.js';
import { getAxiosProxyConfig } from '../proxy.js';

const log = logger.api;

/**
 * Vertex AI 模型映射表
 */
export const VERTEX_MODEL_MAPPING = {
    // Claude 3 系列
    'claude-3-sonnet-20240229': 'claude-3-sonnet@20240229',
    'claude-3-haiku-20240307': 'claude-3-haiku@20240307',
    'claude-3-opus-20240229': 'claude-3-opus@20240229',
    // Claude 3.5 系列
    'claude-3-5-sonnet-20240620': 'claude-3-5-sonnet@20240620',
    'claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-v2@20241022',
    'claude-3-5-haiku-20241022': 'claude-3-5-haiku@20241022',
    // Claude 3.7 系列
    'claude-3-7-sonnet-20250219': 'claude-3-7-sonnet@20250219',
    // Claude 4 系列
    'claude-4-sonnet-20250514': 'claude-sonnet-4@20250514',
    'claude-sonnet-4-20250514': 'claude-sonnet-4@20250514',
    // Claude 4.5 系列
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5@20250929',
    'claude-haiku-4-5-20251001': 'claude-haiku-4-5@20251001',
    'claude-opus-4-5-20251101': 'claude-opus-4-5@20251101',
    // 简写别名
    'claude-sonnet-4-5': 'claude-sonnet-4-5@20250929',
    'claude-haiku-4-5': 'claude-haiku-4-5@20251001',
    'claude-opus-4-5': 'claude-opus-4-5@20251101'
};

/**
 * Gemini 模型映射表（Vertex AI）
 * 参考: https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions
 */
export const VERTEX_GEMINI_MODEL_MAPPING = {
    // Gemini 3 系列 (最新)
    'gemini-3-pro': 'gemini-3-pro-preview',
    'gemini-3-pro-preview': 'gemini-3-pro-preview',
    'gemini-3-flash': 'gemini-3-flash-preview',
    'gemini-3-flash-preview': 'gemini-3-flash-preview',
    // Gemini 1.5 系列
    'gemini-1.5-pro': 'gemini-1.5-pro',
    'gemini-1.5-flash': 'gemini-1.5-flash',
    'gemini-1.5-pro-latest': 'gemini-1.5-pro',
    'gemini-1.5-flash-latest': 'gemini-1.5-flash',
    // Gemini 2.0 系列
    'gemini-2.0-flash': 'gemini-2.0-flash-001',
    'gemini-2.0-flash-exp': 'gemini-2.0-flash-exp',
    'gemini-2.0-flash-lite': 'gemini-2.0-flash-lite-001',
    // Gemini 2.5 系列 (experimental)
    'gemini-2.5-pro': 'gemini-2.5-pro-exp-03-25',
    'gemini-2.5-flash': 'gemini-2.5-flash-preview-04-17',
    'gemini-2.5-pro-exp': 'gemini-2.5-pro-exp-03-25',
    'gemini-2.5-flash-preview': 'gemini-2.5-flash-preview-04-17',
    // 直接使用的模型名（不做映射）
    'gemini-1.5-pro-001': 'gemini-1.5-pro-001',
    'gemini-1.5-pro-002': 'gemini-1.5-pro-002',
    'gemini-1.5-flash-001': 'gemini-1.5-flash-001',
    'gemini-1.5-flash-002': 'gemini-1.5-flash-002',
    'gemini-2.0-flash-001': 'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite-001': 'gemini-2.0-flash-lite-001'
};

/**
 * 默认模型
 */
export const VERTEX_DEFAULT_MODEL = 'claude-sonnet-4-5@20250929';

/**
 * Vertex AI 支持的区域
 */
export const VERTEX_REGIONS = [
    'global',
    'us-central1',
    'us-east5',
    'europe-west1',
    'europe-west4',
    'asia-southeast1'
];

/**
 * GCP Vertex AI 客户端类
 */
export class VertexClient {
    /**
     * @param {Object} options - 配置选项
     * @param {string} options.projectId - GCP 项目 ID
     * @param {string} options.region - GCP 区域 (默认 global)
     * @param {Object} options.credentials - GCP 服务账号凭据对象
     * @param {string} options.keyFilePath - GCP 服务账号密钥文件路径
     * @param {boolean} options.sslVerify - 是否验证 SSL (默认 true)
     */
    constructor(options = {}) {
        this.projectId = options.projectId;
        this.region = options.region || 'global';
        this.credentials = options.credentials;
        this.keyFilePath = options.keyFilePath;
        this.sslVerify = options.sslVerify !== false;
        this.accessToken = null;
        this.tokenExpiry = null;
    }

    /**
     * 从密钥文件创建客户端
     */
    static async fromKeyFile(keyFilePath, region = 'global') {
        const content = await fs.readFile(keyFilePath, 'utf8');
        const credentials = JSON.parse(content);

        return new VertexClient({
            projectId: credentials.project_id,
            region,
            credentials
        });
    }

    /**
     * 从凭据对象创建客户端
     */
    static fromCredentials(credentials, region = 'global') {
        return new VertexClient({
            projectId: credentials.project_id,
            region,
            credentials
        });
    }

    /**
     * 获取访问令牌
     */
    async getAccessToken() {
        // 检查现有 token 是否有效
        if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry - 60000) {
            console.log('[Vertex] 使用缓存的 access token');
            return this.accessToken;
        }

        if (!this.credentials) {
            throw new Error('缺少 GCP 凭据');
        }

        console.log('[Vertex] 需要获取新的 access token');
        console.log(`[Vertex] client_email: ${this.credentials.client_email}`);

        const now = Math.floor(Date.now() / 1000);
        const expiry = now + 3600;

        // 构建 JWT
        const header = {
            alg: 'RS256',
            typ: 'JWT'
        };

        const payload = {
            iss: this.credentials.client_email,
            sub: this.credentials.client_email,
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: expiry,
            scope: 'https://www.googleapis.com/auth/cloud-platform'
        };

        console.log('[Vertex] 签名 JWT...');
        const jwt = await this._signJWT(header, payload, this.credentials.private_key);
        console.log('[Vertex] JWT 签名完成');

        // 交换 JWT 获取访问令牌
        const proxyConfig = getAxiosProxyConfig();
        console.log(`[Vertex] 代理配置: ${proxyConfig.httpsAgent ? 'enabled' : 'disabled'}`);
        console.log('[Vertex] 请求 oauth2.googleapis.com/token ...');

        const response = await axios.post('https://oauth2.googleapis.com/token', {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
            ...proxyConfig
        });

        console.log('[Vertex] oauth2 token 获取成功');
        this.accessToken = response.data.access_token;
        this.tokenExpiry = Date.now() + (response.data.expires_in * 1000);

        log.info(`Vertex AI Token 获取成功，过期时间: ${new Date(this.tokenExpiry).toISOString()}`);
        return this.accessToken;
    }

    /**
     * 签名 JWT
     */
    async _signJWT(header, payload, privateKey) {
        const crypto = await import('crypto');

        const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const signatureInput = `${encodedHeader}.${encodedPayload}`;

        const sign = crypto.createSign('RSA-SHA256');
        sign.update(signatureInput);
        const signature = sign.sign(privateKey, 'base64url');

        return `${signatureInput}.${signature}`;
    }

    /**
     * 获取 Vertex AI API URL (Claude)
     */
    _getApiUrl(model, stream = false) {
        const vertexModel = VERTEX_MODEL_MAPPING[model] || model;
        const action = stream ? 'streamRawPredict' : 'rawPredict';

        if (this.region === 'global') {
            return `https://aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/us-central1/publishers/anthropic/models/${vertexModel}:${action}`;
        }

        return `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/anthropic/models/${vertexModel}:${action}`;
    }

    /**
     * 获取 Vertex AI Gemini API URL
     */
    _getGeminiApiUrl(model, stream = false) {
        const vertexModel = VERTEX_GEMINI_MODEL_MAPPING[model] || model;
        const action = stream ? 'streamGenerateContent' : 'generateContent';

        // Gemini 使用 global 或指定区域
        return `https://aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/global/publishers/google/models/${vertexModel}:${action}`;
    }

    /**
     * 检测是否为 Gemini 模型
     */
    _isGeminiModel(model) {
        return model && (model.startsWith('gemini') || VERTEX_GEMINI_MODEL_MAPPING[model]);
    }

    /**
     * 转换请求为 Vertex AI 格式
     */
    _convertRequest(messages, model, options = {}) {
        const request = {
            anthropic_version: 'vertex-2023-10-16',
            messages: messages.map(msg => ({
                role: msg.role,
                content: msg.content
            })),
            max_tokens: options.max_tokens || 8192
        };

        if (options.system) {
            request.system = options.system;
        }

        if (options.temperature !== undefined) {
            request.temperature = options.temperature;
        }

        if (options.top_p !== undefined) {
            request.top_p = options.top_p;
        }

        if (options.top_k !== undefined) {
            request.top_k = options.top_k;
        }

        if (options.stop_sequences) {
            request.stop_sequences = options.stop_sequences;
        }

        if (options.tools && Array.isArray(options.tools)) {
            request.tools = this._cleanTools(options.tools);
        }

        if (options.tool_choice) {
            request.tool_choice = options.tool_choice;
        }

        if (options.metadata) {
            request.metadata = options.metadata;
        }

        return request;
    }

    /**
     * 清理工具定义（移除 Vertex AI 不支持的字段）
     */
    _cleanTools(tools) {
        return tools.map(tool => {
            const cleaned = { ...tool };

            // 移除 input_examples
            if (cleaned.input_examples) {
                delete cleaned.input_examples;
            }

            // 清理 input_schema 中的 $comment
            if (cleaned.input_schema) {
                cleaned.input_schema = this._cleanSchema(cleaned.input_schema);
            }

            return cleaned;
        });
    }

    /**
     * 递归清理 schema 中的 $comment
     */
    _cleanSchema(schema) {
        if (!schema || typeof schema !== 'object') {
            return schema;
        }

        const cleaned = { ...schema };
        delete cleaned.$comment;

        if (cleaned.properties) {
            cleaned.properties = {};
            for (const [key, value] of Object.entries(schema.properties)) {
                cleaned.properties[key] = this._cleanSchema(value);
            }
        }

        if (cleaned.items) {
            cleaned.items = this._cleanSchema(schema.items);
        }

        return cleaned;
    }

    /**
     * 发送聊天请求（非流式）
     */
    async chat(messages, model = 'claude-sonnet-4-5', options = {}) {
        console.log('[Vertex] chat() 开始');
        console.log('[Vertex] 获取 access token...');
        const accessToken = await this.getAccessToken();
        console.log('[Vertex] access token 获取成功');

        const url = this._getApiUrl(model, false);
        console.log(`[Vertex] API URL: ${url}`);

        const requestData = this._convertRequest(messages, model, options);

        log.info(`Vertex AI 请求: ${url}`);
        log.debug(`请求数据: ${JSON.stringify(requestData).substring(0, 500)}...`);

        const proxyConfig = getAxiosProxyConfig();
        console.log(`[Vertex] 代理配置: ${JSON.stringify(proxyConfig ? 'enabled' : 'disabled')}`);
        console.log('[Vertex] 发送请求到 Vertex AI...');

        try {
            // 构建请求配置
            const requestConfig = {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 300000,
                ...proxyConfig
            };

            // 只有在禁用 SSL 验证且没有代理 agent 时才设置自定义 httpsAgent
            if (!this.sslVerify && !proxyConfig.httpsAgent) {
                requestConfig.httpsAgent = new (await import('https')).Agent({ rejectUnauthorized: false });
            }

            console.log('[Vertex] 请求配置:', {
                hasHttpsAgent: !!requestConfig.httpsAgent,
                hasHttpAgent: !!requestConfig.httpAgent,
                timeout: requestConfig.timeout
            });

            const response = await axios.post(url, requestData, requestConfig);

            console.log('[Vertex] 请求成功');
            return response.data;
        } catch (error) {
            console.error('[Vertex] 请求失败:', error.message);
            if (error.cause) {
                console.error('[Vertex] 错误原因:', error.cause);
            }
            if (error.errors) {
                console.error('[Vertex] 错误详情:', error.errors);
            }
            if (error.response) {
                console.error('[Vertex] 响应状态:', error.response.status);
                console.error('[Vertex] 响应数据:', JSON.stringify(error.response.data));
            }
            throw error;
        }
    }

    /**
     * 发送聊天请求（流式）
     */
    async *chatStream(messages, model = 'claude-sonnet-4-5', options = {}) {
        const accessToken = await this.getAccessToken();
        const url = this._getApiUrl(model, true);
        const requestData = this._convertRequest(messages, model, { ...options, stream: true });

        log.info(`Vertex AI 流式请求: ${url}`);

        const proxyConfig = getAxiosProxyConfig();
        const requestConfig = {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 300000,
            responseType: 'stream',
            ...proxyConfig
        };

        // 只有在禁用 SSL 验证且没有代理 agent 时才设置自定义 httpsAgent
        if (!this.sslVerify && !proxyConfig.httpsAgent) {
            requestConfig.httpsAgent = new (await import('https')).Agent({ rejectUnauthorized: false });
        }

        console.log(`[Vertex Stream] URL: ${url}`);
        console.log(`[Vertex Stream] Model: ${model}`);
        console.log(`[Vertex Stream] Request body: ${JSON.stringify(requestData).substring(0, 500)}`);

        let response;
        try {
            response = await axios.post(url, requestData, requestConfig);
        } catch (error) {
            console.error('[Vertex Stream] 请求失败:', error.message);
            if (error.response) {
                console.error('[Vertex Stream] 响应状态:', error.response.status);
                // 尝试读取错误响应体
                if (error.response.data) {
                    try {
                        if (typeof error.response.data === 'string') {
                            console.error('[Vertex Stream] 错误响应:', error.response.data);
                        } else if (error.response.data.pipe) {
                            const chunks = [];
                            for await (const chunk of error.response.data) {
                                chunks.push(chunk);
                            }
                            console.error('[Vertex Stream] 错误响应:', Buffer.concat(chunks).toString());
                        } else {
                            console.error('[Vertex Stream] 错误响应:', JSON.stringify(error.response.data));
                        }
                    } catch (e) {
                        console.error('[Vertex Stream] 无法读取错误响应');
                    }
                }
            }
            throw error;
        }

        let buffer = '';

        for await (const chunk of response.data) {
            buffer += chunk.toString();

            // 解析 SSE 事件
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();

                    if (data === '[DONE]') {
                        return;
                    }

                    // 跳过 vertex_event 和 ping
                    if (data.includes('"type":"vertex_event"') || data.includes('"type":"ping"')) {
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        yield parsed;
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }

        // 处理剩余数据
        if (buffer.trim()) {
            if (buffer.startsWith('data: ')) {
                const data = buffer.slice(6).trim();
                if (data && data !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(data);
                        yield parsed;
                    } catch (e) {
                        // 忽略
                    }
                }
            }
        }
    }

    /**
     * Token 计数
     */
    async countTokens(messages, model = 'claude-sonnet-4-5', options = {}) {
        const accessToken = await this.getAccessToken();

        // Token 计数在某些区域不支持，回退到 us-central1
        let region = this.region;
        if (region === 'global') {
            region = 'us-central1';
        }

        const vertexModel = VERTEX_MODEL_MAPPING[model] || model;
        const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${region}/publishers/anthropic/models/${vertexModel}:countTokens`;

        const requestData = {
            anthropic_version: 'vertex-2023-10-16',
            messages: messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }))
        };

        if (options.system) {
            requestData.system = options.system;
        }

        const proxyConfig = getAxiosProxyConfig();
        const response = await axios.post(url, requestData, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000,
            ...proxyConfig
        });

        return response.data;
    }

    /**
     * 获取支持的模型列表
     */
    getModels() {
        return Object.keys(VERTEX_MODEL_MAPPING);
    }

    /**
     * 获取模型映射
     */
    getModelMapping() {
        return VERTEX_MODEL_MAPPING;
    }

    /**
     * 转换 Claude 格式消息为 Gemini 格式
     */
    _convertToGeminiMessages(messages) {
        return messages.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
        }));
    }

    /**
     * 转换请求为 Gemini 格式
     */
    _convertGeminiRequest(messages, model, options = {}) {
        const contents = this._convertToGeminiMessages(messages);

        const request = {
            contents
        };

        // 添加系统提示
        if (options.system) {
            const systemText = typeof options.system === 'string'
                ? options.system
                : (Array.isArray(options.system) ? options.system.map(s => s.text || s).join('\n') : String(options.system));
            request.systemInstruction = { parts: [{ text: systemText }] };
        }

        // 添加生成配置
        const generationConfig = {};
        if (options.max_tokens) {
            generationConfig.maxOutputTokens = options.max_tokens;
        }
        if (options.temperature !== undefined) {
            generationConfig.temperature = options.temperature;
        }
        if (options.top_p !== undefined) {
            generationConfig.topP = options.top_p;
        }
        if (options.top_k !== undefined) {
            generationConfig.topK = options.top_k;
        }
        if (Object.keys(generationConfig).length > 0) {
            request.generationConfig = generationConfig;
        }

        return request;
    }

    /**
     * 转换 Gemini 响应为 Claude 格式
     */
    _convertGeminiResponse(response, model) {
        const messageId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 8);

        let text = '';
        if (response.candidates && response.candidates[0]?.content?.parts) {
            text = response.candidates[0].content.parts.map(p => p.text || '').join('');
        }

        const inputTokens = response.usageMetadata?.promptTokenCount || 0;
        const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

        return {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens
            }
        };
    }

    /**
     * Gemini 聊天（非流式）
     */
    async geminiChat(messages, model = 'gemini-1.5-flash', options = {}) {
        console.log('[Vertex/Gemini] chat() 开始');
        console.log('[Vertex/Gemini] 获取 access token...');
        const accessToken = await this.getAccessToken();
        console.log('[Vertex/Gemini] access token 获取成功');

        const url = this._getGeminiApiUrl(model, false);
        console.log(`[Vertex/Gemini] API URL: ${url}`);

        const requestData = this._convertGeminiRequest(messages, model, options);

        log.info(`Vertex AI Gemini 请求: ${url}`);
        log.debug(`请求数据: ${JSON.stringify(requestData).substring(0, 500)}...`);

        const proxyConfig = getAxiosProxyConfig();
        console.log(`[Vertex/Gemini] 代理配置: ${proxyConfig.httpsAgent ? 'enabled' : 'disabled'}`);
        console.log('[Vertex/Gemini] 发送请求到 Vertex AI...');

        try {
            const requestConfig = {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 300000,
                ...proxyConfig
            };

            if (!this.sslVerify && !proxyConfig.httpsAgent) {
                requestConfig.httpsAgent = new (await import('https')).Agent({ rejectUnauthorized: false });
            }

            const response = await axios.post(url, requestData, requestConfig);

            console.log('[Vertex/Gemini] 请求成功');
            return this._convertGeminiResponse(response.data, model);
        } catch (error) {
            console.error('[Vertex/Gemini] 请求失败:', error.message);
            if (error.response) {
                console.error('[Vertex/Gemini] 响应状态:', error.response.status);
                console.error('[Vertex/Gemini] 响应数据:', JSON.stringify(error.response.data));
            }
            throw error;
        }
    }

    /**
     * Gemini 聊天（流式）
     */
    async *geminiChatStream(messages, model = 'gemini-1.5-flash', options = {}) {
        console.log('[Vertex/Gemini] chatStream() 开始');
        const accessToken = await this.getAccessToken();
        const url = this._getGeminiApiUrl(model, true) + '?alt=sse';
        console.log(`[Vertex/Gemini] Stream URL: ${url}`);

        const requestData = this._convertGeminiRequest(messages, model, options);

        const proxyConfig = getAxiosProxyConfig();

        const requestConfig = {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 300000,
            responseType: 'stream',
            ...proxyConfig
        };

        if (!this.sslVerify && !proxyConfig.httpsAgent) {
            requestConfig.httpsAgent = new (await import('https')).Agent({ rejectUnauthorized: false });
        }

        const response = await axios.post(url, requestData, requestConfig);

        let buffer = '';

        for await (const chunk of response.data) {
            buffer += chunk.toString();

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data && data !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(data);
                            // 提取文本
                            if (parsed.candidates && parsed.candidates[0]?.content?.parts) {
                                for (const part of parsed.candidates[0].content.parts) {
                                    if (part.text) {
                                        yield {
                                            type: 'content_block_delta',
                                            delta: { type: 'text_delta', text: part.text }
                                        };
                                    }
                                }
                            }
                            // 提取 usage
                            if (parsed.usageMetadata) {
                                yield {
                                    type: 'usage',
                                    usage: {
                                        input_tokens: parsed.usageMetadata.promptTokenCount || 0,
                                        output_tokens: parsed.usageMetadata.candidatesTokenCount || 0
                                    }
                                };
                            }
                        } catch (e) {
                            // 忽略解析错误
                        }
                    }
                }
            }
        }
    }
}

/**
 * Vertex AI API 服务类（无状态）
 */
export class VertexAPI {
    /**
     * 从凭据刷新/获取访问令牌
     */
    static async getAccessToken(credentials) {
        const client = VertexClient.fromCredentials(credentials);
        return await client.getAccessToken();
    }

    /**
     * 聊天（非流式）
     */
    static async chat(credentials, messages, model, options = {}) {
        const client = VertexClient.fromCredentials(credentials, options.region);
        return await client.chat(messages, model, options);
    }

    /**
     * 聊天（流式）
     */
    static async *chatStream(credentials, messages, model, options = {}) {
        const client = VertexClient.fromCredentials(credentials, options.region);
        yield* client.chatStream(messages, model, options);
    }

    /**
     * Token 计数
     */
    static async countTokens(credentials, messages, model, options = {}) {
        const client = VertexClient.fromCredentials(credentials, options.region);
        return await client.countTokens(messages, model, options);
    }

    /**
     * 获取模型列表
     */
    static getModels() {
        return Object.keys(VERTEX_MODEL_MAPPING);
    }

    /**
     * 获取模型映射
     */
    static getModelMapping() {
        return VERTEX_MODEL_MAPPING;
    }

    /**
     * 获取支持的区域
     */
    static getRegions() {
        return VERTEX_REGIONS;
    }
}

export default VertexClient;
