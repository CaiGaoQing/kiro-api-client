/**
 * Amazon Bedrock 客户端
 * 通过 AWS Bedrock 访问 Claude 模型
 */
import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../logger.js';
import { getAxiosProxyConfig } from '../proxy.js';
import { BEDROCK_CONSTANTS, BEDROCK_MODEL_MAPPING, BEDROCK_MODELS } from '../constants.js';

const log = logger.api;

/**
 * AWS Signature V4 签名工具
 */
class AwsSignatureV4 {
    constructor(options) {
        this.accessKeyId = options.accessKeyId;
        this.secretAccessKey = options.secretAccessKey;
        this.sessionToken = options.sessionToken;
        this.region = options.region || 'us-east-1';
        this.service = options.service || 'bedrock';
    }

    /**
     * 签名请求
     */
    sign(request) {
        const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
        const date = datetime.slice(0, 8);

        // 准备请求头
        const headers = {
            ...request.headers,
            'host': new URL(request.url).host,
            'x-amz-date': datetime
        };

        // 如果有 session token，添加到请求头
        if (this.sessionToken) {
            headers['x-amz-security-token'] = this.sessionToken;
        }

        // 计算 payload hash
        const payloadHash = this._hash(request.body || '');
        headers['x-amz-content-sha256'] = payloadHash;

        // 创建规范请求
        const canonicalRequest = this._createCanonicalRequest(request.method, request.url, headers, payloadHash);

        // 创建签名字符串
        const credentialScope = `${date}/${this.region}/${this.service}/aws4_request`;
        const stringToSign = this._createStringToSign(datetime, credentialScope, canonicalRequest);

        // 计算签名
        const signingKey = this._getSignatureKey(date);
        const signature = this._hmac(signingKey, stringToSign).toString('hex');

        // 构建授权头
        const signedHeaders = Object.keys(headers)
            .map(k => k.toLowerCase())
            .sort()
            .join(';');

        const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

        return {
            ...headers,
            'Authorization': authorizationHeader
        };
    }

    _createCanonicalRequest(method, url, headers, payloadHash) {
        const parsedUrl = new URL(url);
        const canonicalUri = parsedUrl.pathname || '/';
        const canonicalQuerystring = parsedUrl.searchParams.toString();

        // 规范化头部
        const sortedHeaders = Object.keys(headers)
            .map(k => k.toLowerCase())
            .sort();

        const canonicalHeaders = sortedHeaders
            .map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)].trim()}`)
            .join('\n') + '\n';

        const signedHeaders = sortedHeaders.join(';');

        return [
            method,
            canonicalUri,
            canonicalQuerystring,
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join('\n');
    }

    _createStringToSign(datetime, credentialScope, canonicalRequest) {
        return [
            'AWS4-HMAC-SHA256',
            datetime,
            credentialScope,
            this._hash(canonicalRequest)
        ].join('\n');
    }

    _getSignatureKey(date) {
        const kDate = this._hmac(`AWS4${this.secretAccessKey}`, date);
        const kRegion = this._hmac(kDate, this.region);
        const kService = this._hmac(kRegion, this.service);
        const kSigning = this._hmac(kService, 'aws4_request');
        return kSigning;
    }

    _hash(data) {
        return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
    }

    _hmac(key, data) {
        return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
    }
}

/**
 * Amazon Bedrock 客户端类
 */
export class BedrockClient {
    /**
     * @param {Object} options - 配置选项
     * @param {string} options.accessKeyId - AWS Access Key ID
     * @param {string} options.secretAccessKey - AWS Secret Access Key
     * @param {string} options.sessionToken - AWS Session Token (可选)
     * @param {string} options.region - AWS 区域 (默认 us-east-1)
     */
    constructor(options = {}) {
        if (!options.accessKeyId || !options.secretAccessKey) {
            throw new Error('accessKeyId 和 secretAccessKey 是必需的');
        }

        this.accessKeyId = options.accessKeyId;
        this.secretAccessKey = options.secretAccessKey;
        this.sessionToken = options.sessionToken;
        this.region = options.region || BEDROCK_CONSTANTS.DEFAULT_REGION;

        this.signer = new AwsSignatureV4({
            accessKeyId: this.accessKeyId,
            secretAccessKey: this.secretAccessKey,
            sessionToken: this.sessionToken,
            region: this.region,
            service: 'bedrock'
        });

        this.axiosInstance = axios.create({
            timeout: BEDROCK_CONSTANTS.AXIOS_TIMEOUT,
            ...getAxiosProxyConfig()
        });
    }

    /**
     * 从凭据对象创建客户端
     */
    static fromCredentials(credentials, region) {
        return new BedrockClient({
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
            region: region || credentials.region
        });
    }

    /**
     * 获取 Bedrock Runtime API URL
     */
    _getApiUrl(modelId, stream = false) {
        const bedrockModel = BEDROCK_MODEL_MAPPING[modelId] || modelId;
        const baseUrl = BEDROCK_CONSTANTS.RUNTIME_ENDPOINT.replace('{{region}}', this.region);
        const path = stream
            ? BEDROCK_CONSTANTS.CONVERSE_STREAM_PATH.replace('{{modelId}}', encodeURIComponent(bedrockModel))
            : BEDROCK_CONSTANTS.CONVERSE_PATH.replace('{{modelId}}', encodeURIComponent(bedrockModel));
        return `${baseUrl}${path}`;
    }

    /**
     * 获取支持的模型列表
     */
    getModels() {
        return BEDROCK_MODELS;
    }

    /**
     * 获取模型映射
     */
    getModelMapping() {
        return BEDROCK_MODEL_MAPPING;
    }

    /**
     * 转换 Claude API 格式消息为 Bedrock Converse 格式
     */
    _convertToBedrockMessages(messages) {
        return messages.map(msg => {
            const content = [];

            if (typeof msg.content === 'string') {
                content.push({ text: msg.content });
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        content.push({ text: part.text });
                    } else if (part.type === 'image') {
                        // 处理图片
                        if (part.source?.type === 'base64') {
                            content.push({
                                image: {
                                    format: part.source.media_type?.split('/')[1] || 'png',
                                    source: {
                                        bytes: part.source.data
                                    }
                                }
                            });
                        }
                    } else if (part.type === 'tool_use') {
                        content.push({
                            toolUse: {
                                toolUseId: part.id,
                                name: part.name,
                                input: part.input
                            }
                        });
                    } else if (part.type === 'tool_result') {
                        content.push({
                            toolResult: {
                                toolUseId: part.tool_use_id,
                                content: [{ text: typeof part.content === 'string' ? part.content : JSON.stringify(part.content) }],
                                status: part.is_error ? 'error' : 'success'
                            }
                        });
                    }
                }
            }

            return {
                role: msg.role,
                content
            };
        });
    }

    /**
     * 转换请求为 Bedrock Converse 格式
     */
    _convertRequest(messages, model, options = {}) {
        const bedrockMessages = this._convertToBedrockMessages(messages);

        const request = {
            messages: bedrockMessages
        };

        // 添加系统提示
        if (options.system) {
            const systemText = typeof options.system === 'string'
                ? options.system
                : (Array.isArray(options.system) ? options.system.map(s => s.text || s).join('\n') : String(options.system));
            request.system = [{ text: systemText }];
        }

        // 添加推理配置
        const inferenceConfig = {};
        if (options.max_tokens) {
            inferenceConfig.maxTokens = options.max_tokens;
        }
        if (options.temperature !== undefined) {
            inferenceConfig.temperature = options.temperature;
        }
        if (options.top_p !== undefined) {
            inferenceConfig.topP = options.top_p;
        }
        if (options.stop_sequences) {
            inferenceConfig.stopSequences = options.stop_sequences;
        }
        if (Object.keys(inferenceConfig).length > 0) {
            request.inferenceConfig = inferenceConfig;
        }

        // 添加工具定义
        if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
            request.toolConfig = {
                tools: options.tools.map(tool => ({
                    toolSpec: {
                        name: tool.name,
                        description: tool.description || '',
                        inputSchema: {
                            json: tool.input_schema || { type: 'object', properties: {} }
                        }
                    }
                }))
            };
        }

        return request;
    }

    /**
     * 转换 Bedrock 响应为 Claude API 格式
     */
    _convertResponse(response, model) {
        const messageId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 8);

        const content = [];
        if (response.output?.message?.content) {
            for (const part of response.output.message.content) {
                if (part.text) {
                    content.push({ type: 'text', text: part.text });
                } else if (part.toolUse) {
                    content.push({
                        type: 'tool_use',
                        id: part.toolUse.toolUseId,
                        name: part.toolUse.name,
                        input: part.toolUse.input
                    });
                }
            }
        }

        const inputTokens = response.usage?.inputTokens || 0;
        const outputTokens = response.usage?.outputTokens || 0;

        // 转换停止原因
        let stopReason = 'end_turn';
        if (response.stopReason) {
            if (response.stopReason === 'tool_use') stopReason = 'tool_use';
            else if (response.stopReason === 'max_tokens') stopReason = 'max_tokens';
            else if (response.stopReason === 'stop_sequence') stopReason = 'stop_sequence';
        }

        return {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content,
            model,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens
            }
        };
    }

    /**
     * 发送签名请求
     */
    async _sendSignedRequest(url, body, stream = false) {
        const bodyStr = JSON.stringify(body);

        const signedHeaders = this.signer.sign({
            method: 'POST',
            url,
            headers: {
                'Content-Type': 'application/json',
                'Accept': stream ? 'application/vnd.amazon.eventstream' : 'application/json'
            },
            body: bodyStr
        });

        const config = {
            headers: signedHeaders,
            ...getAxiosProxyConfig()
        };

        if (stream) {
            config.responseType = 'stream';
        }

        return await this.axiosInstance.post(url, body, config);
    }

    /**
     * 聊天（非流式）
     */
    async chat(messages, model = BEDROCK_CONSTANTS.DEFAULT_MODEL, options = {}) {
        const url = this._getApiUrl(model, false);
        const requestData = this._convertRequest(messages, model, options);

        log.info(`Bedrock 请求: ${url}`);
        log.debug(`请求数据: ${JSON.stringify(requestData).substring(0, 500)}...`);

        try {
            const response = await this._sendSignedRequest(url, requestData, false);
            return this._convertResponse(response.data, model);
        } catch (error) {
            log.error(`Bedrock 请求失败: ${error.message}`);
            if (error.response) {
                log.error(`响应状态: ${error.response.status}`);
                log.error(`响应数据: ${JSON.stringify(error.response.data)}`);
            }
            throw error;
        }
    }

    /**
     * 聊天（流式）
     */
    async *chatStream(messages, model = BEDROCK_CONSTANTS.DEFAULT_MODEL, options = {}) {
        const url = this._getApiUrl(model, true);
        const requestData = this._convertRequest(messages, model, options);

        log.info(`Bedrock 流式请求: ${url}`);
        log.debug(`请求数据: ${JSON.stringify(requestData).substring(0, 500)}...`);

        const response = await this._sendSignedRequest(url, requestData, true);

        let buffer = Buffer.alloc(0);

        for await (const chunk of response.data) {
            buffer = Buffer.concat([buffer, chunk]);

            // 解析 AWS Event Stream 格式
            while (buffer.length >= 16) {
                // 读取消息长度（前4字节）
                const totalLength = buffer.readUInt32BE(0);
                
                if (buffer.length < totalLength) {
                    break; // 等待更多数据
                }

                // 提取完整消息
                const messageBuffer = buffer.slice(0, totalLength);
                buffer = buffer.slice(totalLength);

                // 解析消息
                const event = this._parseEventStreamMessage(messageBuffer);
                if (event) {
                    yield event;
                }
            }
        }
    }

    /**
     * 解析 AWS Event Stream 消息
     */
    _parseEventStreamMessage(buffer) {
        try {
            // AWS Event Stream 格式:
            // 4 bytes: total length
            // 4 bytes: headers length
            // 4 bytes: prelude CRC
            // variable: headers
            // variable: payload
            // 4 bytes: message CRC

            const headersLength = buffer.readUInt32BE(4);
            const headersStart = 12;
            const payloadStart = headersStart + headersLength;
            const payloadEnd = buffer.length - 4;

            if (payloadStart >= payloadEnd) {
                return null;
            }

            const payload = buffer.slice(payloadStart, payloadEnd).toString('utf8');
            
            if (!payload) {
                return null;
            }

            try {
                const parsed = JSON.parse(payload);
                
                // 处理不同的事件类型
                if (parsed.contentBlockDelta?.delta?.text) {
                    return {
                        type: 'content_block_delta',
                        delta: { type: 'text_delta', text: parsed.contentBlockDelta.delta.text }
                    };
                }
                
                if (parsed.contentBlockStart?.contentBlock?.toolUse) {
                    return {
                        type: 'content_block_start',
                        content_block: {
                            type: 'tool_use',
                            id: parsed.contentBlockStart.contentBlock.toolUse.toolUseId,
                            name: parsed.contentBlockStart.contentBlock.toolUse.name,
                            input: ''
                        }
                    };
                }

                if (parsed.contentBlockDelta?.delta?.toolUse) {
                    return {
                        type: 'content_block_delta',
                        delta: {
                            type: 'input_json_delta',
                            partial_json: parsed.contentBlockDelta.delta.toolUse.input || ''
                        }
                    };
                }
                
                if (parsed.metadata?.usage) {
                    return {
                        type: 'message_delta',
                        usage: {
                            input_tokens: parsed.metadata.usage.inputTokens || 0,
                            output_tokens: parsed.metadata.usage.outputTokens || 0
                        }
                    };
                }

                if (parsed.messageStop) {
                    return {
                        type: 'message_stop',
                        stop_reason: parsed.messageStop.stopReason || 'end_turn'
                    };
                }

                return null;
            } catch (e) {
                // 忽略 JSON 解析错误
                return null;
            }
        } catch (e) {
            log.error(`解析 Event Stream 消息失败: ${e.message}`);
            return null;
        }
    }
}

/**
 * Bedrock API 服务类（无状态）
 */
export class BedrockAPI {
    /**
     * 聊天（非流式）
     */
    static async chat(credentials, messages, model = BEDROCK_CONSTANTS.DEFAULT_MODEL, options = {}) {
        const client = BedrockClient.fromCredentials(credentials, options.region);
        return await client.chat(messages, model, options);
    }

    /**
     * 聊天（流式）
     */
    static async *chatStream(credentials, messages, model = BEDROCK_CONSTANTS.DEFAULT_MODEL, options = {}) {
        const client = BedrockClient.fromCredentials(credentials, options.region);
        yield* client.chatStream(messages, model, options);
    }

    /**
     * 获取模型列表
     */
    static getModels() {
        return BEDROCK_MODELS;
    }

    /**
     * 获取模型映射
     */
    static getModelMapping() {
        return BEDROCK_MODEL_MAPPING;
    }

    /**
     * 获取支持的区域
     */
    static getRegions() {
        return BEDROCK_CONSTANTS.SUPPORTED_REGIONS;
    }
}

export default BedrockClient;
