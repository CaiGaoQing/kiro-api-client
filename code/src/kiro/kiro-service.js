/**
 * Kiro API Service - 参考 AIClient-2-API 的实现
 */
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { KIRO_CONSTANTS, MODEL_MAPPING, KIRO_MODELS, buildCodeWhispererUrl } from '../constants.js';
import { getAxiosProxyConfig } from '../proxy.js';
import { logger } from '../logger.js';

const log = logger.client;

function generateMachineId(credential) {
    const uniqueKey = credential.profileArn || credential.clientId || 'KIRO_DEFAULT';
    return crypto.createHash('sha256').update(uniqueKey).digest('hex');
}

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

export class KiroService {
    constructor(credential) {
        this.credential = credential;
        this.accessToken = credential.accessToken;
        this.refreshToken = credential.refreshToken;
        this.profileArn = credential.profileArn;
        this.clientId = credential.clientId;
        this.clientSecret = credential.clientSecret;
        this.authMethod = credential.authMethod || KIRO_CONSTANTS.AUTH_METHOD_SOCIAL;
        this.region = credential.region || KIRO_CONSTANTS.DEFAULT_REGION;
        this.expiresAt = credential.expiresAt;

        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
        });

        const machineId = generateMachineId(credential);
        const { osName, nodeVersion } = getSystemInfo();
        const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;

        const axiosConfig = {
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
            httpAgent,
            httpsAgent,
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
                'amz-sdk-request': 'attempt=1; max=1',
                'x-amzn-kiro-agent-mode': 'spec',
                'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroVersion}-${machineId}`,
                'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroVersion}-${machineId}`,
                'Connection': 'close'
            },
        };

        const proxyConfig = getAxiosProxyConfig();
        if (proxyConfig.proxy === false) {
            axiosConfig.proxy = false;
        } else if (proxyConfig.httpsAgent) {
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        }

        this.axiosInstance = axios.create(axiosConfig);
        this.baseUrl = buildCodeWhispererUrl(KIRO_CONSTANTS.BASE_URL, this.region);
    }

    getContentText(message) {
        if (!message) return '';
        if (typeof message === 'string') return message;
        if (Array.isArray(message)) {
            return message.filter(part => part.type === 'text' && part.text).map(part => part.text).join('');
        }
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) {
            return message.content.filter(part => part.type === 'text' && part.text).map(part => part.text).join('');
        }
        return String(message.content || message);
    }

    buildRequest(messages, model, options = {}) {
        const conversationId = uuidv4();
        const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[KIRO_CONSTANTS.DEFAULT_MODEL_NAME] || model;

        let systemPrompt = '';
        if (options.system) {
            if (typeof options.system === 'string') {
                systemPrompt = options.system;
            } else if (Array.isArray(options.system)) {
                systemPrompt = options.system.map(item => typeof item === 'string' ? item : item.text).join('\n');
            }
        }

        // 合并相邻相同 role 的消息
        const mergedMessages = [];
        for (const msg of messages) {
            if (mergedMessages.length === 0) {
                mergedMessages.push({ ...msg });
            } else {
                const lastMsg = mergedMessages[mergedMessages.length - 1];
                if (msg.role === lastMsg.role) {
                    if (Array.isArray(lastMsg.content) && Array.isArray(msg.content)) {
                        lastMsg.content.push(...msg.content);
                    } else if (typeof lastMsg.content === 'string' && typeof msg.content === 'string') {
                        lastMsg.content += '\n' + msg.content;
                    } else {
                        mergedMessages.push({ ...msg });
                    }
                } else {
                    mergedMessages.push({ ...msg });
                }
            }
        }

        let toolsContext = {};
        if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
            // 过滤掉 Bash 工具
            const filteredTools = options.tools.filter(tool => tool.name !== 'Bash');
            if (filteredTools.length > 0) {
                toolsContext = {
                    tools: filteredTools.map(tool => ({
                        toolSpecification: {
                            name: tool.name,
                            description: tool.description || "",
                            inputSchema: { json: tool.input_schema || {} }
                        }
                    }))
                };
            }
        }

        const history = [];
        let startIndex = 0;

        if (systemPrompt) {
            if (mergedMessages[0]?.role === 'user') {
                const firstUserContent = this.getContentText(mergedMessages[0]);
                history.push({
                    userInputMessage: {
                        content: `${systemPrompt}\n\n${firstUserContent}`,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
                startIndex = 1;
            } else {
                history.push({
                    userInputMessage: {
                        content: systemPrompt,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
            }
        }

        for (let i = startIndex; i < mergedMessages.length - 1; i++) {
            const message = mergedMessages[i];
            if (message.role === 'user') {
                history.push({ userInputMessage: this._buildUserInputMessage(message, codewhispererModel) });
            } else if (message.role === 'assistant') {
                history.push({ assistantResponseMessage: this._buildAssistantResponseMessage(message) });
            }
        }

        let currentMessage = mergedMessages[mergedMessages.length - 1];
        let currentContent = '';
        let currentToolResults = [];
        let currentImages = [];

        if (currentMessage?.role === 'assistant') {
            history.push({ assistantResponseMessage: this._buildAssistantResponseMessage(currentMessage) });
            currentContent = 'Continue';
        } else if (currentMessage) {
            if (history.length > 0 && !history[history.length - 1].assistantResponseMessage) {
                history.push({ assistantResponseMessage: { content: 'Continue' } });
            }

            if (Array.isArray(currentMessage.content)) {
                for (const part of currentMessage.content) {
                    if (part.type === 'text') {
                        currentContent += part.text;
                    } else if (part.type === 'tool_result') {
                        currentToolResults.push({
                            content: [{ text: this.getContentText(part.content) }],
                            status: part.is_error ? 'error' : 'success',
                            toolUseId: part.tool_use_id
                        });
                    } else if (part.type === 'image') {
                        currentImages.push({
                            format: part.source.media_type.split('/')[1],
                            source: { bytes: part.source.data }
                        });
                    }
                }
            } else {
                currentContent = this.getContentText(currentMessage);
            }

            if (!currentContent) {
                currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
            }
        } else {
            currentContent = 'Continue';
        }

        const userInputMessage = {
            content: currentContent,
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        };

        if (currentImages.length > 0) {
            userInputMessage.images = currentImages;
        }

        const userInputMessageContext = {};
        if (currentToolResults.length > 0) {
            const uniqueToolResults = [];
            const seenIds = new Set();
            for (const tr of currentToolResults) {
                if (!seenIds.has(tr.toolUseId)) {
                    seenIds.add(tr.toolUseId);
                    uniqueToolResults.push(tr);
                }
            }
            userInputMessageContext.toolResults = uniqueToolResults;
        }
        if (toolsContext.tools) {
            userInputMessageContext.tools = toolsContext.tools;
        }

        if (Object.keys(userInputMessageContext).length > 0) {
            userInputMessage.userInputMessageContext = userInputMessageContext;
        }

        const request = {
            conversationState: {
                chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
                conversationId,
                currentMessage: { userInputMessage }
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

    _buildUserInputMessage(msg, codewhispererModel) {
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
                        content: [{ text: this.getContentText(part.content) }],
                        status: part.is_error ? 'error' : 'success',
                        toolUseId: part.tool_use_id
                    });
                } else if (part.type === 'image') {
                    images.push({
                        format: part.source.media_type.split('/')[1],
                        source: { bytes: part.source.data }
                    });
                }
            }
        } else {
            userInputMessage.content = this.getContentText(msg);
        }

        if (!userInputMessage.content) {
            userInputMessage.content = toolResults.length > 0 ? 'Tool results provided.' : 'Continue';
        }

        if (images.length > 0) {
            userInputMessage.images = images;
        }
        if (toolResults.length > 0) {
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

    _buildAssistantResponseMessage(msg) {
        const assistantResponseMessage = { content: '' };
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
            assistantResponseMessage.content = this.getContentText(msg);
        }

        if (toolUses.length > 0) {
            assistantResponseMessage.toolUses = toolUses;
        }

        return assistantResponseMessage;
    }

    parseEventStreamBuffer(buffer) {
        const events = [];
        let remaining = buffer;
        let searchStart = 0;

        while (true) {
            const contentStart = remaining.indexOf('{"content":', searchStart);
            const nameStart = remaining.indexOf('{"name":', searchStart);
            const followupStart = remaining.indexOf('{"followupPrompt":', searchStart);
            const inputStart = remaining.indexOf('{"input":', searchStart);
            const stopStart = remaining.indexOf('{"stop":', searchStart);

            const candidates = [contentStart, nameStart, followupStart, inputStart, stopStart].filter(pos => pos >= 0);
            if (candidates.length === 0) break;

            const jsonStart = Math.min(...candidates);
            if (jsonStart < 0) break;

            let braceCount = 0;
            let jsonEnd = -1;
            let inString = false;
            let escapeNext = false;

            for (let i = jsonStart; i < remaining.length; i++) {
                const char = remaining[i];
                if (escapeNext) { escapeNext = false; continue; }
                if (char === '\\') { escapeNext = true; continue; }
                if (char === '"') { inString = !inString; continue; }
                if (!inString) {
                    if (char === '{') braceCount++;
                    else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0) { jsonEnd = i; break; }
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
                } else if (parsed.name && parsed.toolUseId) {
                    events.push({
                        type: 'toolUse',
                        data: { name: parsed.name, toolUseId: parsed.toolUseId, input: parsed.input || '', stop: parsed.stop || false }
                    });
                } else if (parsed.input !== undefined && !parsed.name) {
                    events.push({ type: 'toolUseInput', data: { input: parsed.input } });
                } else if (parsed.stop !== undefined) {
                    events.push({ type: 'toolUseStop', data: { stop: parsed.stop } });
                }
            } catch (e) { }

            searchStart = jsonEnd + 1;
            if (searchStart >= remaining.length) { remaining = ''; break; }
        }

        if (searchStart > 0 && remaining.length > 0) {
            remaining = remaining.substring(searchStart);
        }

        return { events, remaining };
    }

    async *generateContentStream(model, requestBody) {
        const requestData = this.buildRequest(requestBody.messages, model, {
            system: requestBody.system,
            tools: requestBody.tools
        });

        const headers = {
            ...this.axiosInstance.defaults.headers.common,
            'Authorization': `Bearer ${this.accessToken}`,
            'amz-sdk-invocation-id': uuidv4(),
        };
        log.curl('POST', this.baseUrl, headers, requestData);

        let stream = null;
        let retryCount = 0;
        const maxRetries = 3;
        const baseDelay = 1000;

        while (retryCount <= maxRetries) {
            try {
                const response = await this.axiosInstance.post(this.baseUrl, requestData, {
                    headers,
                    responseType: 'stream'
                });

                stream = response.data;
                let buffer = '';
                let lastContentEvent = null;
                let currentToolCall = null;

                for await (const chunk of stream) {
                    buffer += chunk.toString();
                    const { events, remaining } = this.parseEventStreamBuffer(buffer);
                    buffer = remaining;

                    for (const event of events) {
                        if (event.type === 'content' && event.data) {
                            if (lastContentEvent === event.data) continue;
                            lastContentEvent = event.data;
                            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: event.data } };
                        } else if (event.type === 'toolUse') {
                            const tc = event.data;
                            if (tc.name && tc.toolUseId) {
                                if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
                                    currentToolCall.input += tc.input || '';
                                } else {
                                    if (currentToolCall) {
                                        yield { type: 'tool_use', toolUse: this._finalizeToolCall(currentToolCall) };
                                    }
                                    currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: tc.input || '' };
                                }
                                if (tc.stop) {
                                    yield { type: 'tool_use', toolUse: this._finalizeToolCall(currentToolCall) };
                                    currentToolCall = null;
                                }
                            }
                        } else if (event.type === 'toolUseInput') {
                            if (currentToolCall) currentToolCall.input += event.data.input || '';
                        } else if (event.type === 'toolUseStop') {
                            if (currentToolCall && event.data.stop) {
                                yield { type: 'tool_use', toolUse: this._finalizeToolCall(currentToolCall) };
                                currentToolCall = null;
                            }
                        }
                    }
                }

                if (currentToolCall) {
                    yield { type: 'tool_use', toolUse: this._finalizeToolCall(currentToolCall) };
                }
                return;

            } catch (error) {
                if (stream && typeof stream.destroy === 'function') stream.destroy();

                const status = error.response?.status;
                if ((status === 429 || (status >= 500 && status < 600)) && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    console.log(`[KiroService] 收到 ${status}，${delay}ms 后重试... (${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    retryCount++;
                    continue;
                }

                let errorMessage = error.message;
                if (error.response) {
                    errorMessage = `Request failed with status code ${status}`;
                    const errorType = error.response.headers?.['x-amzn-errortype'];
                    const requestId = error.response.headers?.['x-amzn-requestid'];
                    if (errorType) errorMessage += ` | ErrorType: ${errorType}`;
                    if (requestId) errorMessage += ` | RequestId: ${requestId}`;
                }

                const enhancedError = new Error(errorMessage);
                enhancedError.status = status;
                throw enhancedError;
            } finally {
                if (stream && typeof stream.destroy === 'function') stream.destroy();
            }
        }
    }

    async generateContent(model, requestBody) {
        const requestData = this.buildRequest(requestBody.messages, model, {
            system: requestBody.system,
            tools: requestBody.tools
        });

        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            'amz-sdk-invocation-id': uuidv4(),
        };

        let retryCount = 0;
        const maxRetries = 3;
        const baseDelay = 1000;

        while (retryCount <= maxRetries) {
            try {
                const response = await this.axiosInstance.post(this.baseUrl, requestData, { headers });
                const rawStr = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data);

                let fullContent = '';
                const toolCalls = [];
                let currentToolCall = null;

                const { events } = this.parseEventStreamBuffer(rawStr);
                for (const event of events) {
                    if (event.type === 'content') {
                        fullContent += event.data;
                    } else if (event.type === 'toolUse') {
                        const tc = event.data;
                        if (tc.name && tc.toolUseId) {
                            if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
                                currentToolCall.input += tc.input || '';
                            } else {
                                if (currentToolCall) toolCalls.push(this._finalizeToolCall(currentToolCall));
                                currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: tc.input || '' };
                            }
                            if (tc.stop) {
                                toolCalls.push(this._finalizeToolCall(currentToolCall));
                                currentToolCall = null;
                            }
                        }
                    } else if (event.type === 'toolUseInput') {
                        if (currentToolCall) currentToolCall.input += event.data.input || '';
                    } else if (event.type === 'toolUseStop') {
                        if (currentToolCall && event.data.stop) {
                            toolCalls.push(this._finalizeToolCall(currentToolCall));
                            currentToolCall = null;
                        }
                    }
                }

                if (currentToolCall) toolCalls.push(this._finalizeToolCall(currentToolCall));
                return { content: fullContent, toolCalls };

            } catch (error) {
                const status = error.response?.status;
                if ((status === 429 || (status >= 500 && status < 600)) && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    console.log(`[KiroService] 收到 ${status}，${delay}ms 后重试... (${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    retryCount++;
                    continue;
                }

                let errorMessage = error.message;
                if (error.response) {
                    errorMessage = `Request failed with status code ${status}`;
                    const errorType = error.response.headers?.['x-amzn-errortype'];
                    const requestId = error.response.headers?.['x-amzn-requestid'];
                    if (errorType) errorMessage += ` | ErrorType: ${errorType}`;
                    if (requestId) errorMessage += ` | RequestId: ${requestId}`;
                }

                const enhancedError = new Error(errorMessage);
                enhancedError.status = status;
                throw enhancedError;
            }
        }
    }

    _finalizeToolCall(toolCall) {
        let input = toolCall.input;
        try { input = JSON.parse(toolCall.input); } catch (e) { }
        return { toolUseId: toolCall.toolUseId, name: toolCall.name, input };
    }

    listModels() {
        return { models: KIRO_MODELS.map(id => ({ name: id })) };
    }
}

export default KiroService;
