/**
 * Gemini Antigravity API 核心模块
 * 参考 AIClient-2-API 实现
 */

import { OAuth2Client } from 'google-auth-library';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { logger } from '../logger.js';
import { getProxyAgent } from '../proxy.js';

// 活动的回调服务器
let activeCallbackServer = null;

const log = logger.api;

// ============ 常量配置 ============

// 凭据存储目录
const CREDENTIALS_DIR = '.antigravity';
const CREDENTIALS_FILE = 'oauth_creds.json';

// Base URLs - 按照降级顺序 (Sandbox → Daily → Prod)
// 优先使用 Sandbox/Daily 环境以避免 Prod 环境的 429 错误
const ANTIGRAVITY_BASE_URLS = [
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://daily-cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com'
];

const ANTIGRAVITY_API_VERSION = 'v1internal';

// OAuth 配置
const OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const OAUTH_SCOPE = ['https://www.googleapis.com/auth/cloud-platform'];
const OAUTH_CALLBACK_PORT = 8086;

// 默认配置
const DEFAULT_USER_AGENT = 'antigravity/1.11.9 windows/amd64';
const REFRESH_SKEW = 3000; // 3000秒（50分钟）提前刷新Token
const REQUEST_TIMEOUT = 120000; // 2分钟

// ============ 模型配置 ============

// 支持的模型列表
export const GEMINI_MODELS = [
    'gemini-2.5-computer-use-preview-10-2025',
    'gemini-3-pro-image-preview',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-flash-preview',
    'gemini-claude-sonnet-4-5',
    'gemini-claude-sonnet-4-5-thinking',
    'gemini-claude-opus-4-5-thinking'
];

// 别名 -> 真实模型名
const MODEL_ALIAS_MAP = {
    'gemini-2.5-computer-use-preview-10-2025': 'rev19-uic3-1p',
    'gemini-3-pro-image-preview': 'gemini-3-pro-image',
    'gemini-3-pro-preview': 'gemini-3-pro-high',
    'gemini-3-flash-preview': 'gemini-3-flash',
    'gemini-2.5-flash-preview': 'gemini-2.5-flash',
    'gemini-claude-sonnet-4-5': 'claude-sonnet-4-5',
    'gemini-claude-sonnet-4-5-thinking': 'claude-sonnet-4-5-thinking',
    'gemini-claude-opus-4-5-thinking': 'claude-opus-4-5-thinking'
};

// 真实模型名 -> 别名
const MODEL_NAME_MAP = {
    'rev19-uic3-1p': 'gemini-2.5-computer-use-preview-10-2025',
    'gemini-3-pro-image': 'gemini-3-pro-image-preview',
    'gemini-3-pro-high': 'gemini-3-pro-preview',
    'gemini-3-flash': 'gemini-3-flash-preview',
    'gemini-2.5-flash': 'gemini-2.5-flash-preview',
    'claude-sonnet-4-5': 'gemini-claude-sonnet-4-5',
    'claude-sonnet-4-5-thinking': 'gemini-claude-sonnet-4-5-thinking',
    'claude-opus-4-5-thinking': 'gemini-claude-opus-4-5-thinking'
};

// ============ 工具函数 ============

/**
 * 别名转真实模型名
 */
export function alias2ModelName(alias) {
    return MODEL_ALIAS_MAP[alias] || alias;
}

/**
 * 真实模型名转别名
 */
export function modelName2Alias(modelName) {
    return MODEL_NAME_MAP[modelName] || modelName;
}

/**
 * 判断是否为 Claude 模型
 */
export function isClaude(modelName) {
    return modelName.toLowerCase().includes('claude');
}

/**
 * 生成项目 ID
 */
function generateProjectID() {
    return `antigravity-${Date.now()}`;
}

/**
 * 生成请求 ID
 */
function generateRequestID() {
    return crypto.randomUUID();
}

/**
 * 生成稳定的会话 ID
 */
function generateStableSessionID(template) {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(template.request?.contents || []));
    return hash.digest('hex').substring(0, 32);
}

/**
 * 确保消息内容有正确的 role
 */
function ensureRolesInContents(requestBody) {
    if (!requestBody.contents) return requestBody;

    requestBody.contents = requestBody.contents.map((content, index) => {
        if (!content.role) {
            content.role = index % 2 === 0 ? 'user' : 'model';
        }
        return content;
    });

    return requestBody;
}

/**
 * 处理 Thinking 配置
 */
function normalizeAntigravityThinking(modelName, template, isClaudeModel) {
    const modelLower = modelName.toLowerCase();

    // 判断是否为 Gemini 3 thinking 模型
    const isGemini3Thinking = modelLower.includes('gemini-3') &&
        (modelLower.endsWith('-high') || modelLower.endsWith('-low') || modelLower.includes('-pro'));

    // 判断是否为 Claude thinking 模型
    const isClaudeThinking = isClaudeModel && modelLower.includes('thinking');

    // Gemini 3 Pro (high/low) 或 Claude thinking 模型需要 thinkingConfig
    if (isGemini3Thinking || isClaudeThinking) {
        if (!template.request.generationConfig) {
            template.request.generationConfig = {};
        }
        template.request.generationConfig.thinkingConfig = {
            includeThoughts: true,
            thinkingBudget: 32000
        };
    }
    // Gemini 3 Flash 模型 thinking 配置
    else if (modelLower.startsWith('gemini-3-flash')) {
        if (!template.request.generationConfig) {
            template.request.generationConfig = {};
        }
        if (!template.request.generationConfig.thinkingConfig) {
            template.request.generationConfig.thinkingConfig = {
                thinkingBudget: 0
            };
        }
    }

    return template;
}

/**
 * 转换 Gemini 格式到 Antigravity 格式
 */
function geminiToAntigravity(modelName, payload, projectId) {
    let template = JSON.parse(JSON.stringify(payload));
    const isClaudeModel = isClaude(modelName);

    // 设置基本字段
    template.model = modelName;
    template.userAgent = 'antigravity';
    template.project = projectId || generateProjectID();
    template.requestId = `agent-${generateRequestID()}`; // 使用 agent- 前缀
    template.requestType = 'agent'; // 关键字段！

    // 设置会话ID
    template.request.sessionId = generateStableSessionID(template);

    // 删除安全设置
    if (template.request.safetySettings) {
        delete template.request.safetySettings;
    }

    // Claude 模型禁止使用 tools
    if (isClaudeModel) {
        delete template.request.tools;
        delete template.request.toolConfig;
    }

    // 处理 Thinking 配置
    template = normalizeAntigravityThinking(modelName, template, isClaudeModel);

    // 注入 systemInstruction (如果没有的话)
    if (!template.request.systemInstruction) {
        template.request.systemInstruction = {
            role: 'user',
            parts: [{ text: 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team.' }]
        };
    }

    return template;
}

/**
 ntigravity 响应到 Gemini API 格式
 */
function toGeminiApiResponse(response) {
    if (!response) return null;

    return {
        candidates: response.candidates || [],
        usageMetadata: response.usageMetadata || {},
        modelVersion: response.modelVersion
    };
}

/**
 * 转换 Claude 格式消息到 Gemini 格式
 */
export function claudeToGeminiMessages(messages) {
    const contents = [];

    for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'model' : 'user';

        if (typeof msg.content === 'string') {
            contents.push({
                role,
                parts: [{ text: msg.content }]
            });
        } else if (Array.isArray(msg.content)) {
            const parts = [];
            for (const part of msg.content) {
                if (part.type === 'text') {
                    parts.push({ text: part.text });
                } else if (part.type === 'image' && part.source) {
                    parts.push({
                        inlineData: {
                            mimeType: part.source.media_type,
                            data: part.source.data
                        }
                    });
                }
            }
            contents.push({ role, parts });
        }
    }

    return contents;
}

/**
 * 转换 Gemini 响应到 Claude 格式
 */
export function geminiToClaudeResponse(geminiResponse, model) {
    if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) {
        return {
            id: `msg_${generateRequestID()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 }
        };
    }

    const candidate = geminiResponse.candidates[0];
    const content = [];

    if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
            if (part.text) {
                content.push({ type: 'text', text: part.text });
            }
        }
    }

    const usage = geminiResponse.usageMetadata || {};

    return {
        id: `msg_${generateRequestID()}`,
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: candidate.finishReason === 'STOP' ? 'end_turn' : candidate.finishReason?.toLowerCase() || 'end_turn',
        usage: {
            input_tokens: usage.promptTokenCount || 0,
            output_tokens: usage.candidatesTokenCount || 0
        }
    };
}

// ============ Antigravity API Service ============

export class AntigravityApiService {
    constructor(config = {}) {
        this.config = config;
        this.oauthCredsFilePath = config.oauthCredsFilePath;
        this.projectId = config.projectId;
        this.userAgent = config.userAgent || DEFAULT_USER_AGENT;
        this.baseURLs = config.baseURLs || ANTIGRAVITY_BASE_URLS;
        this.availableModels = GEMINI_MODELS;
        this.isInitialized = false;

        // 获取代理配置
        const proxyAgent = getProxyAgent();

        // 创建 OAuth2 客户端（带代理支持）
        const authClientOptions = {
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET
        };

        if (proxyAgent) {
            authClientOptions.transporterOptions = {
                agent: proxyAgent
            };
            console.log('[Antigravity] OAuth2Client 已配置代理');
        }

        this.authClient = new OAuth2Client(authClientOptions);
    }

    /**
     * 从凭据对象初始化
     */
    static fromCredentials(credentials) {
        const service = new AntigravityApiService({
            projectId: credentials.projectId
        });

        service.authClient.setCredentials({
            access_token: credentials.accessToken,
            refresh_token: credentials.refreshToken,
            expiry_date: credentials.expiresAt ? new Date(credentials.expiresAt).getTime() : null
        });

        // 确保代理配置已应用
        const proxyAgent = getProxyAgent();
        if (proxyAgent && !service.authClient._transporterOptions?.agent) {
            service.authClient._transporterOptions = {
                agent: proxyAgent
            };
        }

        return service;
    }

    /**
     * 完整初始化流程
     */
    async initialize() {
        if (this.isInitialized) return;
        console.log('[Antigravity] Initializing Antigravity API Service...');

        // 检查 token 是否需要刷新
        if (this.isTokenExpiringSoon()) {
            console.log('[Antigravity] Token expiring soon, refreshing...');
            await this.refreshToken();
        }

        // 发现 Project ID
        if (!this.projectId) {
            this.projectId = await this.discoverProjectAndModels();
        } else {
            console.log(`[Antigravity] Using provided Project ID: ${this.projectId}`);
            await this.fetchAvailableModels();
        }

        this.isInitialized = true;
        console.log(`[Antigravity] Initialization complete. Project ID: ${this.projectId}`);
    }

    /**
     * 发现 Project ID 和可用模型
     */
    async discoverProjectAndModels() {
        if (this.projectId) {
            console.log(`[Antigravity] Using pre-configured Project ID: ${this.projectId}`);
            return this.projectId;
        }

        console.log('[Antigravity] Discovering Project ID...');
        try {
            const initialProjectId = "";
            const clientMetadata = {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
                duetProject: initialProjectId,
            };

            const loadRequest = {
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            };

            const loadResponse = await this.callApi('loadCodeAssist', loadRequest);
            console.log('[Antigravity] loadCodeAssist response:', JSON.stringify(loadResponse, null, 2));

            // 检查是否已有 project（可能是字符串或对象）
            const existingProject = loadResponse.cloudaicompanionProject;
            if (existingProject) {
                const projectId = typeof existingProject === 'object' ? existingProject.id : existingProject;
                if (projectId) {
                    console.log(`[Antigravity] Discovered existing Project ID: ${projectId}`);
                    await this.fetchAvailableModels();
                    return projectId;
                }
            }

            // 如果没有现有项目，需要 onboard
            console.log('[Antigravity] No existing project, starting onboard process...');
            const defaultTier = loadResponse.allowedTiers?.find(tier => tier.isDefault);
            const tierId = defaultTier?.id || 'free-tier';
            console.log(`[Antigravity] Using tier: ${tierId}`);

            const onboardRequest = {
                tierId: tierId,
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            };

            const lroResponse = await this.callApi('onboardUser', onboardRequest);
            console.log('[Antigravity] onboardUser response:', JSON.stringify(lroResponse, null, 2));

            // 检查是否立即完成
            if (lroResponse.done) {
                const projectInfo = lroResponse.response?.cloudaicompanionProject;
                const discoveredProjectId = projectInfo?.id || projectInfo?.name;
                if (discoveredProjectId) {
                    console.log(`[Antigravity] Onboarded successfully! Project ID: ${discoveredProjectId}`);
                    await this.fetchAvailableModels();
                    return discoveredProjectId;
                }
            }

            // 如果返回了 operation name，需要轮询
            if (lroResponse.name && !lroResponse.done) {
                console.log(`[Antigravity] Onboard operation started: ${lroResponse.name}, polling...`);
                const MAX_RETRIES = 30;
                let retryCount = 0;
                let pollResponse = lroResponse;

                while (!pollResponse.done && retryCount < MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    // 重新调用 onboardUser 来检查状态
                    pollResponse = await this.callApi('onboardUser', onboardRequest);
                    retryCount++;
                    console.log(`[Antigravity] Polling attempt ${retryCount}, done: ${pollResponse.done}`);
                }

                if (pollResponse.done) {
                    const projectInfo = pollResponse.response?.cloudaicompanionProject;
                    const discoveredProjectId = projectInfo?.id || projectInfo?.name;
                    if (discoveredProjectId) {
                        console.log(`[Antigravity] Onboarded successfully! Project ID: ${discoveredProjectId}`);
                        await this.fetchAvailableModels();
                        return discoveredProjectId;
                    }
                }

                throw new Error('Onboarding timeout or failed to get project ID');
            }

            throw new Error('Onboarding failed: unexpected response');
        } catch (error) {
            console.error('[Antigravity] Failed to discover Project ID:', error.response?.data || error.message);
            throw error; // 不再 fallback，直接抛出错误让调用方处理
        }
    }

    /**
     * 获取可用模型列表
     */
    async fetchAvailableModels() {
        console.log('[Antigravity] Fetching available models...');
        const axios = (await import('axios')).default;

        // 获取代理配置（优先数据库配置，其次环境变量）
        let proxyAgent = getProxyAgent();
        const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

        if (!proxyAgent && proxyUrl) {
            const { HttpsProxyAgent } = await import('https-proxy-agent');
            proxyAgent = new HttpsProxyAgent(proxyUrl);
        }

        for (const baseURL of this.baseURLs) {
            try {
                const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;

                const axiosConfig = {
                    method: 'POST',
                    url: modelsURL,
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': this.userAgent,
                        'Authorization': `Bearer ${this.authClient.credentials.access_token}`
                    },
                    data: { project: this.projectId },
                    timeout: REQUEST_TIMEOUT
                };

                // 添加代理配置
                if (proxyAgent) {
                    axiosConfig.httpsAgent = proxyAgent;
                    axiosConfig.proxy = false;
                }

                const res = await axios(axiosConfig);
                if (res.data && res.data.models) {
                    const models = Object.keys(res.data.models);
                    this.availableModels = models
                        .map(modelName2Alias)
                        .filter(alias => alias && GEMINI_MODELS.includes(alias));

                    console.log(`[Antigravity] Available models: [${this.availableModels.join(', ')}]`);
                    return;
                }
            } catch (error) {
                console.error(`[Antigravity] Failed to fetch models from ${baseURL}:`, error.message);
            }
        }

        console.warn('[Antigravity] Failed to fetch models from all endpoints. Using default models.');
        this.availableModels = GEMINI_MODELS;
    }

    /**
     * 检查 Token 是否即将过期
     */
    isTokenExpiringSoon() {
        if (!this.authClient.credentials.expiry_date) {
            return false;
        }
        const currentTime = Date.now();
        const expiryTime = this.authClient.credentials.expiry_date;
        const refreshSkewMs = REFRESH_SKEW * 1000;
        return expiryTime <= (currentTime + refreshSkewMs);
    }

    /**
     * 初始化认证
     */
    async initializeAuth(forceRefresh = false) {
        const needsRefresh = forceRefresh || this.isTokenExpiringSoon();

        if (this.authClient.credentials.access_token && !needsRefresh) {
            return;
        }

        const credPath = this.oauthCredsFilePath || path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);

        try {
            const data = await fs.readFile(credPath, 'utf8');
            const credentials = JSON.parse(data);
            this.authClient.setCredentials(credentials);

            if (needsRefresh) {
                console.log('[Antigravity Auth] Token expiring soon or force refresh requested. Refreshing token...');
                const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
                this.authClient.setCredentials(newCredentials);
                await fs.writeFile(credPath, JSON.stringify(newCredentials, null, 2));
                console.log(`[Antigravity Auth] Token refreshed and saved to ${credPath}`);
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new Error(`OAuth credentials file not found: ${credPath}`);
            }
            throw error;
        }
    }

    /**
     * 刷新 Token
     */
    async refreshToken() {
        try {
            const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
            this.authClient.setCredentials(newCredentials);
            return {
                accessToken: newCredentials.access_token,
                refreshToken: newCredentials.refresh_token,
                expiresAt: newCredentials.expiry_date ? new Date(newCredentials.expiry_date).toISOString() : null
            };
        } catch (error) {
            throw new Error(`Token refresh failed: ${error.message}`);
        }
    }

    /**
     * 调用 API
     */
    async callApi(method, body, isRetry = false, retryCount = 0, baseURLIndex = 0) {
        const maxRetries = this.config.maxRetries || 3;
        const baseDelay = this.config.baseDelay || 1000;
        const axios = (await import('axios')).default;

        // 获取代理配置（优先数据库配置，其次环境变量）
        let proxyAgent = getProxyAgent();
        const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

        if (!proxyAgent && proxyUrl) {
            const { HttpsProxyAgent } = await import('https-proxy-agent');
            proxyAgent = new HttpsProxyAgent(proxyUrl);
        }

        if (baseURLIndex >= this.baseURLs.length) {
            throw new Error('All Antigravity base URLs failed');
        }

        const baseURL = this.baseURLs[baseURLIndex];
        const url = `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}`;

        try {
            const requestHeaders = {
                'Content-Type': 'application/json',
                'User-Agent': this.userAgent,
                'Authorization': `Bearer ${this.authClient.credentials.access_token}`
            };

            // 打印 curl 命令
            log.curl('POST', url, requestHeaders, body);

            const axiosConfig = {
                method: 'POST',
                url,
                headers: requestHeaders,
                data: body,
                timeout: REQUEST_TIMEOUT
            };

            // 添加代理配置
            if (proxyAgent) {
                axiosConfig.httpsAgent = proxyAgent;
                axiosConfig.proxy = false;
            }

            const res = await axios(axiosConfig);
            return res.data;
        } catch (error) {
            const status = error.response?.status;

            // 401/400/403 错误：刷新认证后重试
            if ((status === 400 || status === 401 || status === 403) && !isRetry) {
                console.log(`[Antigravity] 收到 ${status} 错误，尝试刷新 Token 后重试...`);
                await this.initializeAuth(true);
                return this.callApi(method, body, true, retryCount, baseURLIndex);
            }

            // 429 错误：尝试下一个 Base URL 或指数退避重试
            if (status === 429) {
                if (baseURLIndex + 1 < this.baseURLs.length) {
                    return this.callApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                } else if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(method, body, isRetry, retryCount + 1, 0);
                }
            }

            throw error;
        }
    }

    /**
     * 流式 API 调用
     */
    async *streamApi(method, body, isRetry = false) {
        // 获取代理配置（优先数据库配置，其次环境变量）
        let proxyAgent = getProxyAgent();
        const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

        if (!proxyAgent && proxyUrl) {
            const { HttpsProxyAgent } = await import('https-proxy-agent');
            proxyAgent = new HttpsProxyAgent(proxyUrl);
            console.log('[Antigravity Stream] Using env proxy:', proxyUrl);
        }

        const axios = (await import('axios')).default;

        for (let baseURLIndex = 0; baseURLIndex < this.baseURLs.length; baseURLIndex++) {
            const baseURL = this.baseURLs[baseURLIndex];

            try {
                const url = `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}?alt=sse`;
                const accessToken = this.authClient.credentials.access_token;

                // 打印请求体用于调试
                console.log('[Antigravity Stream] Request body:', JSON.stringify(body, null, 2));

                const requestHeaders = {
                    'Content-Type': 'application/json',
                    'User-Agent': this.userAgent,
                    'Authorization': `Bearer ${accessToken}`
                };

                // 打印 curl 命令
                log.curl('POST', url, requestHeaders, body);

                // 构建 axios 请求配置
                const axiosConfig = {
                    method: 'POST',
                    url,
                    headers: requestHeaders,
                    data: body,
                    responseType: 'stream',
                    timeout: REQUEST_TIMEOUT
                };

                // 如果有代理，添加代理配置
                if (proxyAgent) {
                    axiosConfig.httpsAgent = proxyAgent;
                    axiosConfig.proxy = false;
                    console.log('[Antigravity Stream] Using proxy agent');
                }

                const response = await axios(axiosConfig);

                console.log(`[Antigravity Stream] Response status: ${response.status} ${response.statusText} from ${baseURL}`);

                // 处理流式响应
                const stream = response.data;
                let buffer = '';

                for await (const chunk of stream) {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6).trim();
                            if (data && data !== '[DONE]') {
                                try {
                                    yield JSON.parse(data);
                                } catch (e) {
                                    // 忽略解析错误
                                }
                            }
                        }
                    }
                }

                return; // 成功完成，退出
            } catch (error) {
                const status = error.response?.status;
                console.log(`[Antigravity Stream] Error from ${baseURL}: ${error.message}, status: ${status}`);

                // 尝试读取错误响应体
                if (error.response?.data) {
                    let errorBody = '';
                    try {
                        if (typeof error.response.data === 'string') {
                            errorBody = error.response.data;
                        } else if (error.response.data.pipe) {
                            // 是流，读取它
                            const chunks = [];
                            for await (const chunk of error.response.data) {
                                chunks.push(chunk);
                            }
                            errorBody = Buffer.concat(chunks).toString();
                        } else {
                            errorBody = JSON.stringify(error.response.data);
                        }
                        console.log(`[Antigravity Stream] Error response body: ${errorBody}`);
                    } catch (e) {}
                }

                // 429 错误：尝试下一个 Base URL
                if (status === 429 && baseURLIndex + 1 < this.baseURLs.length) {
                    console.log(`[Antigravity Stream] 429 错误，尝试下一个 URL...`);
                    continue;
                }

                // 400/401 错误：刷新 Token 后重试（403 不重试，可能是权限问题）
                if ((status === 400 || status === 401) && !isRetry) {
                    console.log(`[Antigravity Stream] 收到 ${status} 错误，尝试刷新 Token 后重试...`);
                    await this.initializeAuth(true);
                    // 递归调用，标记为重试
                    yield* this.streamApi(method, body, true);
                    return;
                }

                if (baseURLIndex + 1 >= this.baseURLs.length) {
                    throw error;
                }
                // 尝试下一个 URL
            }
        }
    }

    /**
     * 生成内容（非流式）
     */
    async generateContent(model, requestBody) {
        // 确保已初始化
        if (!this.isInitialized) {
            await this.initialize();
        }

        let selectedModel = model;
        if (!this.availableModels.includes(model)) {
            console.warn(`[Antigravity] Model '${model}' not available. Using: '${this.availableModels[0]}'`);
            selectedModel = this.availableModels[0];
        }

        const processedRequestBody = ensureRolesInContents(JSON.parse(JSON.stringify(requestBody)));
        const actualModelName = alias2ModelName(selectedModel);
        const isClaudeModel = isClaude(actualModelName);

        const payload = geminiToAntigravity(actualModelName, { request: processedRequestBody }, this.projectId);
        payload.model = actualModelName;

        // Claude 模型使用流式请求然后转换为非流式响应
        if (isClaudeModel) {
            return await this.executeClaudeNonStream(payload);
        }

        const response = await this.callApi('generateContent', payload);
        return toGeminiApiResponse(response.response);
    }

    /**
     * Claude 模型非流式执行
     */
    async executeClaudeNonStream(payload) {
        let fullResponse = null;
        let textContent = '';

        for await (const chunk of this.streamApi('streamGenerateContent', payload)) {
            if (chunk.response) {
                fullResponse = chunk.response;
                if (chunk.response.candidates?.[0]?.content?.parts) {
                    for (const part of chunk.response.candidates[0].content.parts) {
                        if (part.text) {
                            textContent += part.text;
                        }
                    }
                }
            }
        }

        if (fullResponse && fullResponse.candidates?.[0]) {
            fullResponse.candidates[0].content = {
                parts: [{ text: textContent }],
                role: 'model'
            };
        }

        return toGeminiApiResponse(fullResponse);
    }

    /**
     * 生成内容（流式）
     */
    async *generateContentStream(model, requestBody) {
        // 确保已初始化
        if (!this.isInitialized) {
            await this.initialize();
        }

        let selectedModel = model;
        if (!this.availableModels.includes(model)) {
            console.warn(`[Antigravity] Model '${model}' not available. Using: '${this.availableModels[0]}'`);
            selectedModel = this.availableModels[0];
        }

        const processedRequestBody = ensureRolesInContents(JSON.parse(JSON.stringify(requestBody)));
        const actualModelName = alias2ModelName(selectedModel);

        const payload = geminiToAntigravity(actualModelName, { request: processedRequestBody }, this.projectId);
        payload.model = actualModelName;

        for await (const chunk of this.streamApi('streamGenerateContent', payload)) {
            yield toGeminiApiResponse(chunk.response);
        }
    }

    /**
     * 获取用量限制（带配额信息）
     */
    async getUsageLimits() {
        // 确保已初始化
        if (!this.isInitialized) {
            await this.initialize();
        }

        // 检查 token 是否即将过期
        if (this.isTokenExpiringSoon()) {
            console.log('[Antigravity] Token is near expiry, refreshing before getUsageLimits...');
            await this.refreshToken();
        }

        try {
            return await this.getModelsWithQuotas();
        } catch (error) {
            console.error('[Antigravity] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    /**
     * 获取带配额信息的模型列表
     */
    async getModelsWithQuotas() {
        const result = {
            lastUpdated: Date.now(),
            models: {}
        };

        const axios = (await import('axios')).default;

        // 获取代理配置（优先数据库配置，其次环境变量）
        let proxyAgent = getProxyAgent();
        const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

        if (!proxyAgent && proxyUrl) {
            const { HttpsProxyAgent } = await import('https-proxy-agent');
            proxyAgent = new HttpsProxyAgent(proxyUrl);
        }

        for (const baseURL of this.baseURLs) {
            try {
                const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;

                const axiosConfig = {
                    method: 'POST',
                    url: modelsURL,
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': this.userAgent,
                        'Authorization': `Bearer ${this.authClient.credentials.access_token}`
                    },
                    data: { project: this.projectId },
                    timeout: REQUEST_TIMEOUT
                };

                // 添加代理配置
                if (proxyAgent) {
                    axiosConfig.httpsAgent = proxyAgent;
                    axiosConfig.proxy = false;
                }

                const res = await axios(axiosConfig);
                console.log(`[Antigravity] fetchAvailableModels success`);
                // 打印完整响应用于调试
                console.log(`[Antigravity] Models response:`, JSON.stringify(res.data, null, 2));

                if (res.data && res.data.models) {
                    const modelsData = res.data.models;

                    for (const [modelId, modelData] of Object.entries(modelsData)) {
                        const aliasName = modelName2Alias(modelId);
                        if (!aliasName || !GEMINI_MODELS.includes(aliasName)) continue;

                        const modelInfo = {
                            remaining: 0,
                            resetTime: null,
                            resetTimeRaw: null
                        };

                        if (modelData.quotaInfo) {
                            modelInfo.remaining = modelData.quotaInfo.remainingFraction || modelData.quotaInfo.remaining || 0;
                            modelInfo.resetTime = modelData.quotaInfo.resetTime || null;
                            modelInfo.resetTimeRaw = modelData.quotaInfo.resetTime;
                        }

                        result.models[aliasName] = modelInfo;
                    }

                    // 按名称排序
                    const sortedModels = {};
                    Object.keys(result.models).sort().forEach(key => {
                        sortedModels[key] = result.models[key];
                    });
                    result.models = sortedModels;

                    console.log(`[Antigravity] Successfully fetched quotas for ${Object.keys(result.models).length} models`);
                    break;
                }
            } catch (error) {
                console.error(`[Antigravity] Failed to fetch models with quotas from ${baseURL}:`, error.message);
            }
        }

        return result;
    }

    /**
     * 列出可用模型
     */
    async listModels() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        return this.availableModels;
    }
}

// ============ OAuth 认证 ============

export const GEMINI_OAUTH_CONFIG = {
    clientId: OAUTH_CLIENT_ID,
    clientSecret: OAUTH_CLIENT_SECRET,
    scope: OAUTH_SCOPE,
    port: OAUTH_CALLBACK_PORT,
    credentialsDir: CREDENTIALS_DIR,
    credentialsFile: CREDENTIALS_FILE
};

/**
 * 生成 OAuth 认证 URL
 */
export function generateAuthUrl(redirectUri, state) {
    const authClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);
    authClient.redirectUri = redirectUri;

    const options = {
        access_type: 'offline',
        prompt: 'select_account',
        scope: OAUTH_SCOPE
    };

    if (state) {
        options.state = state;
    }

    return authClient.generateAuthUrl(options);
}

/**
 * 使用授权码获取 Token
 */
export async function getTokenFromCode(code, redirectUri) {
    const authClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);
    authClient.redirectUri = redirectUri;

    const { tokens } = await authClient.getToken(code);
    return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        tokenType: tokens.token_type,
        scope: tokens.scope
    };
}

/**
 * 刷新 Token（支持代理）
 */
export async function refreshGeminiToken(refreshToken) {
    // 获取代理配置
    let proxyAgent = getProxyAgent();
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

    if (!proxyAgent && proxyUrl) {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        proxyAgent = new HttpsProxyAgent(proxyUrl);
    }

    // 创建带代理的 OAuth2Client
    const authClientOptions = {};
    if (proxyAgent) {
        authClientOptions.transporterOptions = {
            agent: proxyAgent
        };
    }

    const authClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, undefined, authClientOptions);
    authClient.setCredentials({ refresh_token: refreshToken });

    const { credentials } = await authClient.refreshAccessToken();
    return {
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token || refreshToken,
        expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null
    };
}

/**
 * 关闭活动的回调服务器
 */
export async function closeCallbackServer() {
    if (activeCallbackServer) {
        return new Promise((resolve) => {
            activeCallbackServer.close(() => {
                console.log('[Gemini OAuth] 已关闭回调服务器');
                activeCallbackServer = null;
                resolve();
            });
        });
    }
}

/**
 * 启动 OAuth 回调服务器
 * @param {Object} options - 配置选项
 * @param {number} options.port - 监听端口，默认 8086
 * @param {Function} options.onSuccess - 成功回调 (tokens) => void
 * @param {Function} options.onError - 失败回调 (error) => void
 * @returns {Promise<{authUrl: string, server: http.Server}>}
 */
export async function startOAuthFlow(options = {}) {
    const port = options.port || OAUTH_CALLBACK_PORT;
    const host = 'localhost';
    const redirectUri = `http://${host}:${port}`;

    // 关闭之前的服务器
    await closeCallbackServer();

    const authClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);
    authClient.redirectUri = redirectUri;

    // 生成授权 URL
    const authUrl = authClient.generateAuthUrl({
        access_type: 'offline',
        prompt: 'select_account',
        scope: OAUTH_SCOPE
    });

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, redirectUri);
                const code = url.searchParams.get('code');
                const errorParam = url.searchParams.get('error');

                if (code) {
                    console.log('[Gemini OAuth] 收到授权回调, code:', code.substring(0, 20) + '...');

                    try {
                        console.log('[Gemini OAuth] 正在获取 Token...');

                        // 获取代理配置（优先使用项目配置，其次使用环境变量）
                        let proxyAgent = getProxyAgent();
                        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

                        if (!proxyAgent && proxyUrl) {
                            const { HttpsProxyAgent } = await import('https-proxy-agent');
                            proxyAgent = new HttpsProxyAgent(proxyUrl);
                            console.log('[Gemini OAuth] 使用环境变量代理:', proxyUrl);
                        } else if (proxyAgent) {
                            console.log('[Gemini OAuth] 使用项目配置代理');
                        } else {
                            console.log('[Gemini OAuth] 未配置代理，直接连接');
                        }

                        // 直接使用 axios 请求 token，绕过 OAuth2Client
                        const axios = (await import('axios')).default;
                        const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
                            code: code,
                            client_id: OAUTH_CLIENT_ID,
                            client_secret: OAUTH_CLIENT_SECRET,
                            redirect_uri: redirectUri,
                            grant_type: 'authorization_code'
                        }, {
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            httpsAgent: proxyAgent,
                            proxy: false,
                            timeout: 30000
                        });

                        const tokens = tokenResponse.data;
                        console.log('[Gemini OAuth] Token 获取成功');

                        const tokenData = {
                            accessToken: tokens.access_token,
                            refreshToken: tokens.refresh_token,
                            expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
                            tokenType: tokens.token_type,
                            scope: tokens.scope
                        };

                        // 返回成功页面
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateSuccessPage());

                        // 调用成功回调
                        if (options.onSuccess) {
                            options.onSuccess(tokenData);
                        }
                    } catch (tokenError) {
                        console.error('[Gemini OAuth] 获取 Token 失败:', tokenError.message);
                        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateErrorPage(tokenError.message));

                        if (options.onError) {
                            options.onError(tokenError);
                        }
                    } finally {
                        // 关闭服务器
                        server.close(() => {
                            activeCallbackServer = null;
                        });
                    }
                } else if (errorParam) {
                    console.error('[Gemini OAuth] 授权失败:', errorParam);
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateErrorPage(errorParam));

                    if (options.onError) {
                        options.onError(new Error(errorParam));
                    }

                    server.close(() => {
                        activeCallbackServer = null;
                    });
                } else {
                    // 忽略其他请求（如 favicon）
                    res.writeHead(204);
                    res.end();
                }
            } catch (error) {
                console.error('[Gemini OAuth] 处理回调出错:', error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateErrorPage(error.message));
            }
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`端口 ${port} 已被占用`));
            } else {
                reject(err);
            }
        });

        server.listen(port, host, () => {
            console.log(`[Gemini OAuth] 回调服务器已启动于 ${host}:${port}`);
            activeCallbackServer = server;
            resolve({ authUrl, server, port, redirectUri });
        });

        // 10 分钟超时自动关闭
        setTimeout(() => {
            if (server.listening) {
                console.log('[Gemini OAuth] 回调服务器超时，自动关闭');
                server.close(() => {
                    activeCallbackServer = null;
                });
            }
        }, 10 * 60 * 1000);
    });
}

/**
 * 生成成功页面 HTML
 */
function generateSuccessPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>授权成功</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #fff; }
        .container { text-align: center; }
        h1 { color: #4ade80; margin-bottom: 16px; }
        p { color: #a0a0a0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✓ 授权成功</h1>
        <p>您可以关闭此页面</p>
    </div>
    <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`;
}

/**
 * 生成错误页面 HTML
 */
function generateErrorPage(message) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>授权失败</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #fff; }
        .container { text-align: center; }
        h1 { color: #f87171; margin-bottom: 16px; }
        p { color: #a0a0a0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✗ 授权失败</h1>
        <p>${message}</p>
    </div>
</body>
</html>`;
}

export default AntigravityApiService;
