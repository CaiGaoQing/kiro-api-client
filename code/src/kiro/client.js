import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { KIRO_CONSTANTS, MODEL_MAPPING, KIRO_MODELS, KIRO_OAUTH_CONFIG, buildCodeWhispererUrl } from '../constants.js';
import { CredentialStore } from '../db.js';
import { logger } from '../logger.js';
import { getAxiosProxyConfig } from '../proxy.js';

const log = logger.client;
const logToken = logger.token;

/**
 * 根据凭证生成唯一的机器码
 */
function generateMachineId(credentials) {
    const uniqueKey = credentials.profileArn || credentials.clientId || 'KIRO_DEFAULT';
    return crypto.createHash('sha256').update(uniqueKey).digest('hex');
}

/**
 * 获取系统运行时信息
 */
function getSystemInfo() {
    const platform = os.platform();
    const release = os.release();
    const nodeVersion = process.version.replace('v', '');

    let osName = platform;
    if (platform === 'win32') osName = `windows#${release}`;
    else if (platform === 'darwin') osName = `macos#${release}`;
    else osName = `${platform}#${release}`;

    return { osName, nodeVersion };
}

/**
 * Kiro API 客户端
 * 通过 AWS CodeWhisperer 访问 Claude 模型
 */
export class KiroClient {
    /**
     * @param {Object} options - 配置选项
     * @param {string} options.accessToken - 访问令牌（必需）
     * @param {string} options.profileArn - Profile ARN（可选）
     * @param {string} options.region - 区域（默认 us-east-1）
     * @param {number} options.maxRetries - 最大重试次数（默认 3）
     * @param {number} options.baseDelay - 重试基础延迟毫秒（默认 1000）
     */
    constructor(options = {}) {
        if (!options.accessToken) {
            throw new Error('accessToken 是必需的');
        }

        this.region = options.region || KIRO_CONSTANTS.DEFAULT_REGION;
        this.accessToken = options.accessToken;
        this.refreshToken = options.refreshToken;
        this.profileArn = options.profileArn;
        this.clientId = options.clientId;
        this.clientSecret = options.clientSecret;
        this.authMethod = options.authMethod || KIRO_CONSTANTS.AUTH_METHOD_SOCIAL;
        this.expiresAt = options.expiresAt;

        // 重试配置
        this.maxRetries = options.maxRetries || 3;
        this.baseDelay = options.baseDelay || 1000;

        // 创建 axios 实例
        const machineId = generateMachineId({
            profileArn: this.profileArn,
            clientId: options.clientId
        });
        const { osName, nodeVersion } = getSystemInfo();
        const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;

        this.axiosInstance = axios.create({
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
            ...getAxiosProxyConfig(),
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
                'amz-sdk-request': 'attempt=1; max=1',
                'x-amzn-kiro-agent-mode': 'spec',
                'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroVersion}-${machineId}`,
                'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroVersion}-${machineId}`,
                'Connection': 'close'
            }
        });
    }

    /**
     * 从凭据文件创建客户端
     */
    static async fromCredentialsFile(credentialsPath) {
        const filePath = credentialsPath ||
            path.join(os.homedir(), KIRO_OAUTH_CONFIG.credentialsDir, KIRO_OAUTH_CONFIG.credentialsFile);

        const content = await fs.readFile(filePath, 'utf8');
        const creds = JSON.parse(content);

        return new KiroClient({
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            profileArn: creds.profileArn,
            region: creds.region,
            authMethod: creds.authMethod,
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            expiresAt: creds.expiresAt
        });
    }

    /**
     * 从数据库创建客户端（使用活跃凭据）
     */
    static async fromDatabase() {
        const store = await CredentialStore.create();
        const creds = store.getActive();

        if (!creds) {
            throw new Error('数据库中没有活跃的凭据，请先添加凭据');
        }

        return new KiroClient({
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            profileArn: creds.profileArn,
            region: creds.region,
            authMethod: creds.authMethod,
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            expiresAt: creds.expiresAt
        });
    }

    /**
     * 从数据库按 ID 创建客户端
     */
    static async fromDatabaseById(id) {
        const store = await CredentialStore.create();
        const creds = store.getById(id);

        if (!creds) {
            throw new Error(`未找到 ID 为 ${id} 的凭据`);
        }

        return new KiroClient({
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            profileArn: creds.profileArn,
            region: creds.region,
            authMethod: creds.authMethod,
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            expiresAt: creds.expiresAt
        });
    }

    /**
     * 从数据库按名称创建客户端
     */
    static async fromDatabaseByName(name) {
        const store = await CredentialStore.create();
        const creds = store.getByName(name);

        if (!creds) {
            throw new Error(`未找到名称为 "${name}" 的凭据`);
        }

        return new KiroClient({
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            profileArn: creds.profileArn,
            region: creds.region,
            authMethod: creds.authMethod,
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            expiresAt: creds.expiresAt
        });
    }

    /**
     * 检查 Token 是否即将过期（10分钟内）
     */
    isTokenExpiringSoon(minutes = 10) {
        if (!this.expiresAt) return false;
        try {
            const expirationTime = new Date(this.expiresAt);
            const currentTime = new Date();
            const thresholdTime = new Date(currentTime.getTime() + minutes * 60 * 1000);
            return expirationTime.getTime() <= thresholdTime.getTime();
        } catch (error) {
            log.error(`检查过期时间失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 刷新 Token
     * @returns {Promise<boolean>} 是否刷新成功
     */
    async refreshAccessToken() {
        if (!this.refreshToken) {
            logToken.warn('没有 refreshToken，无法刷新');
            return false;
        }

        logToken.info('开始刷新 Token...');
        logToken.info(`认证方式: ${this.authMethod}`);

        try {
            let newAccessToken, newRefreshToken, expiresAt;

            if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
                // Social 认证方式
                const refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', this.region);
                const requestBody = { refreshToken: this.refreshToken };
                const requestHeaders = { 'Content-Type': 'application/json' };
                logToken.request('POST', refreshUrl);
                logToken.curl('POST', refreshUrl, requestHeaders, requestBody);

                const response = await axios.post(refreshUrl, requestBody, {
                    headers: requestHeaders,
                    timeout: 30000,
                    ...getAxiosProxyConfig()
                });

                newAccessToken = response.data.accessToken;
                newRefreshToken = response.data.refreshToken || this.refreshToken;
                expiresAt = response.data.expiresAt || null;
            } else {
                // Builder ID / IdC 认证方式 (OIDC)
                if (!this.clientId || !this.clientSecret) {
                    logToken.warn('Builder ID/IdC 认证需要 clientId 和 clientSecret');
                    return false;
                }

                // IdC 使用 sso-oidc 端点，builder-id 使用 oidc 端点
                const refreshUrl = this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_IDC
                    ? KIRO_CONSTANTS.REFRESH_SSO_OIDC_URL.replace('{{region}}', this.region)
                    : KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', this.region);
                logToken.request('POST', refreshUrl);

                // 使用 JSON 格式发送请求（与 AIClient 一致）
                const requestBody = {
                    refreshToken: this.refreshToken,
                    clientId: this.clientId,
                    clientSecret: this.clientSecret,
                    grantType: 'refresh_token'
                };
                const requestHeaders = { 'Content-Type': 'application/json' };
                logToken.curl('POST', refreshUrl, requestHeaders, requestBody);

                const response = await axios.post(refreshUrl, requestBody, {
                    headers: requestHeaders,
                    timeout: 30000,
                    ...getAxiosProxyConfig()
                });

                // 响应字段使用 camelCase（与 social 认证一致）
                newAccessToken = response.data.accessToken || response.data.access_token;
                newRefreshToken = response.data.refreshToken || response.data.refresh_token || this.refreshToken;
                expiresAt = response.data.expiresAt
                    || (response.data.expiresIn
                        ? new Date(Date.now() + response.data.expiresIn * 1000).toISOString()
                        : null)
                    || (response.data.expires_in
                        ? new Date(Date.now() + response.data.expires_in * 1000).toISOString()
                        : null);
            }

            // 更新实例属性
            this.accessToken = newAccessToken;
            this.refreshToken = newRefreshToken;
            this.expiresAt = expiresAt;

            logToken.success('Token 刷新成功!');
            logToken.info(`新 Token 前缀: ${newAccessToken.substring(0, 20)}...`);
            logToken.info(`过期时间: ${expiresAt || '未知'}`);

            return true;
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
            logToken.fail(`Token 刷新失败: ${errorMsg}`, error.response?.status);
            return false;
        }
    }

    /**
     * 确保 Token 有效（如果即将过期则自动刷新）
     * @param {number} minutes - 提前多少分钟刷新（默认10分钟）
     * @returns {Promise<boolean>} Token 是否有效
     */
    async ensureValidToken(minutes = 10) {
        if (this.isTokenExpiringSoon(minutes)) {
            logToken.info(`Token 即将在 ${minutes} 分钟内过期，自动刷新...`);
            return await this.refreshAccessToken();
        }
        return true;
    }

    /**
     * 合并相邻相同 role 的消息
     */
    _mergeAdjacentMessages(messages) {
        const merged = [];
        for (const msg of messages) {
            if (merged.length === 0) {
                merged.push({ ...msg });
            } else {
                const last = merged[merged.length - 1];
                if (msg.role === last.role) {
                    // 合并内容
                    const lastContent = this._getContentText(last);
                    const currentContent = this._getContentText(msg);
                    last.content = `${lastContent}\n${currentContent}`;
                    log.debug(`合并相邻的 ${msg.role} 消息`);
                } else {
                    merged.push({ ...msg });
                }
            }
        }
        return merged;
    }

    /**
     * 构建请求体
     */
    _buildRequest(messages, model, options = {}) {
        const conversationId = uuidv4();
        const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[KIRO_CONSTANTS.DEFAULT_MODEL_NAME] || model;

        // 合并相邻相同 role 的消息
        const mergedMessages = this._mergeAdjacentMessages(messages);

        // 处理消息历史
        const history = [];
        const processedMessages = [...mergedMessages];

        // 处理 system prompt
        let systemPrompt = options.system || '';

        // 处理 tools
        let toolsContext = {};
        if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
            toolsContext = {
                tools: options.tools.map(tool => ({
                    toolSpecification: {
                        name: tool.name,
                        description: tool.description || "",
                        inputSchema: { json: tool.input_schema || {} }
                    }
                }))
            };
        }

        // 如果第一条是 user 消息，将 system prompt 合并进去
        if (systemPrompt && processedMessages.length > 0 && processedMessages[0].role === 'user') {
            const firstUserMsg = processedMessages[0];
            const userInputMessage = this._buildUserInputMessage(firstUserMsg, codewhispererModel, systemPrompt);
            history.push({ userInputMessage });
            processedMessages.shift();
        } else if (systemPrompt) {
            history.push({
                userInputMessage: {
                    content: systemPrompt,
                    modelId: codewhispererModel,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                }
            });
        }

        // 处理历史消息（除了最后一条）
        for (let i = 0; i < processedMessages.length - 1; i++) {
            const msg = processedMessages[i];
            if (msg.role === 'user') {
                const userInputMessage = this._buildUserInputMessage(msg, codewhispererModel);
                history.push({ userInputMessage });
            } else if (msg.role === 'assistant') {
                const assistantResponseMessage = this._buildAssistantResponseMessage(msg);
                history.push({ assistantResponseMessage });
            }
        }

        // 当前消息
        const currentMsg = processedMessages[processedMessages.length - 1];
        let currentUserInputMessage;

        // 如果没有消息，创建一个默认的 Continue 消息
        if (!currentMsg) {
            currentUserInputMessage = {
                content: 'Continue',
                modelId: codewhispererModel,
                origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
            };
        } else if (currentMsg.role === 'assistant') {
            // 如果最后一条是 assistant，移到 history 并创建 Continue
            const assistantResponseMessage = this._buildAssistantResponseMessage(currentMsg);
            history.push({ assistantResponseMessage });
            currentUserInputMessage = {
                content: 'Continue',
                modelId: codewhispererModel,
                origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
            };
        } else {
            currentUserInputMessage = this._buildUserInputMessage(currentMsg, codewhispererModel);

            // 确保 history 以 assistant 消息结尾
            if (history.length > 0 && !history[history.length - 1].assistantResponseMessage) {
                history.push({
                    assistantResponseMessage: { content: 'Continue' }
                });
            }
        }

        // 添加 tools 到 currentMessage 的 userInputMessageContext
        if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
            if (!currentUserInputMessage.userInputMessageContext) {
                currentUserInputMessage.userInputMessageContext = {};
            }
            currentUserInputMessage.userInputMessageContext.tools = toolsContext.tools;
        }

        const request = {
            conversationState: {
                chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
                conversationId,
                currentMessage: {
                    userInputMessage: currentUserInputMessage
                }
            }
        };

        if (history.length > 0) {
            request.conversationState.history = history;
        }

        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && this.profileArn) {
            request.profileArn = this.profileArn;
        }

        return request;
    }

    /**
     * 构建 userInputMessage
     */
    _buildUserInputMessage(msg, codewhispererModel, systemPromptPrefix = '') {
        const userInputMessage = {
            content: '',
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        };

        let images = [];
        let toolResults = [];

        if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text') {
                    userInputMessage.content += part.text;
                } else if (part.type === 'tool_result') {
                    toolResults.push({
                        content: [{ text: this._getContentText(part.content) }],
                        status: part.is_error ? 'error' : 'success',
                        toolUseId: part.tool_use_id
                    });
                } else if (part.type === 'image') {
                    images.push({
                        format: part.source.media_type.split('/')[1],
                        source: {
                            bytes: part.source.data
                        }
                    });
                }
            }
        } else {
            userInputMessage.content = this._getContentText(msg);
        }

        // 添加 system prompt 前缀
        if (systemPromptPrefix) {
            userInputMessage.content = `${systemPromptPrefix}\n\n${userInputMessage.content}`;
        }

        // Kiro API 要求 content 不能为空
        if (!userInputMessage.content) {
            userInputMessage.content = toolResults.length > 0 ? 'Tool results provided.' : 'Continue';
        }

        // 只添加非空字段
        if (images.length > 0) {
            userInputMessage.images = images;
        }
        if (toolResults.length > 0) {
            // 去重 toolResults
            const uniqueToolResults = [];
            const seenIds = new Set();
            for (const tr of toolResults) {
                if (!seenIds.has(tr.toolUseId)) {
                    seenIds.add(tr.toolUseId);
                    uniqueToolResults.push(tr);
                }
            }
            userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults };
        }

        return userInputMessage;
    }

    /**
     * 构建 assistantResponseMessage
     */
    _buildAssistantResponseMessage(msg) {
        const assistantResponseMessage = {
            content: ''
        };
        let toolUses = [];

        if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text') {
                    assistantResponseMessage.content += part.text;
                } else if (part.type === 'tool_use') {
                    toolUses.push({
                        input: part.input,
                        name: part.name,
                        toolUseId: part.id
                    });
                }
            }
        } else {
            assistantResponseMessage.content = this._getContentText(msg);
        }

        // Kiro API 要求 content 不能为空
        if (!assistantResponseMessage.content) {
            assistantResponseMessage.content = toolUses.length > 0 ? 'Tool calls executed.' : 'Continue';
        }

        // 只添加非空字段
        if (toolUses.length > 0) {
            assistantResponseMessage.toolUses = toolUses;
        }

        return assistantResponseMessage;
    }

    /**
     * 获取消息文本内容
     */
    _getContentText(message) {
        if (!message) return '';
        if (typeof message === 'string') return message;
        // 处理直接传入数组的情况（如 tool_result 的 content）
        if (Array.isArray(message)) {
            return message
                .map(part => {
                    if (typeof part === 'string') return part;
                    if (part.type === 'text' && part.text) return part.text;
                    if (typeof part.text === 'string') return part.text;
                    return '';
                })
                .filter(Boolean)
                .join('');
        }
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) {
            return message.content
                .filter(part => part.type === 'text' && part.text)
                .map(part => part.text)
                .join('');
        }
        // 避免返回 [object Object]
        if (typeof message === 'object') {
            if (message.text) return message.text;
            try {
                return JSON.stringify(message);
            } catch {
                return '';
            }
        }
        return String(message.content || message);
    }

    /**
     * 解析 AWS Event Stream 缓冲区
     */
    _parseEventStreamBuffer(buffer) {
        const events = [];
        let remaining = buffer;
        let searchStart = 0;

        while (true) {
            // 搜索所有可能的 JSON payload 开头模式
            const contentStart = remaining.indexOf('{"content":', searchStart);
            const followupStart = remaining.indexOf('{"followupPrompt":', searchStart);
            const nameStart = remaining.indexOf('{"name":', searchStart);
            const inputStart = remaining.indexOf('{"input":', searchStart);
            const stopStart = remaining.indexOf('{"stop":', searchStart);

            const candidates = [contentStart, followupStart, nameStart, inputStart, stopStart].filter(pos => pos >= 0);
            if (candidates.length === 0) break;

            const jsonStart = Math.min(...candidates);
            if (jsonStart < 0) break;

            // 使用括号计数法找到完整 JSON
            let braceCount = 0;
            let jsonEnd = -1;
            let inString = false;
            let escapeNext = false;

            for (let i = jsonStart; i < remaining.length; i++) {
                const char = remaining[i];

                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }

                if (char === '\\') {
                    escapeNext = true;
                    continue;
                }

                if (char === '"') {
                    inString = !inString;
                    continue;
                }

                if (!inString) {
                    if (char === '{') {
                        braceCount++;
                    } else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0) {
                            jsonEnd = i;
                            break;
                        }
                    }
                }
            }

            if (jsonEnd < 0) {
                remaining = remaining.substring(jsonStart);
                break;
            }

            const jsonStr = remaining.substring(jsonStart, jsonEnd + 1);
            try {
                const parsed = JSON.parse(jsonStr);
                // 处理 content 事件
                if (parsed.content !== undefined && !parsed.followupPrompt) {
                    events.push({ type: 'content', data: parsed.content });
                }
                // 处理结构化工具调用事件 - 开始事件（包含 name 和 toolUseId）
                else if (parsed.name && parsed.toolUseId) {
                    events.push({
                        type: 'toolUse',
                        data: {
                            name: parsed.name,
                            toolUseId: parsed.toolUseId,
                            input: parsed.input || '',
                            stop: parsed.stop || false
                        }
                    });
                }
                // 处理工具调用的 input 续传事件（只有 input 字段）
                else if (parsed.input !== undefined && !parsed.name) {
                    events.push({
                        type: 'toolUseInput',
                        data: { input: parsed.input }
                    });
                }
                // 处理工具调用的结束事件（只有 stop 字段）
                else if (parsed.stop !== undefined) {
                    events.push({
                        type: 'toolUseStop',
                        data: { stop: parsed.stop }
                    });
                }
            } catch (e) {
                // JSON 解析失败，跳过
            }

            searchStart = jsonEnd + 1;
            if (searchStart >= remaining.length) {
                remaining = '';
                break;
            }
        }

        if (searchStart > 0 && remaining.length > 0) {
            remaining = remaining.substring(searchStart);
        }

        return { events, remaining };
    }

    /**
     * 解析响应（非流式）- 返回内容和工具调用
     */
    _parseResponse(rawData) {
        const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        let fullContent = '';
        const toolCalls = [];
        let currentToolCall = null;

        const { events } = this._parseEventStreamBuffer(rawStr);
        for (const event of events) {
            if (event.type === 'content') {
                fullContent += event.data;
            } else if (event.type === 'toolUse') {
                const tc = event.data;
                if (tc.name && tc.toolUseId) {
                    if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
                        currentToolCall.input += tc.input || '';
                    } else {
                        if (currentToolCall) {
                            this._finalizeToolCall(currentToolCall, toolCalls);
                        }
                        currentToolCall = {
                            toolUseId: tc.toolUseId,
                            name: tc.name,
                            input: tc.input || ''
                        };
                    }
                    if (tc.stop) {
                        this._finalizeToolCall(currentToolCall, toolCalls);
                        currentToolCall = null;
                    }
         }
            } else if (event.type === 'toolUseInput') {
                if (currentToolCall) {
                    currentToolCall.input += event.data.input || '';
                }
            } else if (event.type === 'toolUseStop') {
                if (currentToolCall && event.data.stop) {
                    this._finalizeToolCall(currentToolCall, toolCalls);
                    currentToolCall = null;
                }
            }
        }

        // 处理未完成的工具调用
        if (currentToolCall) {
            this._finalizeToolCall(currentToolCall, toolCalls);
        }

        return { content: fullContent, toolCalls };
    }

    /**
     * 完成工具调用的解析
     */
    _finalizeToolCall(toolCall, toolCalls) {
        try {
            toolCall.input = JSON.parse(toolCall.input);
        } catch (e) {
            // input 不是有效 JSON，保持原样
        }
        toolCalls.push(toolCall);
    }

    /**
     * 检查是否为 ValidationException
     * @private
     */
    _isValidationException(error) {
        // 检查 header 中的错误类型
        const errorType = error.response?.headers?.['x-amzn-errortype'] || '';
        if (errorType.includes('ValidationException')) {
            return true;
        }

        // 检查 error.message
        if (error.message && error.message.includes('ValidationException')) {
            return true;
        }

        // 检查 response.data
        const responseData = error.response?.data;
        if (responseData) {
            if (typeof responseData === 'string' && responseData.includes('ValidationException')) {
                return true;
            }
            if (Buffer.isBuffer(responseData) && responseData.toString('utf8').includes('ValidationException')) {
                return true;
            }
            if (typeof responseData === 'object') {
                try {
                    const dataStr = JSON.stringify(responseData);
                    if (dataStr.includes('ValidationException')) {
                        return true;
                    }
                } catch {
                    // 忽略序列化错误
                }
                // 检查嵌套的 error 对象
                if (responseData.error?.message?.includes('ValidationException')) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 检查是否为上下文超限的 ValidationException（不应重试）
     * @private
     */
    _isContextLimitException(error) {
        if (!this._isValidationException(error)) {
            return false;
        }
        // ValidationException 通常是上下文超限导致的，不应重试
        return true;
    }

    /**
     * 获取自定义错误消息，屏蔽原始 AWS 错误详情
     * @private
     */
    _getCustomErrorMessage(error) {
        const status = error.response?.status;

        // 记录原始错误到日志
        const responseData = error.response?.data;
        let originalError = error.message;
        if (responseData) {
            if (typeof responseData === 'string') {
                originalError = responseData.substring(0, 500);
            } else if (Buffer.isBuffer(responseData)) {
                originalError = responseData.toString('utf8').substring(0, 500);
            } else if (typeof responseData === 'object') {
                try {
                    originalError = JSON.stringify(responseData).substring(0, 500);
                } catch (e) {
                    originalError = '[无法序列化的响应]';
                }
            }
        }

        // ValidationException 使用 debug 级别，不输出到控制台
        if (this._isValidationException(error)) {
            log.debug(`原始错误: ${status} - ${originalError}`);
        } else {
            log.error(`原始错误: ${status} - ${originalError}`);
        }

        // 返回自定义错误消息
        if (status === 400) {
            if (this._isContextLimitException(error)) {
                return '上下文超出限制，请恢复对话重试，或重新打开对话';
            }
            return '请求参数错误';
        }
        if (status === 401) return '认证失败，请重新登录';
        if (status === 403) return '访问被拒绝，Token 可能已过期';
        if (status === 429) return '请求过于频繁，请稍后重试';
        if (status >= 500) return '服务器错误，请稍后重试';

        return '请求失败，请稍后重试';
    }

    /**
     * 带重试的 API 调用
     */
    async _callWithRetry(requestFn, retryCount = 0, hasRefreshed = false) {
        try {
            return await requestFn();
        } catch (error) {
            const status = error.response?.status;

            // 403 Forbidden - 尝试刷新 Token 后重试
            if (status === 403 && !hasRefreshed) {
                log.warn('收到 403，尝试刷新 Token 后重试...');
                const refreshed = await this.refreshAccessToken();
                if (refreshed) {
                    return this._callWithRetry(requestFn, retryCount, true);
                }
            }

            // 429 Too Many Requests - 指数退避重试
            if (status === 429 && retryCount < this.maxRetries) {
                const delay = this.baseDelay * Math.pow(2, retryCount);
                log.warn(`收到 429，${delay}ms 后重试... (${retryCount + 1}/${this.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._callWithRetry(requestFn, retryCount + 1, hasRefreshed);
            }

            // 5xx 服务器错误 - 重试
            if (status >= 500 && status < 600 && retryCount < this.maxRetries) {
                const delay = this.baseDelay * Math.pow(2, retryCount);
                log.warn(`收到 ${status}，${delay}ms 后重试... (${retryCount + 1}/${this.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._callWithRetry(requestFn, retryCount + 1, hasRefreshed);
            }

            // 返回自定义错误消息，屏蔽原始 AWS 错误详情
            const customMessage = this._getCustomErrorMessage(error);
            const customError = new Error(customMessage);
            customError.status = status;

            throw customError;
        }
    }

    /**
     * 发送聊天请求
     * @param {Array} messages - 消息数组
     * @param {string} model - 模型名称
     * @param {Object} options - 选项
     * @param {boolean} options.skipTokenRefresh - 跳过 token 自动刷新
     */
    async chat(messages, model = KIRO_CONSTANTS.DEFAULT_MODEL_NAME, options = {}) {
        // 自动刷新 Token（除非明确跳过）
        // if (!options.skipTokenRefresh) {
        //     await this.ensureValidToken();
        // }

        const requestData = this._buildRequest(messages, model, options);
        const baseUrl = buildCodeWhispererUrl(KIRO_CONSTANTS.BASE_URL, this.region);

        const requestHeaders = {
            ...this.axiosInstance.defaults.headers,
            'Authorization': `Bearer ${this.accessToken}`,
            'amz-sdk-invocation-id': uuidv4()
        };
        log.curl('POST', baseUrl, requestHeaders, requestData);

        const response = await this._callWithRetry(async () => {
            return await this.axiosInstance.post(baseUrl, requestData, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'amz-sdk-invocation-id': uuidv4()
                }
            });
        });

        return this._parseResponse(response.data);
    }

    /**
     * 流式聊天请求 - 返回完整的 Claude 格式事件
     * @param {Array} messages - 消息数组
     * @param {string} model - 模型名称
     * @param {Object} options - 选项
     * @param {boolean} options.skipTokenRefresh - 跳过 token 自动刷新
     */
    async *chatStream(messages, model = KIRO_CONSTANTS.DEFAULT_MODEL_NAME, options = {}, retryCount = 0) {
        // 自动刷新 Token（除非明确跳过）
        // if (!options.skipTokenRefresh) {
        //     await this.ensureValidToken();
        // }

        const requestData = this._buildRequest(messages, model, options);
        const baseUrl = buildCodeWhispererUrl(KIRO_CONSTANTS.BASE_URL, this.region);

        const requestHeaders = {
            ...this.axiosInstance.defaults.headers,
            'Authorization': `Bearer ${this.accessToken}`,
            'amz-sdk-invocation-id': uuidv4()
        };
        log.curl('POST', baseUrl, requestHeaders, requestData);

        let stream = null;
        try {
            const response = await this.axiosInstance.post(baseUrl, requestData, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'amz-sdk-invocation-id': uuidv4()
                },
                responseType: 'stream'
            });

            stream = response.data;
            let buffer = '';
            let lastContent = null;
            let currentToolCall = null;
            const toolCalls = [];

            for await (const chunk of stream) {
                buffer += chunk.toString();

                const { events, remaining } = this._parseEventStreamBuffer(buffer);
                buffer = remaining;

                for (const event of events) {
                    if (event.type === 'content' && event.data) {
                        // 过滤重复内容
                        if (lastContent === event.data) continue;
                        lastContent = event.data;
                        yield { type: 'content', content: event.data };
                    } else if (event.type === 'toolUse') {
                        const tc = event.data;
                        if (tc.name && tc.toolUseId) {
                            if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
                                currentToolCall.input += tc.input || '';
                            } else {
                                if (currentToolCall) {
                                    this._finalizeToolCall(currentToolCall, toolCalls);
                                }
                                currentToolCall = {
                                    toolUseId: tc.toolUseId,
                                    name: tc.name,
                                    input: tc.input || ''
                                };
                            }
                            if (tc.stop) {
                       this._finalizeToolCall(currentToolCall, toolCalls);
                                yield { type: 'toolUse', toolUse: currentToolCall };
                                currentToolCall = null;
                            }
                        }
                    } else if (event.type === 'toolUseInput') {
                        if (currentToolCall) {
                            currentToolCall.input += event.data.input || '';
                        }
                    } else if (event.type === 'toolUseStop') {
                        if (currentToolCall && event.data.stop) {
                            this._finalizeToolCall(currentToolCall, toolCalls);
                            yield { type: 'toolUse', toolUse: currentToolCall };
                            currentToolCall = null;
                        }
                    }
                }
            }

            // 处理未完成的工具调用
            if (currentToolCall) {
                this._finalizeToolCall(currentToolCall, toolCalls);
                yield { type: 'toolUse', toolUse: currentToolCall };
            }
        } catch (error) {
            // 确保出错时关闭流
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }

            const status = error.response?.status;

            // 403 错误 - 尝试刷新 Token 后重试（仅当未跳过刷新时）
            if (status === 403 && !options.skipTokenRefresh && retryCount === 0) {
                log.warn('流式请求收到 403，尝试刷新 Token 后重试...');
                const refreshed = await this.refreshAccessToken();
                if (refreshed) {
                    yield* this.chatStream(messages, model, options, retryCount + 1);
                    return;
                }
            }

            // 429 Too Many Requests - 指数退避重试
            if (status === 429 && retryCount < this.maxRetries) {
                const delay = this.baseDelay * Math.pow(2, retryCount);
                log.warn(`流式请求收到 429，${delay}ms 后重试... (${retryCount + 1}/${this.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.chatStream(messages, model, options, retryCount + 1);
                return;
            }

            // 5xx 服务器错误 - 重试
            if (status >= 500 && status < 600 && retryCount < this.maxRetries) {
                const delay = this.baseDelay * Math.pow(2, retryCount);
                log.warn(`流式请求收到 ${status}，${delay}ms 后重试... (${retryCount + 1}/${this.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.chatStream(messages, model, options, retryCount + 1);
                return;
            }

            // 返回自定义错误消息，屏蔽原始 AWS 错误详情
            const customMessage = this._getCustomErrorMessage(error);
            const customError = new Error(customMessage);
            customError.status = status;
            throw customError;
        } finally {
            // 确保流被关闭
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
        }
    }

    /**
     * 简化的流式聊天 - 只返回文本内容（向后兼容）
     */
    async *chatStreamText(messages, model = KIRO_CONSTANTS.DEFAULT_MODEL_NAME, options = {}) {
        for await (const event of this.chatStream(messages, model, options)) {
            if (event.type === 'content') {
                yield event.content;
            }
        }
    }

    /**
     * 获取支持的模型列表
     */
    getModels() {
        return KIRO_MODELS;
    }

    /**
     * 从 API 获取可用模型列表
     */
    async listAvailableModels() {
        const url = buildCodeWhispererUrl(KIRO_CONSTANTS.LIST_MODELS_URL, this.region);

        const requestHeaders = {
            ...this.axiosInstance.defaults.headers,
            'Authorization': `Bearer ${this.accessToken}`,
            'amz-sdk-invocation-id': uuidv4()
        };
        const fullUrl = `${url}?origin=${KIRO_CONSTANTS.ORIGIN_AI_EDITOR}`;
        log.curl('GET', fullUrl, requestHeaders, null);

        const response = await this._callWithRetry(async () => {
            return await this.axiosInstance.get(url, {
                params: { origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR },
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'amz-sdk-invocation-id': uuidv4()
                }
            });
        });

        return response.data;
    }

    /**
     * 获取使用限额
     */
    async getUsageLimits() {
        const url = buildCodeWhispererUrl(KIRO_CONSTANTS.USAGE_LIMITS_URL, this.region);

        // 构建查询参数（参考 AIClient-2-API）
        const params = new URLSearchParams({
            isEmailRequired: 'true',
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
            resourceType: 'AGENTIC_REQUEST'
        });

        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && this.profileArn) {
            params.append('profileArn', this.profileArn);
        }

        const requestHeaders = {
            ...this.axiosInstance.defaults.headers,
            'Authorization': `Bearer ${this.accessToken}`,
            'amz-sdk-invocation-id': uuidv4()
        };
        const fullUrl = `${url}?${params.toString()}`;
        log.curl('GET', fullUrl, requestHeaders, null);

        const response = await this._callWithRetry(async () => {
            return await this.axiosInstance.get(fullUrl, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'amz-sdk-invocation-id': uuidv4()
                }
            });
        });

        return response.data;
    }
}

export default KiroClient;
