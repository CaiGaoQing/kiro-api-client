/**
 * Kiro API 统一服务
 * 提供统一的 Token 刷新、聊天、获取用量等方法
 */
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import crypto from 'crypto';
import { KIRO_CONSTANTS, MODEL_MAPPING, KIRO_MODELS, buildCodeWhispererUrl } from '../constants.js';
import { logger } from '../logger.js';
import { getAxiosProxyConfig } from '../proxy.js';

const log = logger.api;

/**
 * 根据凭证生成唯一的机器码
 */
function generateMachineId(credential) {
    const uniqueKey = credential.profileArn || credential.clientId || 'KIRO_DEFAULT';
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
 * 创建 axios 实例
 */
function createAxiosInstance(credential) {
    const machineId = generateMachineId(credential);
    const { osName, nodeVersion } = getSystemInfo();
    const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;
    const proxyConfig = getAxiosProxyConfig();

    return axios.create({
        timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
        ...proxyConfig,
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
 * 统一的 Kiro API 服务类
 */
export class KiroAPI {
    /**
     * 统一刷新 Token
     * @param {Object} credential - 凭据对象
     * @param {string} credential.refreshToken - 刷新令牌
     * @param {string} credential.authMethod - 认证方式 (social/builder-id/IdC)
     * @param {string} credential.region - 区域
     * @param {string} credential.clientId - 客户端ID (builder-id/IdC 需要)
     * @param {string} credential.clientSecret - 客户端密钥 (builder-id/IdC 需要)
     * @returns {Promise<Object>} 刷新结果 {success, accessToken, refreshToken, expiresAt, error}
     */
    static async refreshToken(credential) {
        const {
            refreshToken,
            authMethod = KIRO_CONSTANTS.AUTH_METHOD_SOCIAL,
            region = KIRO_CONSTANTS.DEFAULT_REGION,
            clientId,
            clientSecret
        } = credential;

        if (!refreshToken) {
            return { success: false, error: '缺少 refreshToken' };
        }

        log.info(`刷新 Token, 认证方式: ${authMethod}`);

        try {
            let response;
            let newAccessToken, newRefreshToken, expiresAt;

            if (authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
                // Social 认证方式 (Google/GitHub)
                const url = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', region);
                const requestBody = { refreshToken };
                const requestHeaders = { 'Content-Type': 'application/json' };
                log.request('POST', url);
                log.curl('POST', url, requestHeaders, requestBody);
                const proxyConfig = getAxiosProxyConfig();

                response = await axios.post(url, requestBody, {
                    headers: requestHeaders,
                    timeout: 30000,
                    ...proxyConfig
                });

                newAccessToken = response.data.accessToken;
                newRefreshToken = response.data.refreshToken || refreshToken;
                expiresAt = response.data.expiresAt || null;

            } else if (authMethod === KIRO_CONSTANTS.AUTH_METHOD_BUILDER_ID || authMethod === KIRO_CONSTANTS.AUTH_METHOD_IDC) {
                // Builder ID / IdC 认证方式 (OIDC)
                if (!clientId || !clientSecret) {
                    log.error(`${authMethod} 缺少必要参数: clientId=${clientId ? '有值' : '空'}, clientSecret=${clientSecret ? '有值' : '空'}`);
                    return { success: false, error: `${authMethod} 认证需要 clientId 和 clientSecret` };
                }

                // IdC 和 builder-id 都使用 oidc 端点 (与 kiro2api 保持一致)
                const url = KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', region);
                log.request('POST', url);

                // 调试日志：打印请求参数（脱敏）
                log.info(`刷新参数: clientId=${clientId.substring(0, 10)}..., clientSecret=${clientSecret.substring(0, 10)}..., refreshToken=${refreshToken.substring(0, 20)}...`);

                // 使用 JSON 格式发送请求（与 AIClient 一致）
                const requestBody = {
                    refreshToken: refreshToken,
                    clientId: clientId,
                    clientSecret: clientSecret,
                    grantType: 'refresh_token'
                };
                const requestHeaders = { 'Content-Type': 'application/json' };
                log.curl('POST', url, requestHeaders, requestBody);

                response = await axios.post(url, requestBody, {
                    headers: requestHeaders,
                    timeout: 30000,
                    ...getAxiosProxyConfig()
                });

                // 响应字段使用 camelCase（与 social 认证一致）
                newAccessToken = response.data.accessToken || response.data.access_token;
                newRefreshToken = response.data.refreshToken || response.data.refresh_token || refreshToken;
                expiresAt = response.data.expiresAt
                    || (response.data.expiresIn
                        ? new Date(Date.now() + response.data.expiresIn * 1000).toISOString()
                        : null)
                    || (response.data.expires_in
                        ? new Date(Date.now() + response.data.expires_in * 1000).toISOString()
                        : null);

            } else {
                return { success: false, error: `不支持的认证方式: ${authMethod}` };
            }

            log.success('Token 刷新成功');
            log.info(`新 Token: ${newAccessToken.substring(0, 20)}...`);
            log.info(`过期时间: ${expiresAt || '未知'}`);

            return {
                success: true,
                accessToken: newAccessToken,
                refreshToken: newRefreshToken,
                expiresAt
            };

        } catch (error) {
            // 打印完整的错误响应用于调试
            if (error.response?.data) {
                log.error(`AWS 响应详情: ${JSON.stringify(error.response.data)}`);
            }

            const errorMsg = error.response?.data?.message
                || error.response?.data?.error_description
                || error.response?.data?.error
                || error.message;
            const statusCode = error.response?.status;

            log.fail(`Token 刷新失败: ${errorMsg}`, statusCode);

            return {
                success: false,
                error: errorMsg,
                statusCode
            };
        }
    }

    /**
     * 批量刷新 Token
     * @param {Array} credentials - 凭据数组
     * @param {Object} options - 选项
     * @param {number} options.delay - 每个请求之间的延迟毫秒 (默认 2000)
     * @param {Function} options.onProgress - 进度回调 (index, total, result)
     * @returns {Promise<Object>} 批量刷新结果 {success, failed, results}
     */
    static async batchRefreshToken(credentials, options = {}) {
        const { delay = 2000, onProgress } = options;
        const results = {
            success: 0,
            failed: 0,
            results: []
        };

        for (let i = 0; i < credentials.length; i++) {
            const credential = credentials[i];
            const result = await this.refreshToken(credential);

            results.results.push({
                id: credential.id,
                name: credential.name,
                ...result
            });

            if (result.success) {
                results.success++;
            } else {
                results.failed++;
            }

            if (onProgress) {
                onProgress(i + 1, credentials.length, result);
            }

            // 延迟，避免请求过快
            if (i < credentials.length - 1 && delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        return results;
    }

    /**
     * 检查 Token 是否即将过期
     * @param {string} expiresAt - 过期时间 ISO 字符串
     * @param {number} minutes - 提前多少分钟判定为即将过期 (默认 10)
     * @returns {boolean}
     */
    static isTokenExpiringSoon(expiresAt, minutes = 10) {
        if (!expiresAt) return false;
        try {
            const expirationTime = new Date(expiresAt);
            const thresholdTime = new Date(Date.now() + minutes * 60 * 1000);
            return expirationTime.getTime() <= thresholdTime.getTime();
        } catch {
            return false;
        }
    }

    /**
     * 获取刷新 Token 的端点 URL
     * @param {string} authMethod - 认证方式
     * @param {string} region - 区域
     * @returns {string}
     */
    static getRefreshEndpoint(authMethod, region = KIRO_CONSTANTS.DEFAULT_REGION) {
        switch (authMethod) {
            case KIRO_CONSTANTS.AUTH_METHOD_SOCIAL:
                return KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', region);
            case KIRO_CONSTANTS.AUTH_METHOD_IDC:
                return KIRO_CONSTANTS.REFRESH_SSO_OIDC_URL.replace('{{region}}', region);
            case KIRO_CONSTANTS.AUTH_METHOD_BUILDER_ID:
            default:
                return KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', region);
        }
    }

    /**
     * 获取认证方式的显示名称
     * @param {string} authMethod - 认证方式
     * @returns {string}
     */
    static getAuthMethodName(authMethod) {
        switch (authMethod) {
            case KIRO_CONSTANTS.AUTH_METHOD_SOCIAL:
                return 'Social (Google/GitHub)';
            case KIRO_CONSTANTS.AUTH_METHOD_BUILDER_ID:
                return 'AWS Builder ID';
            case KIRO_CONSTANTS.AUTH_METHOD_IDC:
                return 'AWS IAM Identity Center';
            default:
                return authMethod;
        }
    }

    // ==================== 对话相关方法 ====================

    /**
     * 获取消息文本内容
     * @private
     */
    static _getContentText(message) {
        if (!message) return '';
        if (typeof message === 'string') return message;
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) {
            return message.content
                .filter(part => part.type === 'text' && part.text)
                .map(part => part.text)
                .join('');
        }
        return String(message.content || message);
    }

    /**
     * 合并相邻相同 role 的消息
     * @private
     */
    static _mergeAdjacentMessages(messages) {
        const merged = [];
        for (const msg of messages) {
            if (merged.length === 0) {
                merged.push({ ...msg });
            } else {
                const last = merged[merged.length - 1];
                if (msg.role === last.role) {
                    const lastContent = this._getContentText(last);
                    const currentContent = this._getContentText(msg);
                    last.content = `${lastContent}\n${currentContent}`;
                } else {
                    merged.push({ ...msg });
                }
            }
        }
        return merged;
    }

    /**
     * 构建聊天请求体
     * @private
     */
    static _buildChatRequest(messages, model, credential, options = {}) {
        const conversationId = uuidv4();
        const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[KIRO_CONSTANTS.DEFAULT_MODEL_NAME] || model;

        // 合并相邻相同 role 的消息
        const mergedMessages = this._mergeAdjacentMessages(messages);

        // 处理消息历史
        const history = [];
        const processedMessages = [...mergedMessages];

        // 处理 system prompt
        let systemPrompt = options.system || '';

        if (systemPrompt && processedMessages.length > 0 && processedMessages[0].role === 'user') {
            const firstContent = this._getContentText(processedMessages[0]);
            history.push({
                userInputMessage: {
                    content: `${systemPrompt}\n\n${firstContent}`,
                    modelId: codewhispererModel,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                }
            });
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
                history.push({
                    userInputMessage: {
                        content: this._getContentText(msg),
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                    }
                });
            } else if (msg.role === 'assistant') {
                history.push({
                    assistantResponseMessage: {
                        content: this._getContentText(msg)
                    }
                });
            }
        }

        // 当前消息
        const currentMsg = processedMessages[processedMessages.length - 1];
        let currentContent = '';

        if (currentMsg && currentMsg.role === 'assistant') {
            history.push({
                assistantResponseMessage: {
                    content: this._getContentText(currentMsg)
                }
            });
            currentContent = 'Continue';
        } else {
            currentContent = this._getContentText(currentMsg) || 'Continue';

            if (history.length > 0 && !history[history.length - 1].assistantResponseMessage) {
                history.push({
                    assistantResponseMessage: { content: 'Continue' }
                });
            }
        }

        const request = {
            conversationState: {
                chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
                conversationId,
                currentMessage: {
                    userInputMessage: {
                        content: currentContent,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                    }
                }
            }
        };

        if (history.length > 0) {
            request.conversationState.history = history;
        }

        if (credential.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && credential.profileArn) {
            request.profileArn = credential.profileArn;
        }

        return request;
    }

    /**
     * 解析 AWS Event Stream 缓冲区
     * @private
     */
    static _parseEventStreamBuffer(buffer) {
        const events = [];
        let remaining = buffer;
        let searchStart = 0;

        while (true) {
            const contentStart = remaining.indexOf('{"content":', searchStart);
            const followupStart = remaining.indexOf('{"followupPrompt":', searchStart);

            const candidates = [contentStart, followupStart].filter(pos => pos >= 0);
            if (candidates.length === 0) break;

            const jsonStart = Math.min(...candidates);
            if (jsonStart < 0) break;

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
                if (parsed.content !== undefined && !parsed.followupPrompt) {
                    events.push({ type: 'content', data: parsed.content });
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
     * 解析响应（非流式）
     * @private
     */
    static _parseResponse(rawData) {
        const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        let fullContent = '';

        const { events } = this._parseEventStreamBuffer(rawStr);
        for (const event of events) {
            if (event.type === 'content') {
                fullContent += event.data;
            }
        }

        return fullContent;
    }

    /**
     * 检查是否为可重试的 ValidationException
     * @private
     */
    static _isRetryableValidationException(error) {
        const errorType = error.response?.headers?.['x-amzn-errortype'] || '';
        const responseData = error.response?.data;
        return errorType.includes('ValidationException') ||
            (typeof responseData === 'string' && responseData.includes('ValidationException')) ||
            (responseData?.error?.message?.includes('ValidationException'));
    }

    /**
     * 带重试的 API 调用
     * @private
     */
    static async _callWithRetry(requestFn, maxRetries = 3, baseDelay = 1000, retryCount = 0) {
        try {
            return await requestFn();
        } catch (error) {
            const status = error.response?.status;

            if (status === 429 && retryCount < maxRetries) {
              const delay = baseDelay * Math.pow(2, retryCount);
                log.warn(`收到 429，${delay}ms 后重试... (${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._callWithRetry(requestFn, maxRetries, baseDelay, retryCount + 1);
            }

            // 400 ValidationException - 重试（AWS 临时性验证错误）
            if (status === 400 && retryCount < maxRetries && this._isRetryableValidationException(error)) {
                const delay = baseDelay * Math.pow(2, retryCount);
                log.warn(`收到 400 ValidationException，${delay}ms 后重试... (${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._callWithRetry(requestFn, maxRetries, baseDelay, retryCount + 1);
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                log.warn(`收到 ${status}，${delay}ms 后重试... (${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._callWithRetry(requestFn, maxRetries, baseDelay, retryCount + 1);
            }

            // 转换为自定义错误，屏蔽原始 AWS 错误详情
            const customError = new Error(this._getCustomErrorMessage(error));
            customError.status = status;
            customError.isRetryable = status === 429 || status >= 500 || (status === 400 && this._isRetryableValidationException(error));
            throw customError;
        }
    }

    /**
     * 获取自定义错误消息，屏蔽原始 AWS 错误详情
     * @private
     */
    static _getCustomErrorMessage(error) {
        const status = error.response?.status;

        // 记录原始错误到日志
        const originalError = error.response?.data?.message || error.response?.data?.error?.message || error.message;
        log.error(`原始错误: ${status} - ${originalError}`);

        // 返回自定义错误消息
        if (status === 400) {
            if (this._isRetryableValidationException(error)) {
                return '服务暂时不可用，请稍后重试';
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
     * 统一聊天接口（非流式）
     * @param {Object} credential - 凭据对象
     * @param {string} credential.accessToken - 访问令牌
     * @param {string} credential.profileArn - Profile ARN (social 认证需要)
     * @param {string} credential.authMethod - 认证方式
     * @param {string} credential.region - 区域
     * @param {Array} messages - 消息数组 [{role: 'user'|'assistant', content: string}]
     * @param {string} model - 模型名称
     * @param {Object} options - 选项
     * @param {string} options.system - 系统提示词
     * @param {number} options.maxRetries - 最大重试次数
     * @returns {Promise<Object>} {success, content, error}
     */
    static async chat(credential, messages, model = KIRO_CONSTANTS.DEFAULT_MODEL_NAME, options = {}) {
        const { accessToken, region = KIRO_CONSTANTS.DEFAULT_REGION } = credential;

        if (!accessToken) {
            return { success: false, error: '缺少 accessToken' };
        }

        const axiosInstance = createAxiosInstance(credential);
        const requestData = this._buildChatRequest(messages, model, credential, options);
        const baseUrl = buildCodeWhispererUrl(KIRO_CONSTANTS.BASE_URL, region);

        const requestHeaders = {
            ...axiosInstance.defaults.headers,
            'Authorization': `Bearer ${accessToken}`,
            'amz-sdk-invocation-id': uuidv4()
        };
        log.curl('POST', baseUrl, requestHeaders, requestData);

        try {
            const response = await this._callWithRetry(async () => {
                return await axiosInstance.post(baseUrl, requestData, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'amz-sdk-invocation-id': uuidv4()
                    }
                });
            }, options.maxRetries || 3);

            const content = this._parseResponse(response.data);
            return { success: true, content };

        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            log.fail(`聊天请求失败: ${errorMsg}`, error.response?.status);
            return {
                success: false,
                error: errorMsg,
                statusCode: error.response?.status
            };
        }
    }

    /**
     * 统一聊天接口（流式）
     * @param {Object} credential - 凭据对象
     * @param {Array} messages - 消息数组
     * @param {string} model - 模型名称
     * @param {Object} options - 选项
     * @yields {string} 流式内容片段
     */
    static async *chatStream(credential, messages, model = KIRO_CONSTANTS.DEFAULT_MODEL_NAME, options = {}) {
        const { accessToken, region = KIRO_CONSTANTS.DEFAULT_REGION } = credential;

        if (!accessToken) {
            throw new Error('缺少 accessToken');
        }

        const axiosInstance = createAxiosInstance(credential);
        const requestData = this._buildChatRequest(messages, model, credential, options);
        const baseUrl = buildCodeWhispererUrl(KIRO_CONSTANTS.BASE_URL, region);

        const requestHeaders = {
            ...axiosInstance.defaults.headers,
            'Authorization': `Bearer ${accessToken}`,
            'amz-sdk-invocation-id': uuidv4()
        };
        log.curl('POST', baseUrl, requestHeaders, requestData);

        const response = await this._callWithRetry(async () => {
            return await axiosInstance.post(baseUrl, requestData, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'amz-sdk-invocation-id': uuidv4()
                },
                responseType: 'stream'
            });
        }, options.maxRetries || 3);

        let buffer = '';
        let lastContent = null;

        for await (const chunk of response.data) {
            buffer += chunk.toString();

            const { events, remaining } = this._parseEventStreamBuffer(buffer);
            buffer = remaining;

            for (const event of events) {
                if (event.type === 'content' && event.data) {
                    if (lastContent === event.data) continue;
                    lastContent = event.data;
                    yield event.data;
                }
            }
        }
    }

    // ==================== 用量和模型相关方法 ====================

    /**
     * 获取使用限额
     * @param {Object} credential - 凭据对象
     * @returns {Promise<Object>} {success, data, error}
     */
    static async getUsageLimits(credential) {
        const { accessToken, profileArn, authMethod, region = KIRO_CONSTANTS.DEFAULT_REGION } = credential;

        if (!accessToken) {
            return { success: false, error: '缺少 accessToken' };
        }

        const axiosInstance = createAxiosInstance(credential);
        const url = buildCodeWhispererUrl(KIRO_CONSTANTS.USAGE_LIMITS_URL, region);

        const params = new URLSearchParams({
            isEmailRequired: 'true',
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
            resourceType: 'AGENTIC_REQUEST'
        });

        if (authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && profileArn) {
            params.append('profileArn', profileArn);
        }

        try {
            const fullUrl = `${url}?${params.toString()}`;
            const requestHeaders = {
                ...axiosInstance.defaults.headers,
                'Authorization': `Bearer ${accessToken}`,
                'amz-sdk-invocation-id': uuidv4()
            };
            log.curl('GET', fullUrl, requestHeaders, null);

            const response = await this._callWithRetry(async () => {
                return await axiosInstance.get(fullUrl, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'amz-sdk-invocation-id': uuidv4()
                    }
                });
            });

            return { success: true, data: response.data };

        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            log.fail(`获取用量失败: ${errorMsg}`, error.response?.status);
            return {
                success: false,
                error: errorMsg,
                statusCode: error.response?.status
            };
        }
    }

    /**
     * 获取可用模型列表
     * @param {Object} credential - 凭据对象
     * @returns {Promise<Object>} {success, data, error}
     */
    static async listModels(credential) {
        const { accessToken, region = KIRO_CONSTANTS.DEFAULT_REGION } = credential;

        if (!accessToken) {
            return { success: false, error: '缺少 accessToken' };
        }

        const axiosInstance = createAxiosInstance(credential);
        const url = buildCodeWhispererUrl(KIRO_CONSTANTS.LIST_MODELS_URL, region);

        try {
            const fullUrl = `${url}?origin=${KIRO_CONSTANTS.ORIGIN_AI_EDITOR}`;
            const requestHeaders = {
                ...axiosInstance.defaults.headers,
                'Authorization': `Bearer ${accessToken}`,
                'amz-sdk-invocation-id': uuidv4()
            };
            log.curl('GET', fullUrl, requestHeaders, null);

            const response = await this._callWithRetry(async () => {
                return await axiosInstance.get(url, {
                    params: { origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR },
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'amz-sdk-invocation-id': uuidv4()
                    }
                });
            });

            return { success: true, data: response.data };

        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            log.fail(`获取模型列表失败: ${errorMsg}`, error.response?.status);
            return {
                success: false,
                error: errorMsg,
                statusCode: error.response?.status
            };
        }
    }

    /**
     * 获取本地支持的模型列表
     * @returns {Array}
     */
    static getLocalModels() {
        return KIRO_MODELS;
    }

    /**
     * 获取模型映射表
     * @returns {Object}
     */
    static getModelMapping() {
        return MODEL_MAPPING;
    }
}

export default KiroAPI;
