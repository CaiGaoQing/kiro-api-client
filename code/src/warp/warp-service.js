/**
 * Warp API 服务
 * 提供 Token 刷新和 AI 对话功能
 */

import https from 'https';
import { execSync } from 'child_process';

// Firebase API Key
const FIREBASE_API_KEY = 'AIzaSyBdy3O3S9hrdayLJxJ7mriBR4qgUaUygAs';

// Warp API 配置
const WARP_CONFIG = {
    host: 'app.warp.dev',
    path: '/ai/multi-agent',
    headers: {
        'x-warp-client-id': 'warp-app',
        'x-warp-client-version': 'v0.2026.01.14.08.15.stable_02',
        'x-warp-os-category': 'macOS',
        'x-warp-os-name': 'macOS',
        'x-warp-os-version': '15.7.2',
        'content-type': 'application/x-protobuf',
        'accept': 'text/event-stream',
        'accept-encoding': 'identity',
    }
};

// Warp 原生支持的模型
export const WARP_MODELS = [
    { id: 'claude-4.1-opus', name: 'Claude 4.1 Opus', provider: 'warp' },
    { id: 'claude-4-opus', name: 'Claude 4 Opus', provider: 'warp' },
    { id: 'claude-4-5-opus', name: 'Claude 4.5 Opus', provider: 'warp' },
    { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet', provider: 'warp' },
    { id: 'claude-4-5-sonnet', name: 'Claude 4.5 Sonnet', provider: 'warp' },
    { id: 'gpt-5', name: 'GPT-5', provider: 'warp' },
    { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'warp' },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'warp' },
    { id: 'o3', name: 'O3', provider: 'warp' },
    { id: 'o4-mini', name: 'O4 Mini', provider: 'warp' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'warp' },
];

// 模型名称映射：外部模型名 -> Warp 模型名
const MODEL_MAPPING = {
    // Anthropic 模型映射
    'claude-opus-4-5-20251101': 'claude-4-5-opus',
    'claude-haiku-4-5-20251001': 'claude-4-5-sonnet',  // haiku 映射到 sonnet
    'claude-sonnet-4-20250514': 'claude-4-sonnet',
    'claude-3-5-sonnet-20241022': 'claude-4-sonnet',
    'claude-3-opus-20240229': 'claude-4-opus',
    'claude-3-sonnet-20240229': 'claude-4-sonnet',
    'claude-3-haiku-20240307': 'claude-4-sonnet',
    
    // Gemini 模型映射
    'gemini-2.5-flash': 'gemini-2.5-pro',
    'gemini-2.5-flash-lite': 'gemini-2.5-pro',
    'gemini-2.5-flash-thinking': 'gemini-2.5-pro',
    'gemini-2.5-pro': 'gemini-2.5-pro',
    'gemini-3-flash': 'gemini-2.5-pro',
    'gemini-3-pro': 'gemini-3-pro',
    'gemini-3-pro-high': 'gemini-3-pro',
    'gemini-3-pro-low': 'gemini-2.5-pro',
    
    // OpenAI 模型映射
    'gpt-4-turbo': 'gpt-4.1',
    'gpt-4-turbo-preview': 'gpt-4.1',
    'gpt-4': 'gpt-4.1',
    'gpt-4o': 'gpt-4o',
    'gpt-4o-mini': 'gpt-4.1',
    'o1': 'o3',
    'o1-mini': 'o4-mini',
    'o1-preview': 'o3',
};

/**
 * 将外部模型名转换为 Warp 支持的模型名
 */
export function mapModelToWarp(modelName) {
    if (!modelName) return 'claude-4.1-opus';
    
    const lowerModel = modelName.toLowerCase().trim();
    
    // 直接匹配映射表
    if (MODEL_MAPPING[lowerModel]) {
        return MODEL_MAPPING[lowerModel];
    }
    
    // 检查是否是 Warp 原生支持的模型
    const warpModel = WARP_MODELS.find(m => m.id.toLowerCase() === lowerModel);
    if (warpModel) {
        return warpModel.id;
    }
    
    // 模糊匹配
    if (lowerModel.includes('opus')) {
        if (lowerModel.includes('4.5') || lowerModel.includes('4-5')) return 'claude-4-5-opus';
        if (lowerModel.includes('4.1')) return 'claude-4.1-opus';
        return 'claude-4-opus';
    }
    if (lowerModel.includes('sonnet')) {
        if (lowerModel.includes('4.5') || lowerModel.includes('4-5')) return 'claude-4-5-sonnet';
        return 'claude-4-sonnet';
    }
    if (lowerModel.includes('haiku')) return 'claude-4-sonnet';
    if (lowerModel.includes('claude')) return 'claude-4.1-opus';
    if (lowerModel.includes('gemini')) return 'gemini-2.5-pro';
    if (lowerModel.includes('gpt')) return 'gpt-4.1';
    
    // 默认返回 claude-4.1-opus
    return 'claude-4.1-opus';
}

// ==================== Token 工具 ====================

/**
 * 解析 JWT Token
 */
export function parseJwtToken(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        let payload = parts[1];
        payload += '='.repeat((4 - payload.length % 4) % 4);

        const decoded = Buffer.from(payload, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

/**
 * 检查 Token 是否过期
 */
export function isTokenExpired(token, bufferMinutes = 5) {
    const payload = parseJwtToken(token);
    if (!payload || !payload.exp) return true;

    const now = Math.floor(Date.now() / 1000);
    const bufferSeconds = bufferMinutes * 60;

    return (payload.exp - now) <= bufferSeconds;
}

/**
 * 获取 Token 过期时间
 */
export function getTokenExpiresAt(token) {
    const payload = parseJwtToken(token);
    if (!payload || !payload.exp) return null;
    return new Date(payload.exp * 1000);
}

/**
 * 从 Token 中提取邮箱
 */
export function getEmailFromToken(token) {
    const payload = parseJwtToken(token);
    return payload?.email || null;
}

// ==================== Token 刷新 ====================

/**
 * 使用 refresh token 刷新 access token
 * 使用 curl 命令通过代理发送请求（如果需要）
 */
export function refreshAccessToken(refreshToken) {
    return new Promise((resolve, reject) => {

        const payload = JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        });

        const url = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
        const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
        const isWindows = process.platform === 'win32';

        // Windows 使用双引号并转义内部双引号，Unix 使用单引号
        const escapedPayload = isWindows
            ? `"${payload.replace(/"/g, '\\"')}"`
            : `'${payload}'`;

        try {
            let result;

            // 如果设置了代理，先尝试代理
            if (proxyUrl) {
                try {
                    const proxyCmd = `curl -s --connect-timeout 10 --max-time 30 -x "${proxyUrl}" -X POST "${url}" -H "Content-Type: application/json" -d ${escapedPayload}`;
                    result = execSync(proxyCmd, {
                        encoding: 'utf8',
                        timeout: 35000,
                        windowsHide: true
                    });
                } catch (proxyError) {
                    console.log('[Warp] 代理请求失败，尝试直连...');
                    // 代理失败，尝试直连
                    const directCmd = `curl -s --connect-timeout 10 --max-time 30 -X POST "${url}" -H "Content-Type: application/json" -d ${escapedPayload}`;
                    result = execSync(directCmd, {
                        encoding: 'utf8',
                        timeout: 35000,
                        windowsHide: true
                    });
                }
            } else {
                // 没有代理，直接请求
                const directCmd = `curl -s --connect-timeout 10 --max-time 30 -X POST "${url}" -H "Content-Type: application/json" -d ${escapedPayload}`;
                result = execSync(directCmd, {
                    encoding: 'utf8',
                    timeout: 35000,
                    windowsHide: true
                });
            }

            if (!result || result.trim() === '') {
                reject(new Error('刷新失败: 服务器无响应'));
                return;
            }

            const json = JSON.parse(result);

            if (json.error) {
                reject(new Error(`刷新失败: ${json.error.message}`));
            } else {
                resolve({
                    accessToken: json.id_token,
                    refreshToken: json.refresh_token,
                    expiresIn: parseInt(json.expires_in)
                });
            }
        } catch (e) {
            if (e.message && e.message.includes('ETIMEDOUT')) {
                reject(new Error('刷新失败: 连接超时，请检查网络或代理设置'));
            } else {
                reject(e);
            }
        }
    });
}

// ==================== Protobuf 编码 ====================

function encodeVarint(value) {
    const bytes = [];
    let v = value;
    while (v > 127) {
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    bytes.push(v);
    return Buffer.from(bytes);
}

function encodeField(fieldNum, wireType, data) {
    const tag = (fieldNum << 3) | wireType;
    return Buffer.concat([encodeVarint(tag), data]);
}

function encodeString(fieldNum, str) {
    const strBytes = Buffer.from(str, 'utf8');
    return encodeField(fieldNum, 2, Buffer.concat([encodeVarint(strBytes.length), strBytes]));
}

function encodeBytes(fieldNum, buf) {
    return encodeField(fieldNum, 2, Buffer.concat([encodeVarint(buf.length), buf]));
}

function encodeMessage(fieldNum, msgBytes) {
    return encodeField(fieldNum, 2, Buffer.concat([encodeVarint(msgBytes.length), msgBytes]));
}

function encodeVarintField(fieldNum, value) {
    return encodeField(fieldNum, 0, encodeVarint(value));
}

function encodeFixed32(fieldNum, value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value, 0);
    return encodeField(fieldNum, 5, buf);
}

/**
 * 构建 Warp 请求体
 * @param {string} query - 用户查询
 * @param {string} model - 模型名称
 * @param {Object} options - 可选参数
 * @param {Object} options.toolResult - 工具结果 { callId, command, output }
 * @param {string} options.workingDir - 工作目录
 */
function buildRequestBody(query, model = 'claude-4.1-opus', options = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nanos = (Date.now() % 1000) * 1000000;
    const workingDir = options.workingDir || '/tmp';
    const homeDir = '/tmp';
    const toolResult = options.toolResult || null;

    const field1 = encodeString(1, "");
    const pathInfo = Buffer.concat([encodeString(1, workingDir), encodeString(2, homeDir)]);
    const osInfo = encodeMessage(1, encodeFixed32(9, 0x534f6361));
    const shellInfo = Buffer.concat([encodeString(1, "zsh"), encodeString(2, "5.9")]);
    const timestampInfo = Buffer.concat([encodeVarintField(1, timestamp), encodeVarintField(2, nanos)]);

    const field2_1 = Buffer.concat([
        encodeMessage(1, pathInfo),
        encodeMessage(2, osInfo),
        encodeMessage(3, shellInfo),
        encodeMessage(4, timestampInfo)
    ]);

    let field2_6;
    if (toolResult && toolResult.callId && toolResult.output !== undefined) {
        // 将工具结果嵌入查询文本中，让 Warp 理解上下文
        // 格式：原始查询 + 工具执行信息 + 工具输出
        const toolResultQuery = `${query}\n\n[命令已执行]\n命令: ${toolResult.command}\n输出:\n${toolResult.output}`;
        const queryContent = Buffer.concat([encodeString(1, toolResultQuery), encodeString(3, ""), encodeVarintField(4, 1)]);
        field2_6 = encodeMessage(1, encodeMessage(1, queryContent));
    } else {
        // 普通查询格式
        const queryContent = Buffer.concat([encodeString(1, query), encodeString(3, ""), encodeVarintField(4, 1)]);
        field2_6 = encodeMessage(1, encodeMessage(1, queryContent));
    }
    
    const field2Content = Buffer.concat([encodeMessage(1, field2_1), encodeMessage(6, field2_6)]);

    const modelConfig = Buffer.concat([encodeString(1, "auto-efficient"), encodeString(4, "cli-agent-auto")]);
    const capabilities = Buffer.from([0x06, 0x07, 0x0c, 0x08, 0x09, 0x0f, 0x0e, 0x00, 0x0b, 0x10, 0x0a, 0x14, 0x11, 0x13, 0x12, 0x02, 0x03, 0x01, 0x0d]);
    const capabilities2 = Buffer.from([0x0a, 0x14, 0x06, 0x07, 0x0c, 0x02, 0x01]);

    const field3Content = Buffer.concat([
        encodeMessage(1, modelConfig),
        encodeVarintField(2, 1), encodeVarintField(3, 1), encodeVarintField(4, 1),
        encodeVarintField(6, 1), encodeVarintField(7, 1), encodeVarintField(8, 1),
        encodeBytes(9, capabilities),
        encodeVarintField(10, 1), encodeVarintField(11, 1), encodeVarintField(12, 1),
        encodeVarintField(13, 1), encodeVarintField(14, 1), encodeVarintField(15, 1),
        encodeVarintField(16, 1), encodeVarintField(17, 1), encodeVarintField(21, 1),
        encodeBytes(22, capabilities2), encodeVarintField(23, 1)
    ]);

    const entrypoint = Buffer.concat([
        encodeString(1, "entrypoint"),
        encodeMessage(2, encodeMessage(3, encodeString(1, "USER_INITIATED")))
    ]);
    const autoResume = Buffer.concat([encodeString(1, "is_auto_resume_after_error"), encodeMessage(2, encodeVarintField(4, 0))]);
    const autoDetect = Buffer.concat([encodeString(1, "is_autodetected_user_query"), encodeMessage(2, encodeVarintField(4, 1))]);
    const field4Content = Buffer.concat([encodeMessage(2, entrypoint), encodeMessage(2, autoResume), encodeMessage(2, autoDetect)]);

    return Buffer.concat([field1, encodeMessage(2, field2Content), encodeMessage(3, field3Content), encodeMessage(4, field4Content)]);
}

// ==================== 响应解析 ====================

// 预编译正则表达式（性能优化）
const UUID_REGEX = /^[0-9a-f-]{36}$/;
const CHINESE_REGEX = /[\u4e00-\u9fff]/;
const ALPHA_2_REGEX = /[a-zA-Z]{2,}/;
const ALPHA_3_REGEX = /[a-zA-Z]{3,}/;
const BASE64_REGEX = /^[A-Za-z0-9+/=]+$/;

/**
 * 快速检查是否包含中文字符
 */
function hasChinese(text) {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0x4e00 && code <= 0x9fff) return true;
    }
    return false;
}

/**
 * 从 protobuf 响应中提取文本内容
 * 支持 agent_output.text
 * 修复：收集所有匹配的文本片段，而不是只返回第一个
 */
function extractAgentText(buffer) {
    const bufferStr = buffer.toString('utf8');
    const DEBUG = process.env.WARP_DEBUG === 'true';
    
    // 只处理 agent_output
    if (!bufferStr.includes('agent_output')) {
        return null;
    }
    
    // 调试：打印 agent_output 的原始数据
    if (DEBUG) {
        const printable = bufferStr.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
        console.log(`  [AGENT_OUTPUT RAW] ${printable.substring(0, 200)}${printable.length > 200 ? '...' : ''}`);
    }
    
    const texts = [];  // 收集所有文本片段
    
    // 使用 \x1a 嵌套解析
    for (let i = 0; i < buffer.length - 4; i++) {
        if (buffer[i] === 0x1a) {
            const outerLen = buffer[i + 1];
            if (outerLen > 2 && outerLen < 200 && buffer[i + 2] === 0x0a) {
                const innerLen = buffer[i + 3];
                if (innerLen > 0 && innerLen <= outerLen - 2 && i + 4 + innerLen <= buffer.length) {
                    const text = buffer.slice(i + 4, i + 4 + innerLen).toString('utf8');
                    
                    // 过滤空文本和 UUID
                    if (text.length === 0) continue;
                    if (text.length === 36 && UUID_REGEX.test(text)) continue;
                    
                    // 过滤系统标识符
                    if (text.includes('agent_') || text.includes('server_') || 
                        text.includes('USER_') || text.includes('primary_') ||
                        text.includes('call_') || text.includes('precmd-')) continue;
                    
                    // 过滤 JSON 元数据片段（如 "isNewTopic": true, "title": "xxx"）
                    if (text.includes('isNewTopic') || text.includes('"title"') ||
                        text.includes('"type"') || text.includes('"id"') ||
                        /^"[a-zA-Z_]+"\s*:/.test(text.trim()) ||
                        /^\s*\}?\s*$/.test(text) ||  // 只有 } 或空白
                        text.trim() === 'null' || text.trim() === 'true' || text.trim() === 'false') continue;
                    
                    // 检查是否有可见内容（中文、英文、数字、标点等）
                    // 放宽条件：只要有中文字符或可打印 ASCII 字符即可
                    const hasContent = hasChinese(text) || /[a-zA-Z0-9\s\-_.,!?:;'"()\[\]{}@#$%^&*+=<>/\\|`~]/.test(text);
                    
                    if (hasContent) {
                        // 排除纯 base64 长字符串（通常是 ID）
                        if (text.length > 20 && BASE64_REGEX.test(text)) continue;
                        texts.push(text);  // 收集而不是直接返回
                    }
                }
            }
        }
    }

    if (texts.length === 0) return null;
    
    const result = texts.join('');
    
    // 最终过滤：如果合并后的文本看起来像 JSON 元数据，则丢弃
    // 匹配包含 isNewTopic 的任何文本（这是 Warp 的会话元数据）
    if (/isNewTopic/i.test(result)) {
        return null;
    }
    // 匹配包含 title": 的 JSON 片段（注意可能没有引号）
    if (/title"\s*:\s*/.test(result) && result.length < 150) {
        return null;
    }
    // 匹配以 } 或 }" 结尾的短 JSON 片段
    if (/["}]\s*$/.test(result) && result.length < 100 && /^\s*"/.test(result)) {
        return null;
    }
    // 匹配看起来像 JSON 键值对的短文本
    if (/^[^a-zA-Z\u4e00-\u9fa5]*"?\w+"?\s*:\s*/.test(result) && result.length < 80) {
        return null;
    }
    
    return result;
}

/**
 * 从 protobuf 响应中提取工具调用请求
 * 支持 run_shell_command 和 create_documents 两种类型
 * 返回 { command, callId, toolName, content } 或 null
 */
function extractToolCall(buffer) {
    const bufferStr = buffer.toString('utf8');
    const DEBUG = process.env.WARP_DEBUG === 'true';
    
    // 检查是否包含工具调用标识
    const isShellCommand = bufferStr.includes('tool_call.run_shell_command');
    const isCreateDocuments = bufferStr.includes('tool_call.create_documents');
    
    // 检查是否包含 call_ 开头的工具调用 ID（通用检测）
    const hasCallId = /call_[A-Za-z0-9]{20,}/.test(bufferStr);
    
    // 如果有 call_id 但没有已知的工具类型，尝试从 buffer 中提取内容
    if (hasCallId && !isShellCommand && !isCreateDocuments) {
        const callIdMatch = bufferStr.match(/call_[A-Za-z0-9]+/);
        if (callIdMatch) {
            const callId = callIdMatch[0];
            
            // 方法1: 直接从 call_id 后面提取可读文本
            const callIdIdx = bufferStr.indexOf(callId);
            const afterCallId = bufferStr.substring(callIdIdx + callId.length);
            
            // 查找实际内容 - 跳过 call_id 后的控制字符和垃圾数据
            // 寻找类似 "Create a simple HTML" 这样的有意义文本
            let directContent = '';
            // 匹配有意义的句子（以大写字母开头，包含空格的短语）
            const sentenceMatch = afterCallId.match(/[A-Z][a-z]+\s+[a-z]+[\x20-\x7E\u4e00-\u9fff]*/);
            if (sentenceMatch && sentenceMatch[0].length > 10) {
                directContent = sentenceMatch[0];
                if (DEBUG) {
                    console.log(`  [TOOL_CALL] sentence match: "${directContent.substring(0, 50)}..."`);
                }
            }
            
            // 备用：提取连续的可打印字符
            if (!directContent) {
                const directMatch = afterCallId.match(/[\x20-\x7E\u4e00-\u9fff]+/g);
                if (directMatch) {
                    const filtered = directMatch.filter(s => {
                        if (s.length < 2) return false;
                        if (s.includes('call_')) return false;
                        if (s.length === 36 && UUID_REGEX.test(s)) return false;
                        if (s.length > 20 && /^[A-Za-z0-9+/=]+$/.test(s)) return false;
                        return true;
                    });
                    directContent = filtered.join('');
                    if (DEBUG && filtered.length > 0) {
                        console.log(`  [TOOL_CALL] directMatch filtered: ${JSON.stringify(filtered.slice(0, 3))}`);
                    }
                }
            }
            
            // 方法2: 使用 protobuf 风格解析
            const contentTexts = [];
            for (let i = 0; i < buffer.length - 4; i++) {
                if (buffer[i] === 0x1a) {
                    const outerLen = buffer[i + 1];
                    if (outerLen > 2 && outerLen < 200 && buffer[i + 2] === 0x0a) {
                        const innerLen = buffer[i + 3];
                        if (innerLen > 0 && innerLen <= outerLen - 2 && i + 4 + innerLen <= buffer.length) {
                            const text = buffer.slice(i + 4, i + 4 + innerLen).toString('utf8');
                            if (text.length === 0) continue;
                            if (text.length === 36 && UUID_REGEX.test(text)) continue;
                            if (text.includes('call_') || text.includes('tool_call.')) continue;
                            const hasContent = hasChinese(text) || /[a-zA-Z0-9#\-*<>!]/.test(text);
                            if (hasContent) contentTexts.push(text);
                        }
                    }
                }
            }
            const protoContent = contentTexts.join('');
            
            // 选择更长的内容
            let content = directContent.length > protoContent.length ? directContent : protoContent;
            
            // 如果内容看起来像 Base64，尝试解码
            if (content.length > 20 && /^[A-Za-z0-9+/=]+$/.test(content.replace(/\s/g, ''))) {
                try {
                    const decoded = Buffer.from(content, 'base64').toString('utf8');
                    // 从解码后的数据中提取可读文本
                    const readableTexts = decoded.match(/[\x20-\x7E\u4e00-\u9fff]{5,}/g);
                    if (readableTexts) {
                        const extractedContent = readableTexts.filter(s => 
                            !UUID_REGEX.test(s) && 
                            !s.includes('gpt-') &&
                            !/^[A-Za-z0-9+/=]+$/.test(s)
                        ).join(' ');
                        if (extractedContent.length > 10) {
                            content = extractedContent;
                            if (DEBUG) {
                                console.log(`  [TOOL_CALL] decoded Base64: "${content.substring(0, 80)}..."`);
                            }
                        }
                    }
                } catch (e) {
                    // Base64 解码失败，保持原内容
                }
            }
            
            if (DEBUG) {
                console.log(`  [TOOL_CALL] generic call_id: ${callId}, direct=${directContent.length}c, proto=${protoContent.length}c, final=${content.length}c`);
            }
            
            // 只有当提取到内容时才返回工具调用
            if (content.length > 0) {
                return { 
                    toolName: 'Write',
                    callId, 
                    command: 'create_documents',
                    content: content
                };
            }
        }
        return null;
    }
    
    if (!isShellCommand && !isCreateDocuments) {
        return null;
    }
    
    // 处理 create_documents 工具调用
    if (isCreateDocuments) {
        const callIdMatch = bufferStr.match(/call_[A-Za-z0-9]+/);
        const callId = callIdMatch ? callIdMatch[0] : null;
        
        // 提取文档内容
        let content = null;
        const contentTexts = [];
        
        // 使用 \x1a 嵌套解析提取内容片段
        for (let i = 0; i < buffer.length - 4; i++) {
            if (buffer[i] === 0x1a) {
                const outerLen = buffer[i + 1];
                if (outerLen > 2 && outerLen < 200 && buffer[i + 2] === 0x0a) {
                    const innerLen = buffer[i + 3];
                    if (innerLen > 0 && innerLen <= outerLen - 2 && i + 4 + innerLen <= buffer.length) {
                        const text = buffer.slice(i + 4, i + 4 + innerLen).toString('utf8');
                        if (text.length === 0) continue;
                        if (text.length === 36 && UUID_REGEX.test(text)) continue;
                        if (text.includes('tool_call.') || text.includes('call_')) continue;
                        
                        const hasContent = hasChinese(text) || /[a-zA-Z0-9#\-*]/.test(text);
                        if (hasContent && text.length > 0) {
                            contentTexts.push(text);
                        }
                    }
                }
            }
        }
        
        content = contentTexts.join('');
        
        if (DEBUG && callId) {
            console.log(`  [TOOL_CALL] create_documents: callId=${callId}, content.length=${content?.length || 0}`);
        }
        
        if (callId) {
            return { 
                toolName: 'Write',
                callId, 
                command: 'create_documents',
                content: content || ''
            };
        }
        return null;
    }
    
    // 调试：打印工具调用的原始数据
    if (DEBUG) {
        const printable = bufferStr.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
        console.log(`  [TOOL_CALL RAW] ${printable.substring(0, 300)}${printable.length > 300 ? '...' : ''}`);
    }
    
    // 提取 call_id
    const callIdMatch = bufferStr.match(/call_[A-Za-z0-9]+/);
    const callId = callIdMatch ? callIdMatch[0] : null;
    
    // 提取命令 - 改进的方法
    let command = null;
    
    // 方法1: 查找 tool_call.run_shell_command.command 标记后的命令
    // 命令通常在 "command" 字段之前，格式为 length-prefixed string
    const commandMarkerIdx = bufferStr.indexOf('tool_call.run_shell_command.command');
    if (commandMarkerIdx > 0) {
        // 在标记之前查找命令字符串
        // 向前搜索，找到最近的有效命令
        for (let i = commandMarkerIdx - 1; i >= 4; i--) {
            if (buffer[i - 1] === 0x0a) {
                const len = buffer[i];
                if (len >= 2 && len <= 200 && i + len <= commandMarkerIdx) {
                    const possibleCmd = buffer.slice(i + 1, i + 1 + len).toString('utf8');
                    // 检查是否是有效命令
                    if (/^[a-zA-Z\/\.]/.test(possibleCmd) && 
                        !possibleCmd.includes('tool_call') &&
                        !possibleCmd.includes('agent_') &&
                        !possibleCmd.includes('server_') &&
                        !UUID_REGEX.test(possibleCmd)) {
                        command = possibleCmd;
                        if (DEBUG) {
                            console.log(`  [TOOL_CALL] found command (method1): "${command}"`);
                        }
                        break;
                    }
                }
            }
        }
    }
    
    // 方法2: 扫描所有 length-prefixed 字符串，找到看起来像命令的
    if (!command) {
        for (let i = 0; i < buffer.length - 3; i++) {
            if (buffer[i] === 0x0a) {
                const len = buffer[i + 1];
                if (len >= 2 && len <= 200 && i + 2 + len <= buffer.length) {
                    const possibleCmd = buffer.slice(i + 2, i + 2 + len).toString('utf8');
                    // 检查是否是有效命令（以字母、/、. 开头）
                    if (/^[a-zA-Z\/\.]/.test(possibleCmd) && 
                        !possibleCmd.includes('tool_call') &&
                        !possibleCmd.includes('agent_') &&
                        !possibleCmd.includes('server_') &&
                        !possibleCmd.includes('primary_') &&
                        !UUID_REGEX.test(possibleCmd) &&
                        !BASE64_REGEX.test(possibleCmd)) {
                        // 检查是否包含命令特征（空格+参数，或常见命令名）
                        const cmdName = possibleCmd.split(/\s/)[0];
                        const commonCmds = ['ls', 'cat', 'grep', 'find', 'pwd', 'cd', 'echo', 'head', 'tail', 
                                           'wc', 'tree', 'file', 'stat', 'du', 'df', 'mkdir', 'rm', 'cp', 
                                           'mv', 'touch', 'chmod', 'chown', 'curl', 'wget', 'git', 'npm',
                                           'node', 'python', 'pip', 'yarn', 'pnpm', 'bash', 'sh', 'zsh'];
                        if (commonCmds.includes(cmdName) || possibleCmd.includes(' ')) {
                            command = possibleCmd;
                            if (DEBUG) {
                                console.log(`  [TOOL_CALL] found command (method2): "${command}"`);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }
    
    if (callId) {
        if (DEBUG && !command) {
            console.log(`  [TOOL_CALL] WARNING: callId=${callId} but command not found`);
        }
        return { command: command || 'unknown', callId };
    }
    
    return null;
}

/**
 * 从 protobuf 响应中提取工具执行结果
 * 工具结果通常包含 ls、precmd 等标识
 */
function extractToolResult(buffer) {
    const bufferStr = buffer.toString('utf8');
    
    // 跳过工具调用请求（不是结果）
    if (bufferStr.includes('tool_call.run_shell_command') || 
        bufferStr.includes('server_message_data') ||
        bufferStr.includes('orchestrator executed')) {
        return null;
    }
    
    // 检查是否包含工具结果标识
    if (!bufferStr.includes('precmd-')) {
        return null;
    }
    
    // 提取工具输出（通常在 \x12 后面的大块数据中）
    // 查找包含换行符的多行输出
    const lines = bufferStr.split('\n');
    const resultLines = [];
    
    for (const line of lines) {
        // 清理不可打印字符
        const cleaned = line.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
        if (cleaned.length > 0) {
            // 过滤掉 UUID 和系统标识
            if (UUID_REGEX.test(cleaned)) continue;
            if (cleaned.includes('call_') || cleaned.includes('precmd-')) continue;
            if (cleaned.startsWith('$') && cleaned.length === 37) continue;
            if (cleaned.includes('tool_call.') || cleaned.includes('server_message')) continue;
            
            // 保留有意义的内容
            if (hasChinese(cleaned) || /[a-zA-Z0-9]/.test(cleaned)) {
                resultLines.push(cleaned);
            }
        }
    }
    
    if (resultLines.length > 0) {
        return resultLines.join('\n');
    }
    
    return null;
}

/**
 * 从 protobuf 响应中提取 agent_reasoning.reasoning 文本
 * 这是 AI 的推理过程，当没有 agent_output 时可能只有 reasoning
 */
function extractReasoning(buffer) {
    const bufferStr = buffer.toString('utf8');
    
    // 只处理 agent_reasoning
    if (!bufferStr.includes('agent_reasoning.reasoning')) {
        return null;
    }
    
    const texts = [];
    
    // 使用 \x1a 嵌套解析（与 extractAgentText 类似）
    for (let i = 0; i < buffer.length - 4; i++) {
        if (buffer[i] === 0x1a) {
            const outerLen = buffer[i + 1];
            if (outerLen > 2 && outerLen < 200 && buffer[i + 2] === 0x0a) {
                const innerLen = buffer[i + 3];
                if (innerLen > 0 && innerLen <= outerLen - 2 && i + 4 + innerLen <= buffer.length) {
                    const text = buffer.slice(i + 4, i + 4 + innerLen).toString('utf8');
                    
                    if (text.length === 0) continue;
                    if (text.length === 36 && UUID_REGEX.test(text)) continue;
                    
                    // 过滤系统标识符
                    if (text.includes('agent_') || text.includes('server_') || 
                        text.includes('USER_') || text.includes('primary_') ||
                        text.includes('call_') || text.includes('precmd-')) continue;
                    
                    // 检查是否有可见内容
                    const hasContent = hasChinese(text) || /[a-zA-Z0-9\s\-_.,!?:;'"()\[\]{}@#$%^&*+=<>/\\|`~]/.test(text);
                    
                    if (hasContent) {
                        if (text.length > 20 && BASE64_REGEX.test(text)) continue;
                        texts.push(text);
                    }
                }
            }
        }
    }

    return texts.length > 0 ? texts.join('') : null;
}

/**
 * 综合提取响应内容（包括 agent_output、agent_reasoning、工具调用和工具结果）
 */
function extractContent(buffer, debug = false) {
    const bufferStr = buffer.toString('utf8');
    
    // 调试：打印原始数据的可读部分
    if (debug) {
        // 提取可打印字符
        const printable = bufferStr.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
        if (printable.length > 0) {
            console.log(`  [RAW] ${printable.substring(0, 200)}${printable.length > 200 ? '...' : ''}`);
        }
    }
    
    // 优先提取 agent_output.text
    const agentText = extractAgentText(buffer);
    if (agentText) {
        return { type: 'text', content: agentText };
    }
    
    // 检测工具调用内容流（tool_call.create_documents.new_documents.content）
    // 这些事件包含文档的实际内容，需要累积
    if (bufferStr.includes('tool_call.create_documents.new_documents.content')) {
        const contentTexts = [];
        for (let i = 0; i < buffer.length - 4; i++) {
            if (buffer[i] === 0x1a) {
                const outerLen = buffer[i + 1];
                if (outerLen > 2 && outerLen < 200 && buffer[i + 2] === 0x0a) {
                    const innerLen = buffer[i + 3];
                    if (innerLen > 0 && innerLen <= outerLen - 2 && i + 4 + innerLen <= buffer.length) {
                        const text = buffer.slice(i + 4, i + 4 + innerLen).toString('utf8');
                        if (text.length === 0) continue;
                        if (text.length === 36 && UUID_REGEX.test(text)) continue;
                        if (text.includes('tool_call.') || text.includes('new_documents')) continue;
                        const hasContent = hasChinese(text) || /[a-zA-Z0-9#\-*\s]/.test(text);
                        if (hasContent) contentTexts.push(text);
                    }
                }
            }
        }
        if (contentTexts.length > 0) {
            return { type: 'tool_content', content: contentTexts.join('') };
        }
    }
    
    // 检测工具调用请求
    const toolCall = extractToolCall(buffer);
    if (toolCall) {
        return { type: 'tool_call', content: toolCall };
    }
    
    // 尝试提取工具结果
    const toolResult = extractToolResult(buffer);
    if (toolResult) {
        return { type: 'tool_result', content: toolResult };
    }
    
    // 提取 agent_reasoning.reasoning（AI 推理过程）
    const reasoning = extractReasoning(buffer);
    if (reasoning) {
        return { type: 'reasoning', content: reasoning };
    }
    
    return null;
}

// ==================== API 请求 ====================

/**
 * 发送非流式请求
 * @param {string} query - 用户查询
 * @param {string} accessToken - 访问令牌
 * @param {string} model - 模型名称
 * @param {Object} options - 可选参数
 * @param {Object} options.toolResult - 工具结果 { callId, command, output }
 * @param {string} options.workingDir - 工作目录
 */
export function sendWarpRequest(query, accessToken, model = 'claude-4.1-opus', reqOptions = {}) {
    return new Promise((resolve, reject) => {
        const body = buildRequestBody(query, model, reqOptions);
        const DEBUG = process.env.WARP_DEBUG === 'true';

        const httpOptions = {
            hostname: WARP_CONFIG.host,
            port: 443,
            path: WARP_CONFIG.path,
            method: 'POST',
            headers: {
                ...WARP_CONFIG.headers,
                'authorization': `Bearer ${accessToken}`,
                'content-length': body.length
            }
        };

        // 设置请求超时（增加到 120s，因为复杂请求可能需要更长时间）
        const timeoutMs = reqOptions.timeout || 120000;
        const timeout = setTimeout(() => {
            req.destroy(new Error(`Request timeout after ${timeoutMs/1000}s`));
        }, timeoutMs);

        const req = https.request(httpOptions, (res) => {
            if (res.statusCode !== 200) {
                clearTimeout(timeout);
                let errorData = '';
                res.on('data', chunk => errorData += chunk);
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errorData}`)));
                return;
            }

            let responseText = '';
            let toolCalls = [];
            let toolResults = [];
            let toolContentBuffer = '';  // 累积工具调用的文档内容
            let eventCount = 0;
            let textEventCount = 0;
            let buffer = '';  // 用于处理跨 chunk 的不完整行

            res.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                // 保留最后一个可能不完整的行
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data:')) {
                        eventCount++;
                        const eventData = line.substring(5).trim();
                        if (eventData) {
                            try {
                                const decoded = Buffer.from(eventData, 'base64');
                                const extracted = extractContent(decoded, DEBUG);
                                if (extracted) {
                                    if (extracted.type === 'text') {
                                        textEventCount++;
                                        responseText += extracted.content;
                                        if (DEBUG) {
                                            console.log(`  [WARP DEBUG] event#${eventCount} text: "${extracted.content.substring(0, 50)}${extracted.content.length > 50 ? '...' : ''}" (len=${extracted.content.length})`);
                                        }
                                    } else if (extracted.type === 'reasoning') {
                                        // AI 推理过程也作为文本输出
                                        textEventCount++;
                                        responseText += extracted.content;
                                        if (DEBUG) {
                                            console.log(`  [WARP DEBUG] event#${eventCount} reasoning: "${extracted.content.substring(0, 50)}${extracted.content.length > 50 ? '...' : ''}" (len=${extracted.content.length})`);
                                        }
                                    } else if (extracted.type === 'tool_content') {
                                        // 累积工具调用的文档内容
                                        toolContentBuffer += extracted.content;
                                        if (DEBUG) {
                                            console.log(`  [WARP DEBUG] event#${eventCount} tool_content: "${extracted.content.substring(0, 30)}..." (total=${toolContentBuffer.length})`);
                                        }
                                    } else if (extracted.type === 'tool_call') {
                                        // 如果有累积的工具内容，附加到工具调用
                                        if (toolContentBuffer.length > 0) {
                                            extracted.content.content = toolContentBuffer;
                                            toolContentBuffer = '';
                                        }
                                        toolCalls.push(extracted.content);
                                        if (DEBUG) {
                                            console.log(`  [WARP DEBUG] event#${eventCount} tool_call: ${JSON.stringify(extracted.content)}`);
                                        }
                                    } else if (extracted.type === 'tool_result') {
                                        toolResults.push(extracted.content);
                                    }
                                }
                            } catch (e) {
                                if (DEBUG) {
                                    console.log(`  [WARP DEBUG] event#${eventCount} parse error: ${e.message}`);
                                }
                            }
                        }
                    }
                }
            });

            res.on('end', () => {
                clearTimeout(timeout);
                // 处理 buffer 中剩余的数据
                if (buffer.startsWith('data:')) {
                    eventCount++;
                    const eventData = buffer.substring(5).trim();
                    if (eventData) {
                        try {
                            const decoded = Buffer.from(eventData, 'base64');
                            const extracted = extractContent(decoded);
                            if (extracted && (extracted.type === 'text' || extracted.type === 'reasoning')) {
                                textEventCount++;
                                responseText += extracted.content;
                                if (DEBUG) {
                                    console.log(`  [WARP DEBUG] final event#${eventCount} ${extracted.type}: "${extracted.content.substring(0, 50)}..."`);
                                }
                            } else if (extracted && extracted.type === 'tool_content') {
                                toolContentBuffer += extracted.content;
                            }
                        } catch (e) { }
                    }
                }
                
                // 如果有累积的工具内容但还没附加到工具调用，附加到最后一个工具调用
                if (toolContentBuffer.length > 0 && toolCalls.length > 0) {
                    const lastToolCall = toolCalls[toolCalls.length - 1];
                    if (!lastToolCall.content || lastToolCall.content.length === 0) {
                        lastToolCall.content = toolContentBuffer;
                        if (DEBUG) {
                            console.log(`  [WARP DEBUG] attached toolContentBuffer (${toolContentBuffer.length}c) to last tool_call`);
                        }
                    }
                }
                
                // 如果工具调用内容仍为空，使用 responseText 作为内容
                for (const tc of toolCalls) {
                    if ((!tc.content || tc.content.length === 0) && responseText.length > 0) {
                        tc.content = responseText;
                        if (DEBUG) {
                            console.log(`  [WARP DEBUG] using responseText (${responseText.length}c) as tool_call content`);
                        }
                    }
                }
                
                if (DEBUG) {
                    console.log(`  [WARP DEBUG] total: ${eventCount} events, ${textEventCount} text events, responseText.length=${responseText.length}, toolContentBuffer.length=${toolContentBuffer.length}`);
                }
                
                // 返回响应文本和工具调用信息
                resolve({
                    text: responseText,
                    toolCalls: toolCalls,
                    toolResults: toolResults
                });
            });
            
            res.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        req.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        req.write(body);
        req.end();
    });
}

/**
 * 发送流式请求
 */
export function sendWarpStreamRequest(query, accessToken, model, onData, onEnd, onError) {
    const body = buildRequestBody(query, model);

    const options = {
        hostname: WARP_CONFIG.host,
        port: 443,
        path: WARP_CONFIG.path,
        method: 'POST',
        headers: {
            ...WARP_CONFIG.headers,
            'authorization': `Bearer ${accessToken}`,
            'content-length': body.length
        }
    };

    const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
            let errorData = '';
            res.on('data', chunk => errorData += chunk);
            res.on('end', () => onError(new Error(`HTTP ${res.statusCode}: ${errorData}`)));
            return;
        }

        res.on('data', (chunk) => {
            const text = chunk.toString();
            const lines = text.split('\n');

            for (const line of lines) {
                if (line.startsWith('data:')) {
                    const eventData = line.substring(5).trim();
                    if (eventData) {
                        try {
                            const decoded = Buffer.from(eventData, 'base64');
                            const content = extractAgentText(decoded);
                            if (content) {
                                onData(content);
                            }
                        } catch (e) { }
                    }
                }
            }
        });

        res.on('end', onEnd);
    });

    req.on('error', onError);
    req.write(body);
    req.end();

    return req;
}

// ==================== Warp 服务类 ====================

export class WarpService {
    constructor(warpStore) {
        this.store = warpStore;
    }

    /**
     * 获取有效的 access token
     * 如果 token 过期，自动刷新
     */
    async getValidAccessToken(credential) {
        // 检查现有 token 是否有效
        if (credential.accessToken && !isTokenExpired(credential.accessToken)) {
            return credential.accessToken;
        }

        // 刷新 token
        try {
            const result = await refreshAccessToken(credential.refreshToken);
            const expiresAt = new Date(Date.now() + result.expiresIn * 1000);

            // 更新数据库
            await this.store.updateToken(credential.id, result.accessToken, expiresAt);

            return result.accessToken;
        } catch (error) {
            await this.store.incrementErrorCount(credential.id, error.message);
            throw error;
        }
    }

    /**
     * 发送对话请求（自动选择账号、刷新 token、自动故障转移）
     */
    async chat(query, model = 'claude-4.1-opus') {
        // 使用带故障转移的方法
        return this.chatWithFailover(query, model, 3);
    }

    /**
     * 发送流式对话请求（自动故障转移）
     */
    async chatStream(query, model, onData, onEnd, onError) {
        // 使用带故障转移的方法
        return this.chatStreamWithFailover(query, model, onData, onEnd, onError, 3);
    }

    /**
     * 发送流式对话请求（原始版本，无故障转移）
     */
    async chatStreamSimple(query, model, onData, onEnd, onError) {
        const credential = await this.store.getRandomActive();
        if (!credential) {
            onError(new Error('没有可用的 Warp 账号'));
            return null;
        }

        try {
            const accessToken = await this.getValidAccessToken(credential);
            await this.store.incrementUseCount(credential.id);

            return sendWarpStreamRequest(query, accessToken, model, onData, onEnd, (error) => {
                this.store.incrementErrorCount(credential.id, error.message);
                onError(error);
            });
        } catch (error) {
            await this.store.incrementErrorCount(credential.id, error.message);
            onError(error);
            return null;
        }
    }

    /**
     * 批量刷新所有账号的 token
     */
    async refreshAllTokens() {
        const credentials = await this.store.getAllActive();
        const results = [];

        for (const cred of credentials) {
            try {
                if (!cred.accessToken || isTokenExpired(cred.accessToken)) {
                    const result = await refreshAccessToken(cred.refreshToken);
                    const expiresAt = new Date(Date.now() + result.expiresIn * 1000);
                    await this.store.updateToken(cred.id, result.accessToken, expiresAt);
                    results.push({ id: cred.id, name: cred.name, success: true });
                } else {
                    results.push({ id: cred.id, name: cred.name, success: true, skipped: true });
                }
            } catch (error) {
                await this.store.incrementErrorCount(cred.id, error.message);
                results.push({ id: cred.id, name: cred.name, success: false, error: error.message });
            }
        }

        return results;
    }

    /**
     * 健康检查
     */
    async healthCheck() {
        const stats = await this.store.getStatistics();
        return {
            ...stats,
            isHealthy: stats.healthy > 0
        };
    }

    /**
     * 查询账户用量
     */
    async getQuota(credentialId) {
        const credential = credentialId 
            ? await this.store.getById(credentialId)
            : await this.store.getRandomActive();
        
        if (!credential) {
            throw new Error('没有可用的 Warp 账号');
        }

        const accessToken = await this.getValidAccessToken(credential);
        const quota = await getRequestLimit(accessToken);
        
        return {
            ...quota,
            credentialId: credential.id,
            credentialName: credential.name,
            email: getEmailFromToken(credential.accessToken)
        };
    }

    /**
     * 查询所有账户用量
     */
    async getAllQuotas() {
        const credentials = await this.store.getAllActive();
        const results = [];

        for (const cred of credentials) {
            try {
                const accessToken = await this.getValidAccessToken(cred);
                const quota = await getRequestLimit(accessToken);
                results.push({
                    ...quota,
                    credentialId: cred.id,
                    credentialName: cred.name,
                    email: getEmailFromToken(cred.accessToken)
                });
            } catch (error) {
                results.push({
                    credentialId: cred.id,
                    credentialName: cred.name,
                    email: getEmailFromToken(cred.accessToken),
                    error: error.message
                });
            }
        }

        return results;
    }

    /**
     * 发送对话请求（带自动故障转移）
     * 如果当前账号失败，自动尝试其他可用账号
     */
    async chatWithFailover(query, model = 'claude-4.1-opus', maxRetries = 3) {
        const triedIds = new Set();
        let lastError = null;

        for (let i = 0; i < maxRetries; i++) {
            // 获取一个未尝试过的可用账号
            const credential = await this.store.getRandomActiveExcluding(Array.from(triedIds));
            if (!credential) {
                break;
            }

            triedIds.add(credential.id);

            try {
                const accessToken = await this.getValidAccessToken(credential);
                const warpResponse = await sendWarpRequest(query, accessToken, model);
                await this.store.incrementUseCount(credential.id);

                return {
                    response: warpResponse.text,
                    toolCalls: warpResponse.toolCalls,
                    credentialId: credential.id,
                    credentialName: credential.name,
                    retriesUsed: i
                };
            } catch (error) {
                lastError = error;
                await this.store.incrementErrorCount(credential.id, error.message);
                
                // 检查是否是额度耗尽错误
                const isQuotaError = error.message.includes('limit') || 
                                    error.message.includes('quota') ||
                                    error.message.includes('exceeded');
                
                if (isQuotaError) {
                    // 标记账号额度耗尽
                    await this.store.markQuotaExhausted(credential.id);
                }
                
                console.log(`[Warp] 账号 ${credential.name} 请求失败: ${error.message}, 尝试下一个账号...`);
            }
        }

        throw lastError || new Error('所有账号都请求失败');
    }

    /**
     * 流式对话请求（带自动故障转移）
     */
    async chatStreamWithFailover(query, model, onData, onEnd, onError, maxRetries = 3) {
        const triedIds = new Set();
        let usedCredentialId = null;

        const tryNext = async () => {
            const credential = await this.store.getRandomActiveExcluding(Array.from(triedIds));
            if (!credential) {
                onError(new Error('所有账号都请求失败'), usedCredentialId);
                return null;
            }

            triedIds.add(credential.id);
            usedCredentialId = credential.id;

            try {
                const accessToken = await this.getValidAccessToken(credential);
                await this.store.incrementUseCount(credential.id);

                return sendWarpStreamRequest(query, accessToken, model, 
                    (content) => onData(content, credential.id),
                    () => onEnd(credential.id),
                    async (error) => {
                        await this.store.incrementErrorCount(credential.id, error.message);
                        
                        if (triedIds.size < maxRetries) {
                            console.log(`[Warp] 账号 ${credential.name} 流式请求失败: ${error.message}, 尝试下一个账号...`);
                            tryNext();
                        } else {
                            onError(error, credential.id);
                        }
                    }
                );
            } catch (error) {
                await this.store.incrementErrorCount(credential.id, error.message);
                
                if (triedIds.size < maxRetries) {
                    console.log(`[Warp] 账号 ${credential.name} 初始化失败: ${error.message}, 尝试下一个账号...`);
                    return tryNext();
                } else {
                    onError(error, credential.id);
                    return null;
                }
            }
        };

        return tryNext();
    }
}

/**
 * 获取账户请求额度
 */
export async function getRequestLimit(accessToken) {
    const query = `query GetRequestLimitInfo($requestContext: RequestContext!) {
  user(requestContext: $requestContext) {
    __typename
    ... on UserOutput {
      user {
        requestLimitInfo {
          isUnlimited
          nextRefreshTime
          requestLimit
          requestsUsedSinceLastRefresh
          requestLimitRefreshDuration
        }
      }
    }
    ... on UserFacingError {
      error {
        __typename
        message
      }
    }
  }
}`;

    const appVersion = 'v0.2026.01.14.08.15.stable_02';
    
    const data = {
        operationName: 'GetRequestLimitInfo',
        variables: {
            requestContext: {
                clientContext: { version: appVersion },
                osContext: {
                    category: 'macOS',
                    linuxKernelVersion: null,
                    name: 'macOS',
                    version: '15.7.2'
                }
            }
        },
        query: query
    };

    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(data);
        
        const options = {
            hostname: 'app.warp.dev',
            port: 443,
            path: '/graphql/v2?op=GetRequestLimitInfo',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'authorization': `Bearer ${accessToken}`,
                'x-warp-client-id': 'warp-app',
                'x-warp-client-version': appVersion,
                'x-warp-os-category': 'macOS',
                'x-warp-os-name': 'macOS',
                'x-warp-os-version': '15.7.2'
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(responseData);
                    
                    if (result.errors) {
                        reject(new Error(`GraphQL 错误: ${result.errors[0].message}`));
                        return;
                    }
                    
                    const userData = result.data?.user;
                    
                    if (userData?.__typename === 'UserOutput') {
                        const limitInfo = userData.user?.requestLimitInfo;
                        
                        if (limitInfo) {
                            resolve({
                                requestLimit: limitInfo.requestLimit || 0,
                                requestsUsed: limitInfo.requestsUsedSinceLastRefresh || 0,
                                requestsRemaining: (limitInfo.requestLimit || 0) - (limitInfo.requestsUsedSinceLastRefresh || 0),
                                isUnlimited: limitInfo.isUnlimited || false,
                                nextRefreshTime: limitInfo.nextRefreshTime || null,
                                refreshDuration: limitInfo.requestLimitRefreshDuration || 'WEEKLY'
                            });
                        } else {
                            reject(new Error('未找到额度信息'));
                        }
                    } else if (userData?.__typename === 'UserFacingError') {
                        reject(new Error(userData.error?.message || '用户错误'));
                    } else {
                        reject(new Error('未知响应格式'));
                    }
                } catch (e) {
                    reject(new Error(`解析响应失败: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ==================== Protobufjs 模块导出 ====================
// 新的 protobufjs 实现通过以下模块提供：
// - warp-proto.js: Proto 加载器和编解码函数
// - warp-tool-mapper.js: Claude <-> Warp 工具映射
// - warp-message-converter.js: Claude <-> Warp 消息转换
//
// 使用方法：
// import { loadProtos, encodeRequest, decodeResponseEvent } from './warp-proto.js';
// import { buildWarpRequest, parseWarpResponseEvent } from './warp-message-converter.js';
//
// 新端点 /w/v1/messages/proto 使用 protobufjs 实现
