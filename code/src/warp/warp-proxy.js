/**
 * Warp Multi-Agent API 完整转发代理
 * 
 * 功能：
 * 1. 一比一转发 Warp 的 /ai/multi-agent 请求
 * 2. 支持多轮对话（通过会话历史累积）
 * 3. 支持工具调用循环（自动提交工具结果）
 * 4. 支持 MCP 协议
 * 
 * 协议说明：
 * - 请求: POST /ai/multi-agent, Content-Type: application/x-protobuf
 * - 响应: text/event-stream (SSE + Base64 编码的 Protobuf)
 * - 多轮对话: 每次请求包含完整的会话历史 (field 1.1.5 数组)
 * - 工具调用: AI 响应中包含 tool_call (field 4), 客户端执行后通过 field 5 返回结果
 */

import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

// ==================== Protobuf 编码工具 ====================

function encodeVarint(value) {
    const bytes = [];
    let v = typeof value === 'bigint' ? value : BigInt(value);
    do {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        if (v > 0n) byte |= 0x80;
        bytes.push(byte);
    } while (v > 0n);
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

function encodeFixed64(fieldNum, value) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value), 0);
    return encodeField(fieldNum, 1, buf);
}

// ==================== 消息结构定义 ====================

/**
 * 消息类型枚举
 */
const MessageType = {
    SYSTEM_INIT: 'system_init',           // field 4 - 系统初始化消息
    STATUS: 'status',                      // field 6 - 状态消息
    USER_QUERY: 'user_query',              // field 2 - 用户查询
    ASSISTANT_TEXT: 'assistant_text',      // field 3 - 助手文本响应
    TOOL_CALL: 'tool_call',                // field 4 - 工具调用请求
    TOOL_RESULT: 'tool_result',            // field 5 - 工具执行结果
    REASONING: 'reasoning',                // field 15 - 推理/思考
};

/**
 * 会话消息
 */
class Message {
    constructor(type, id = uuidv4()) {
        this.id = id;
        this.type = type;
        this.timestamp = Date.now();
        this.cascadeId = null;
        this.turnId = null;
    }
}

/**
 * 用户查询消息
 */
class UserQueryMessage extends Message {
    constructor(content, context = {}, id = uuidv4()) {
        super(MessageType.USER_QUERY, id);
        this.content = content;
        this.context = context;  // 包含 workingDir, homeDir, shell 等
    }
    
    encode(cascadeId, turnId) {
        const timestamp = Math.floor(this.timestamp / 1000);
        const nanos = (this.timestamp % 1000) * 1000000;
        
        // 构建环境上下文 (field 2)
        const envContext = Buffer.concat([
            encodeMessage(1, Buffer.concat([
                encodeString(1, this.context.workingDir || '/tmp'),
                encodeString(2, this.context.homeDir || '/tmp'),
                encodeVarintField(3, 1)
            ])),
            encodeMessage(2, encodeMessage(1, encodeFixed32(9, 0x534f6361))),
            encodeMessage(3, Buffer.concat([
                encodeString(1, this.context.shell || 'zsh'),
                encodeString(2, this.context.shellVersion || '5.9')
            ])),
            encodeMessage(4, Buffer.concat([
                encodeVarintField(1, timestamp),
                encodeVarintField(2, nanos)
            ])),
            ...(this.context.repoName ? [encodeMessage(8, Buffer.concat([
                encodeString(1, this.context.repoName),
                encodeString(2, this.context.workingDir || '/tmp')
            ]))] : []),
            ...(this.context.gitBranch ? [encodeMessage(11, encodeString(1, this.context.gitBranch))] : [])
        ]);
        
        // 构建查询内容 (field 1)
        const queryContent = Buffer.concat([
            encodeString(1, this.content),
            encodeMessage(2, envContext),
            encodeString(4, ''),
            encodeVarintField(5, 1)
        ]);
        
        // 构建完整消息 (field 5 中的 field 2)
        return encodeMessage(5, Buffer.concat([
            encodeString(1, this.id),
            encodeMessage(2, queryContent),
            this._encodeServerData(cascadeId, turnId),
            encodeString(11, cascadeId),
            encodeString(13, turnId),
            encodeMessage(14, Buffer.concat([
                encodeVarintField(1, timestamp),
                encodeVarintField(2, nanos)
            ]))
        ]));
    }
    
    _encodeServerData(cascadeId, turnId) {
        const timestamp = Math.floor(this.timestamp / 1000);
        const nanos = (this.timestamp % 1000) * 1000000;
        const serverData = Buffer.concat([
            encodeVarintField(1, timestamp),
            encodeVarintField(2, nanos)
        ]);
        return encodeBytes(7, Buffer.from(serverData.toString('base64')));
    }
}

/**
 * 助手文本响应消息
 */
class AssistantTextMessage extends Message {
    constructor(content, id = uuidv4()) {
        super(MessageType.ASSISTANT_TEXT, id);
        this.content = content;
    }
    
    encode(cascadeId, turnId) {
        const timestamp = Math.floor(this.timestamp / 1000);
        const nanos = (this.timestamp % 1000) * 1000000;
        
        return encodeMessage(5, Buffer.concat([
            encodeString(1, this.id),
            encodeMessage(3, encodeString(1, this.content)),
            this._encodeServerData(cascadeId, turnId),
            encodeString(11, cascadeId),
            encodeString(13, turnId),
            encodeMessage(14, Buffer.concat([
                encodeVarintField(1, timestamp),
                encodeVarintField(2, nanos)
            ]))
        ]));
    }
    
    _encodeServerData(cascadeId, turnId) {
        const timestamp = Math.floor(this.timestamp / 1000);
        const nanos = (this.timestamp % 1000) * 1000000;
        const serverData = Buffer.concat([
            encodeString(1, uuidv4()),
            encodeVarintField(1, timestamp),
            encodeVarintField(2, nanos)
        ]);
        return encodeBytes(7, Buffer.from(serverData.toString('base64')));
    }
}

/**
 * 工具调用请求消息
 */
class ToolCallMessage extends Message {
    constructor(callId, toolName, params = {}, id = uuidv4()) {
        super(MessageType.TOOL_CALL, id);
        this.callId = callId;      // 如 "call_eUhKl67rXZNARIHAiux5wcNl"
        this.toolName = toolName;  // 如 "ls", "cat", "grep"
        this.params = params;      // 工具参数
    }
    
    encode(cascadeId, turnId) {
        const timestamp = Math.floor(this.timestamp / 1000);
        const nanos = (this.timestamp % 1000) * 1000000;
        
        // 工具调用内容 (field 4 中的 field 2)
        const toolContent = Buffer.concat([
            encodeString(1, this.toolName),
            encodeVarintField(2, 1),  // mode = wait
            encodeVarintField(6, 0)   // is_read_only = false
        ]);
        
        return encodeMessage(5, Buffer.concat([
            encodeString(1, this.id),
            encodeMessage(4, Buffer.concat([
                encodeString(1, this.callId),
                encodeMessage(2, toolContent)
            ])),
            this._encodeServerData(cascadeId, turnId),
            encodeString(11, cascadeId),
            encodeString(13, turnId),
            encodeMessage(14, Buffer.concat([
                encodeVarintField(1, timestamp),
                encodeVarintField(2, nanos)
            ]))
        ]));
    }
    
    _encodeServerData(cascadeId, turnId) {
        // 这里可以添加更多服务器数据
        return encodeBytes(7, Buffer.from(''));
    }
}

/**
 * 工具执行结果消息
 */
class ToolResultMessage extends Message {
    constructor(callId, command, output, context = {}, id = uuidv4()) {
        super(MessageType.TOOL_RESULT, id);
        this.callId = callId;
        this.command = command;
        this.output = output;
        this.context = context;
        this.precmdId = `precmd-${Date.now()}-${Math.floor(Math.random() * 10)}`;
    }
    
    encode(cascadeId, turnId) {
        const timestamp = Math.floor(this.timestamp / 1000);
        const nanos = (this.timestamp % 1000) * 1000000;
        
        // 工具结果内容 (field 5 中的 field 2)
        const resultContent = Buffer.concat([
            encodeString(3, this.command),
            encodeMessage(5, Buffer.concat([
                encodeString(1, this.output),
                encodeString(3, this.precmdId)
            ]))
        ]);
        
        // 环境上下文
        const envContext = Buffer.concat([
            encodeMessage(1, Buffer.concat([
                encodeString(1, this.context.workingDir || '/tmp'),
                encodeString(2, this.context.homeDir || '/tmp'),
                encodeVarintField(3, 1)
            ])),
            encodeMessage(2, encodeMessage(1, encodeFixed32(9, 0x534f6361))),
            encodeMessage(3, Buffer.concat([
                encodeString(1, this.context.shell || 'zsh'),
                encodeString(2, this.context.shellVersion || '5.9')
            ])),
            encodeMessage(4, Buffer.concat([
                encodeVarintField(1, timestamp),
                encodeVarintField(2, nanos)
            ])),
            ...(this.context.repoName ? [encodeMessage(8, Buffer.concat([
                encodeString(1, this.context.repoName),
                encodeString(2, this.context.workingDir || '/tmp')
            ]))] : []),
            ...(this.context.gitBranch ? [encodeMessage(11, encodeString(1, this.context.gitBranch))] : [])
        ]);
        
        return encodeMessage(5, Buffer.concat([
            encodeString(1, this.id),
            encodeMessage(5, Buffer.concat([
                encodeString(1, this.callId),
                encodeMessage(2, resultContent),
                encodeMessage(11, envContext)
            ])),
            this._encodeServerData(cascadeId, turnId),
            encodeString(11, cascadeId),
            encodeString(13, turnId),
            encodeMessage(14, Buffer.concat([
                encodeVarintField(1, timestamp),
                encodeVarintField(2, nanos)
            ]))
        ]));
    }
    
    _encodeServerData(cascadeId, turnId) {
        const timestamp = Math.floor(this.timestamp / 1000);
        const nanos = (this.timestamp % 1000) * 1000000;
        const serverData = Buffer.concat([
            encodeVarintField(1, timestamp),
            encodeVarintField(2, nanos)
        ]);
        return encodeBytes(7, Buffer.from(serverData.toString('base64')));
    }
}

/**
 * 推理/思考消息
 */
class ReasoningMessage extends Message {
    constructor(content, usage = { inputTokens: 0, outputTokens: 0 }, id = uuidv4()) {
        super(MessageType.REASONING, id);
        this.content = content;
        this.usage = usage;
    }
    
    encode(cascadeId, turnId) {
        const timestamp = Math.floor(this.timestamp / 1000);
        const nanos = (this.timestamp % 1000) * 1000000;
        
        return encodeMessage(5, Buffer.concat([
            encodeString(1, this.id),
            encodeMessage(15, Buffer.concat([
                encodeString(1, this.content),
                encodeMessage(2, Buffer.concat([
                    encodeVarintField(1, this.usage.inputTokens),
                    encodeVarintField(2, this.usage.outputTokens)
                ]))
            ])),
            this._encodeServerData(cascadeId, turnId),
            encodeString(11, cascadeId),
            encodeString(13, turnId),
            encodeMessage(14, Buffer.concat([
                encodeVarintField(1, timestamp),
                encodeVarintField(2, nanos)
            ]))
        ]));
    }
    
    _encodeServerData(cascadeId, turnId) {
        return encodeBytes(7, Buffer.from(''));
    }
}

// ==================== 会话管理 ====================

/**
 * 会话状态
 */
class Session {
    constructor(id = uuidv4()) {
        this.id = id;
        this.cascadeId = uuidv4();
        this.turnId = uuidv4();
        this.title = '';
        this.messages = [];
        this.context = {
            workingDir: process.cwd(),
            homeDir: process.env.HOME || '/tmp',
            shell: 'zsh',
            shellVersion: '5.9',
            repoName: '',
            gitBranch: 'master'
        };
        this.model = 'claude-4.1-opus';
        this.createdAt = new Date();
        this.updatedAt = new Date();
    }
    
    addMessage(message) {
        message.cascadeId = this.cascadeId;
        message.turnId = this.turnId;
        this.messages.push(message);
        this.updatedAt = new Date();
    }
    
    /**
     * 开始新的轮次（用户发送新消息时）
     */
    newTurn() {
        this.turnId = uuidv4();
    }
    
    /**
     * 编码所有消息为 Protobuf
     */
    encodeMessages() {
        return Buffer.concat(
            this.messages.map(msg => msg.encode(this.cascadeId, this.turnId))
        );
    }
}

// ==================== Warp 请求构建 ====================

/**
 * 构建完整的 Warp 请求体
 */
function buildWarpRequest(session, userQuery = null, model = 'claude-4.1-opus') {
    const timestamp = Math.floor(Date.now() / 1000);
    const nanos = (Date.now() % 1000) * 1000000;
    
    // Field 1: Cascade 信息
    const cascadeInfo = Buffer.concat([
        encodeString(1, session.cascadeId),
        encodeString(2, session.title || 'Chat'),
        // Field 5: 消息数组
        session.encodeMessages(),
        // Field 8: 模型信息（base64 编码）
        encodeBytes(8, Buffer.from(`\x0a\x15${model}`))
    ]);
    
    // Field 2: 当前环境和用户查询
    const envInfo = Buffer.concat([
        encodeMessage(1, Buffer.concat([
            encodeString(1, session.context.workingDir),
            encodeString(2, session.context.homeDir),
            encodeVarintField(3, 1)
        ])),
        encodeMessage(2, encodeMessage(1, encodeFixed32(9, 0x534f6361))),
        encodeMessage(3, Buffer.concat([
            encodeString(1, session.context.shell),
            encodeString(2, session.context.shellVersion)
        ])),
        encodeMessage(4, Buffer.concat([
            encodeVarintField(1, timestamp),
            encodeVarintField(2, nanos)
        ])),
        ...(session.context.repoName ? [encodeMessage(8, Buffer.concat([
            encodeString(1, session.context.repoName),
            encodeString(2, session.context.workingDir)
        ]))] : []),
        ...(session.context.gitBranch ? [encodeMessage(11, encodeString(1, session.context.gitBranch))] : [])
    ]);
    
    // Field 2.6: 用户查询（如果是新查询）
    let field2Content;
    if (userQuery) {
        const queryContent = Buffer.concat([
            encodeString(1, userQuery),
            encodeString(3, ''),
            encodeVarintField(4, 1)
        ]);
        field2Content = Buffer.concat([
            encodeMessage(1, envInfo),
            encodeMessage(6, encodeMessage(1, encodeMessage(1, queryContent)))
        ]);
    } else {
        field2Content = encodeMessage(1, envInfo);
    }
    
    // Field 3: 模型配置
    const modelConfig = Buffer.concat([
        encodeMessage(1, Buffer.concat([
            encodeString(1, model),
            encodeString(4, 'cli-agent-auto')
        ])),
        encodeVarintField(2, 1),
        encodeVarintField(3, 1),
        encodeVarintField(4, 1),
        encodeVarintField(6, 1),
        encodeVarintField(7, 1),
        encodeVarintField(8, 1),
        encodeBytes(9, Buffer.from([0x06, 0x07, 0x0c, 0x08, 0x09, 0x0f, 0x0e, 0x00, 0x0b, 0x10, 0x0a, 0x14, 0x11, 0x13, 0x12, 0x02, 0x03, 0x01, 0x0d])),
        encodeVarintField(10, 1),
        encodeVarintField(11, 1),
        encodeVarintField(12, 1),
        encodeVarintField(13, 1),
        encodeVarintField(14, 1),
        encodeVarintField(15, 1),
        encodeVarintField(16, 1),
        encodeVarintField(17, 1),
        encodeVarintField(21, 1),
        encodeBytes(22, Buffer.from([0x0a, 0x14, 0x06, 0x07, 0x0c, 0x02, 0x01])),
        encodeVarintField(23, 1)
    ]);
    
    // Field 4: 元数据
    const metadata = Buffer.concat([
        encodeString(1, session.id),
        encodeMessage(2, Buffer.concat([
            encodeString(1, 'entrypoint'),
            encodeMessage(2, encodeMessage(3, Buffer.concat([
                encodeFixed64(10, 0x5f524553n),
                encodeFixed64(9, 0x444554414954494en)
            ])))
        ])),
        encodeMessage(2, Buffer.concat([
            encodeString(1, 'is_auto_resume_after_error'),
            encodeMessage(2, encodeVarintField(4, 0))
        ])),
        encodeMessage(2, Buffer.concat([
            encodeString(1, 'is_autodetected_user_query'),
            encodeMessage(2, encodeVarintField(4, 1))
        ]))
    ]);
    
    // 组合完整请求
    return Buffer.concat([
        encodeMessage(1, cascadeInfo),
        encodeMessage(2, field2Content),
        encodeMessage(3, modelConfig),
        encodeMessage(4, metadata)
    ]);
}

// ==================== 响应解析 ====================

/**
 * 解析 SSE 响应中的事件
 */
function parseSSEEvent(line) {
    if (!line.startsWith('data:')) return null;
    const data = line.substring(5).trim();
    if (!data) return null;
    
    try {
        return Buffer.from(data, 'base64');
    } catch {
        return null;
    }
}

/**
 * 从 Protobuf 响应中提取文本内容
 */
function extractAgentText(buffer) {
    const texts = [];
    
    // 查找 agent_output.text 标记
    const bufferStr = buffer.toString('utf8');
    if (!bufferStr.includes('agent_output')) {
        return null;
    }
    
    // 使用嵌套解析提取文本
    for (let i = 0; i < buffer.length - 4; i++) {
        if (buffer[i] === 0x1a) {  // Length-delimited field
            const outerLen = buffer[i + 1];
            if (outerLen > 2 && outerLen < 200 && buffer[i + 2] === 0x0a) {
                const innerLen = buffer[i + 3];
                if (innerLen > 0 && innerLen <= outerLen - 2 && i + 4 + innerLen <= buffer.length) {
                    const text = buffer.slice(i + 4, i + 4 + innerLen).toString('utf8');
                    
                    // 过滤
                    if (text.length === 0) continue;
                    if (text.length === 36 && /^[0-9a-f-]{36}$/.test(text)) continue;
                    if (text.includes('agent_') || text.includes('server_') ||
                        text.includes('USER_') || text.includes('primary_') ||
                        text.includes('call_') || text.includes('precmd-')) continue;
                    
                    // 检查是否有可见内容
                    const hasChinese = /[\u4e00-\u9fff]/.test(text);
                    const hasAlpha = /[a-zA-Z0-9]/.test(text);
                    
                    if (hasChinese || hasAlpha) {
                        if (!/^[A-Za-z0-9+/=]+$/.test(text) || text.length < 20) {
                            texts.push(text);
                        }
                    }
                }
            }
        }
    }
    
    return texts.length > 0 ? texts.join('') : null;
}

/**
 * 从响应中提取工具调用
 */
function extractToolCall(buffer) {
    const bufferStr = buffer.toString('utf8');
    
    // 检查是否包含工具调用标识
    if (!bufferStr.includes('call_')) return null;
    
    // 提取 call_id
    const callIdMatch = bufferStr.match(/call_[A-Za-z0-9]+/);
    if (!callIdMatch) return null;
    
    const callId = callIdMatch[0];
    
    // 提取命令
    const cmdMatch = bufferStr.match(/\x0a\x02ls|\x0a\x03cat|\x0a\x04grep|\x0a\x04find/);
    let command = 'ls';
    if (cmdMatch) {
        command = cmdMatch[0].slice(2);
    }
    
    return { callId, command };
}

/**
 * 从响应中提取推理内容
 */
function extractReasoning(buffer) {
    const bufferStr = buffer.toString('utf8');
    
    if (!bufferStr.includes('agent_reasoning')) return null;
    
    // 提取推理文本
    const texts = [];
    for (let i = 0; i < buffer.length - 4; i++) {
        if (buffer[i] === 0x1a) {
            const outerLen = buffer[i + 1];
            if (outerLen > 2 && outerLen < 200 && buffer[i + 2] === 0x0a) {
                const innerLen = buffer[i + 3];
                if (innerLen > 0 && innerLen <= outerLen - 2 && i + 4 + innerLen <= buffer.length) {
                    const text = buffer.slice(i + 4, i + 4 + innerLen).toString('utf8');
                    if (text.length > 0 && !text.includes('agent_') && !text.includes('call_')) {
                        texts.push(text);
                    }
                }
            }
        }
    }
    
    return texts.length > 0 ? texts.join('') : null;
}

// ==================== Warp 代理服务 ====================

/**
 * Warp 代理服务
 */
export class WarpProxy extends EventEmitter {
    constructor(options = {}) {
        super();
        this.accessToken = options.accessToken;
        this.sessions = new Map();
        this.maxIterations = options.maxIterations || 20;
        this.autoExecuteTools = options.autoExecuteTools !== false;
        
        // 工具处理器
        this.toolHandlers = {
            ls: this._handleLs.bind(this),
            cat: this._handleCat.bind(this),
            grep: this._handleGrep.bind(this),
            find: this._handleFind.bind(this),
            run_shell_command: this._handleShell.bind(this)
        };
    }
    
    /**
     * 创建新会话
     */
    createSession(context = {}) {
        const session = new Session();
        Object.assign(session.context, context);
        this.sessions.set(session.id, session);
        return session;
    }
    
    /**
     * 获取会话
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    
    /**
     * 发送请求到 Warp
     */
    async sendRequest(session, userQuery = null, model = 'claude-4.1-opus') {
        const body = buildWarpRequest(session, userQuery, model);
        
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'app.warp.dev',
                port: 443,
                path: '/ai/multi-agent',
                method: 'POST',
                headers: {
                    'x-warp-client-id': 'warp-app',
                    'x-warp-client-version': 'v0.2026.01.14.08.15.stable_04',
                    'x-warp-os-category': 'macOS',
                    'x-warp-os-name': 'macOS',
                    'x-warp-os-version': '15.7.2',
                    'content-type': 'application/x-protobuf',
                    'accept': 'text/event-stream',
                    'accept-encoding': 'identity',
                    'authorization': `Bearer ${this.accessToken}`,
                    'content-length': body.length
                }
            };
            
            const req = https.request(options, (res) => {
                if (res.statusCode !== 200) {
                    let errorData = '';
                    res.on('data', chunk => errorData += chunk);
                    res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errorData}`)));
                    return;
                }
                
                let fullText = '';
                let toolCalls = [];
                let reasoning = '';
                let buffer = '';
                
                res.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    
                    for (const line of lines) {
                        if (line.startsWith('event:')) continue;
                        
                        const decoded = parseSSEEvent(line);
                        if (!decoded) continue;
                        
                        // 提取文本
                        const text = extractAgentText(decoded);
                        if (text) {
                            fullText += text;
                            this.emit('text', text);
                        }
                        
                        // 提取工具调用
                        const toolCall = extractToolCall(decoded);
                        if (toolCall && !toolCalls.find(t => t.callId === toolCall.callId)) {
                            toolCalls.push(toolCall);
                            this.emit('tool_call', toolCall);
                        }
                        
                        // 提取推理
                        const reasoningText = extractReasoning(decoded);
                        if (reasoningText) {
                            reasoning += reasoningText;
                            this.emit('reasoning', reasoningText);
                        }
                    }
                });
                
                res.on('end', () => {
                    resolve({
                        text: fullText,
                        toolCalls,
                        reasoning
                    });
                });
                
                res.on('error', reject);
            });
            
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
    
    /**
     * 执行工具
     */
    async executeTool(toolName, params, context) {
        const handler = this.toolHandlers[toolName] || this.toolHandlers.run_shell_command;
        try {
            const result = await handler(params, context);
            return { success: true, output: result };
        } catch (error) {
            return { success: false, output: `错误: ${error.message}` };
        }
    }
    
    /**
     * 核心：多轮对话处理
     */
    async chat(sessionOrId, userQuery, options = {}) {
        // 获取或创建会话
        let session;
        if (typeof sessionOrId === 'string') {
            session = this.getSession(sessionOrId);
            if (!session) {
                session = this.createSession(options.context);
                session.id = sessionOrId;
                this.sessions.set(sessionOrId, session);
            }
        } else if (sessionOrId instanceof Session) {
            session = sessionOrId;
        } else {
            session = this.createSession(options.context);
        }
        
        const model = options.model || session.model || 'claude-4.1-opus';
        
        // 添加用户消息
        const userMsg = new UserQueryMessage(userQuery, session.context);
        session.addMessage(userMsg);
        session.newTurn();
        
        let iteration = 0;
        let finalResponse = '';
        const allToolCalls = [];
        
        while (iteration < this.maxIterations) {
            iteration++;
            
            this.emit('iteration_start', { iteration, sessionId: session.id });
            
            // 发送请求
            const response = await this.sendRequest(
                session,
                iteration === 1 ? userQuery : null,
                model
            );
            
            // 添加助手响应
            if (response.text) {
                const assistantMsg = new AssistantTextMessage(response.text);
                session.addMessage(assistantMsg);
                finalResponse = response.text;
            }
            
            // 检查是否有工具调用
            if (response.toolCalls.length > 0 && this.autoExecuteTools) {
                for (const toolCall of response.toolCalls) {
                    this.emit('tool_executing', toolCall);
                    
                    // 执行工具
                    const result = await this.executeTool(
                        toolCall.command,
                        { command: toolCall.command },
                        session.context
                    );
                    
                    // 添加工具结果到会话
                    const toolResultMsg = new ToolResultMessage(
                        toolCall.callId,
                        toolCall.command,
                        result.output,
                        session.context
                    );
                    session.addMessage(toolResultMsg);
                    
                    allToolCalls.push({
                        ...toolCall,
                        result: result.output
                    });
                    
                    this.emit('tool_result', { toolCall, result });
                }
                
                // 继续循环，让 AI 处理工具结果
                continue;
            }
            
            // 没有工具调用，完成
            this.emit('complete', {
                sessionId: session.id,
                response: finalResponse,
                toolCalls: allToolCalls,
                iterations: iteration
            });
            
            return {
                sessionId: session.id,
                response: finalResponse,
                toolCalls: allToolCalls,
                iterations: iteration
            };
        }
        
        // 达到最大迭代次数
        this.emit('max_iterations', { sessionId: session.id, iterations: iteration });
        
        return {
            sessionId: session.id,
            response: finalResponse,
            toolCalls: allToolCalls,
            iterations: iteration,
            maxIterationsReached: true
        };
    }
    
    /**
     * 流式对话
     */
    async *chatStream(sessionOrId, userQuery, options = {}) {
        // 获取或创建会话
        let session;
        if (typeof sessionOrId === 'string') {
            session = this.getSession(sessionOrId) || this.createSession(options.context);
        } else if (sessionOrId instanceof Session) {
            session = sessionOrId;
        } else {
            session = this.createSession(options.context);
        }
        
        const model = options.model || session.model || 'claude-4.1-opus';
        
        // 添加用户消息
        const userMsg = new UserQueryMessage(userQuery, session.context);
        session.addMessage(userMsg);
        session.newTurn();
        
        let iteration = 0;
        
        while (iteration < this.maxIterations) {
            iteration++;
            
            yield { type: 'iteration_start', iteration, sessionId: session.id };
            
            const body = buildWarpRequest(
                session,
                iteration === 1 ? userQuery : null,
                model
            );
            
            // 流式请求
            const response = await this._streamRequest(body);
            
            for await (const event of response) {
                yield event;
                
                // 处理工具调用
                if (event.type === 'tool_call' && this.autoExecuteTools) {
                    yield { type: 'tool_executing', ...event };
                    
                    const result = await this.executeTool(
                        event.command,
                        { command: event.command },
                        session.context
                    );
                    
                    // 添加工具结果
                    const toolResultMsg = new ToolResultMessage(
                        event.callId,
                        event.command,
                        result.output,
                        session.context
                    );
                    session.addMessage(toolResultMsg);
                    
                    yield { type: 'tool_result', callId: event.callId, result };
                }
            }
            
            // 检查是否需要继续
            if (!response.hasToolCalls) {
                yield { type: 'complete', sessionId: session.id, iterations: iteration };
                return;
            }
        }
        
        yield { type: 'max_iterations', sessionId: session.id, iterations: iteration };
    }
    
    /**
     * 内部流式请求
     */
    async *_streamRequest(body) {
        // 简化版本，返回 async generator
        const response = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'app.warp.dev',
                port: 443,
                path: '/ai/multi-agent',
                method: 'POST',
                headers: {
                    'x-warp-client-id': 'warp-app',
                    'x-warp-client-version': 'v0.2026.01.14.08.15.stable_04',
                    'x-warp-os-category': 'macOS',
                    'x-warp-os-name': 'macOS',
                    'x-warp-os-version': '15.7.2',
                    'content-type': 'application/x-protobuf',
                    'accept': 'text/event-stream',
                    'accept-encoding': 'identity',
                    'authorization': `Bearer ${this.accessToken}`,
                    'content-length': body.length
                }
            };
            
            const req = https.request(options, resolve);
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        
        let hasToolCalls = false;
        let buffer = '';
        
        for await (const chunk of response) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.startsWith('event:')) continue;
                
                const decoded = parseSSEEvent(line);
                if (!decoded) continue;
                
                const text = extractAgentText(decoded);
                if (text) {
                    yield { type: 'text', content: text };
                }
                
                const toolCall = extractToolCall(decoded);
                if (toolCall) {
                    hasToolCalls = true;
                    yield { type: 'tool_call', ...toolCall };
                }
                
                const reasoning = extractReasoning(decoded);
                if (reasoning) {
                    yield { type: 'reasoning', content: reasoning };
                }
            }
        }
        
        // 标记是否有工具调用
        response.hasToolCalls = hasToolCalls;
    }
    
    // ==================== 工具处理器 ====================
    
    async _handleLs(params, context) {
        const cwd = context?.workingDir || process.cwd();
        const { stdout } = await execAsync('ls', { cwd });
        return stdout;
    }
    
    async _handleCat(params, context) {
        const file = params.file || params.path;
        const content = await fs.readFile(file, 'utf-8');
        return content;
    }
    
    async _handleGrep(params, context) {
        const pattern = params.pattern || params.query;
        const path = params.path || '.';
        const { stdout } = await execAsync(`grep -rn "${pattern}" "${path}" | head -50`, {
            cwd: context?.workingDir || process.cwd()
        });
        return stdout || '未找到匹配';
    }
    
    async _handleFind(params, context) {
        const pattern = params.pattern || '*';
        const path = params.path || '.';
        const { stdout } = await execAsync(`find "${path}" -name "${pattern}" | head -50`, {
            cwd: context?.workingDir || process.cwd()
        });
        return stdout || '未找到文件';
    }
    
    async _handleShell(params, context) {
        const command = params.command || 'echo "no command"';
        const cwd = context?.workingDir || process.cwd();
        const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout: 30000,
            env: { ...process.env, PAGER: 'cat' }
        });
        return stdout || stderr || '(无输出)';
    }
}

// ==================== Express 路由 ====================

export function setupWarpProxyRoutes(app, warpStore) {
    const proxies = new Map();
    
    /**
     * 获取代理实例
     */
    async function getProxy(credentialId) {
        if (proxies.has(credentialId)) {
            return proxies.get(credentialId);
        }
        
        const credential = credentialId 
            ? await warpStore.getById(credentialId)
            : await warpStore.getRandomActive();
            
        if (!credential) {
            throw new Error('没有可用的凭证');
        }
        
        // 检查 token 是否需要刷新
        const { refreshAccessToken, isTokenExpired } = await import('./warp-service.js');
        let accessToken = credential.accessToken;
        
        if (!accessToken || isTokenExpired(accessToken)) {
            const result = await refreshAccessToken(credential.refreshToken);
            accessToken = result.accessToken;
            await warpStore.updateToken(credential.id, accessToken, new Date(Date.now() + result.expiresIn * 1000));
        }
        
        const proxy = new WarpProxy({ accessToken });
        proxies.set(credential.id, proxy);
        return proxy;
    }
    
    /**
     * 非流式对话
     */
    app.post('/api/warp/proxy/chat', async (req, res) => {
        try {
            const { query, sessionId, model, context, credentialId } = req.body;
            
            if (!query) {
                return res.status(400).json({ error: 'query is required' });
            }
            
            const proxy = await getProxy(credentialId);
            const result = await proxy.chat(sessionId, query, { model, context });
            
            await warpStore.incrementUseCount(credentialId || 1);
            
            res.json({ success: true, ...result });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    /**
     * 流式对话
     */
    app.post('/api/warp/proxy/stream', async (req, res) => {
        const { query, sessionId, model, context, credentialId } = req.body;
        
        if (!query) {
            return res.status(400).json({ error: 'query is required' });
        }
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        try {
            const proxy = await getProxy(credentialId);
            
            for await (const event of proxy.chatStream(sessionId, query, { model, context })) {
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            
            await warpStore.incrementUseCount(credentialId || 1);
            res.end();
        } catch (error) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    });
    
    /**
     * 会话管理
     */
    app.get('/api/warp/proxy/sessions', async (req, res) => {
        const { credentialId } = req.query;
        const proxy = await getProxy(credentialId);
        
        const sessions = Array.from(proxy.sessions.values()).map(s => ({
            id: s.id,
            title: s.title,
            messageCount: s.messages.length,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt
        }));
        
        res.json({ success: true, sessions });
    });
    
    app.delete('/api/warp/proxy/sessions/:id', async (req, res) => {
        const { credentialId } = req.query;
        const proxy = await getProxy(credentialId);
        
        proxy.sessions.delete(req.params.id);
        res.json({ success: true });
    });
    
    console.log('[WarpProxy] 路由已设置');
    console.log('[WarpProxy] 端点:');
    console.log('[WarpProxy]   POST /api/warp/proxy/chat - 非流式对话');
    console.log('[WarpProxy]   POST /api/warp/proxy/stream - 流式对话');
    console.log('[WarpProxy]   GET /api/warp/proxy/sessions - 获取会话列表');
}

export default WarpProxy;
