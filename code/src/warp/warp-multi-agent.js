/**
 * Warp 多代理循环系统
 * 
 * 基于 Warp API 实现的多代理循环，模拟 Warp 终端的 AI 代理行为
 * 
 * 工作流程：
 * 1. 用户提问 → 发送到 Warp AI
 * 2. AI 返回响应（可能包含工具调用请求）
 * 3. 本地执行工具 → 将结果回传给 AI
 * 4. 循环直到 AI 返回最终答案
 */

import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import https from 'https';
import { 
    refreshAccessToken, 
    isTokenExpired, 
    mapModelToWarp,
    sendWarpRequest
} from './warp-service.js';

const execAsync = promisify(exec);

// ==================== Protobuf 编码工具 ====================

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

// ==================== 工具定义 ====================

const TOOLS = {
    list_dir: {
        name: 'list_dir',
        description: '列出目录内容',
        handler: async (params) => {
            const targetPath = params.path || params.DirectoryPath || '.';
            const files = await fs.readdir(targetPath, { withFileTypes: true });
            return files.map(f => `${f.isDirectory() ? '[DIR]' : '[FILE]'} ${f.name}`).join('\n');
        }
    },
    
    read_file: {
        name: 'read_file',
        description: '读取文件内容',
        handler: async (params) => {
            const filePath = params.path || params.file_path;
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            const limit = params.limit || 100;
            if (lines.length > limit) {
                return lines.slice(0, limit).join('\n') + `\n... (共 ${lines.length} 行)`;
            }
            return content;
        }
    },
    
    run_command: {
        name: 'run_command',
        aliases: ['run_shell_command', 'ls', 'cat', 'grep'],
        description: '执行 shell 命令',
        handler: async (params) => {
            const command = params.command || params.CommandLine || params.cmd || 'ls';
            const cwd = params.cwd || params.Cwd || process.cwd();
            try {
                const { stdout, stderr } = await execAsync(command, {
                    cwd,
                    timeout: 30000,
                    maxBuffer: 1024 * 1024,
                    env: { ...process.env, PAGER: 'cat' }
                });
                return stdout || stderr || '(无输出)';
            } catch (error) {
                return `错误: ${error.message}\n${error.stderr || ''}`;
            }
        }
    },
    
    grep_search: {
        name: 'grep_search',
        description: '搜索文件内容',
        handler: async (params) => {
            const pattern = params.pattern || params.Query;
            const searchPath = params.path || params.SearchPath || '.';
            try {
                const { stdout } = await execAsync(
                    `grep -rn "${pattern}" "${searchPath}" 2>/dev/null | head -30`,
                    { maxBuffer: 1024 * 1024 }
                );
                return stdout || '未找到匹配';
            } catch {
                return '未找到匹配';
            }
        }
    },
    
    find_by_name: {
        name: 'find_by_name',
        description: '按名称查找文件',
        handler: async (params) => {
            const pattern = params.pattern || params.Pattern || '*';
            const searchDir = params.path || params.SearchDirectory || '.';
            try {
                const { stdout } = await execAsync(
                    `find "${searchDir}" -name "${pattern}" 2>/dev/null | head -30`,
                    { maxBuffer: 1024 * 1024 }
                );
                return stdout || '未找到文件';
            } catch {
                return '未找到文件';
            }
        }
    }
};

// ==================== 会话管理 ====================

class ConversationSession {
    constructor(id, workingDir = process.cwd()) {
        this.id = id;
        this.cascadeId = uuidv4();
        this.workingDir = workingDir;
        this.messages = [];
        this.toolCalls = [];
        this.iteration = 0;
        this.createdAt = new Date();
    }
    
    addUserMessage(content) {
        this.messages.push({
            id: uuidv4(),
            role: 'user',
            content,
            timestamp: Date.now()
        });
    }
    
    addAssistantMessage(content, reasoning = null) {
        this.messages.push({
            id: uuidv4(),
            role: 'assistant',
            content,
            reasoning,
            timestamp: Date.now()
        });
    }
    
    addToolCall(toolName, params, result) {
        const toolCall = {
            id: uuidv4(),
            name: toolName,
            params,
            result,
            timestamp: Date.now()
        };
        this.toolCalls.push(toolCall);
        this.messages.push({
            id: toolCall.id,
            role: 'tool',
            name: toolName,
            content: result,
            timestamp: Date.now()
        });
        return toolCall;
    }
}

// ==================== Warp 多代理服务 ====================

export class WarpMultiAgentService {
    constructor(warpStore, options = {}) {
        this.warpStore = warpStore;
        this.sessions = new Map();
        this.maxIterations = options.maxIterations || 15;
        this.tools = { ...TOOLS, ...options.customTools };
        
        // 回调函数
        this.onThinking = options.onThinking;      // AI 思考中
        this.onToolCall = options.onToolCall;      // 工具调用
        this.onContent = options.onContent;        // 内容输出
        this.onComplete = options.onComplete;      // 完成
    }
    
    /**
     * 创建新会话
     */
    createSession(workingDir = process.cwd()) {
        const sessionId = uuidv4();
        const session = new ConversationSession(sessionId, workingDir);
        this.sessions.set(sessionId, session);
        return session;
    }
    
    /**
     * 获取会话
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    
    /**
     * 获取有效的 access token
     */
    async getValidAccessToken(credential) {
        if (credential.accessToken && !isTokenExpired(credential.accessToken)) {
            return credential.accessToken;
        }
        
        const result = await refreshAccessToken(credential.refreshToken);
        const expiresAt = new Date(Date.now() + result.expiresIn * 1000);
        await this.warpStore.updateToken(credential.id, result.accessToken, expiresAt);
        return result.accessToken;
    }
    
    /**
     * 构建 Warp 请求体（包含对话历史）
     */
    buildRequestBody(session, model = 'claude-4.1-opus') {
        const timestamp = Math.floor(Date.now() / 1000);
        const nanos = (Date.now() % 1000) * 1000000;
        
        // 基础路径信息
        const pathInfo = Buffer.concat([
            encodeString(1, session.workingDir),
            encodeString(2, process.env.HOME || '/tmp')
        ]);
        
        const osInfo = encodeMessage(1, encodeFixed32(9, 0x534f6361));
        const shellInfo = Buffer.concat([encodeString(1, "zsh"), encodeString(2, "5.9")]);
        const timestampInfo = Buffer.concat([
            encodeVarintField(1, timestamp),
            encodeVarintField(2, nanos)
        ]);
        
        // 构建对话历史
        const conversationParts = [];
        
        for (const msg of session.messages) {
            if (msg.role === 'user') {
                const queryContent = Buffer.concat([
                    encodeString(1, msg.content),
                    encodeString(3, ""),
                    encodeVarintField(4, 1)
                ]);
                conversationParts.push(encodeMessage(1, encodeMessage(1, queryContent)));
            } else if (msg.role === 'tool') {
                // 工具结果作为上下文
                const toolResult = Buffer.concat([
                    encodeString(1, `[工具 ${msg.name} 结果]\n${msg.content}`)
                ]);
                conversationParts.push(encodeMessage(2, toolResult));
            }
        }
        
        // 环境信息
        const field2_1 = Buffer.concat([
            encodeMessage(1, pathInfo),
            encodeMessage(2, osInfo),
            encodeMessage(3, shellInfo),
            encodeMessage(4, timestampInfo)
        ]);
        
        // 最新用户消息
        const lastUserMsg = session.messages.filter(m => m.role === 'user').pop();
        const queryContent = Buffer.concat([
            encodeString(1, lastUserMsg?.content || ''),
            encodeString(3, ""),
            encodeVarintField(4, 1)
        ]);
        const field2_6 = encodeMessage(1, encodeMessage(1, queryContent));
        
        const field2Content = Buffer.concat([
            encodeMessage(1, field2_1),
            encodeMessage(6, field2_6)
        ]);
        
        // 模型配置
        const modelConfig = Buffer.concat([
            encodeString(1, model),
            encodeString(4, "cli-agent-auto")
        ]);
        
        const capabilities = Buffer.from([
            0x06, 0x07, 0x0c, 0x08, 0x09, 0x0f, 0x0e, 0x00,
            0x0b, 0x10, 0x0a, 0x14, 0x11, 0x13, 0x12, 0x02,
            0x03, 0x01, 0x0d
        ]);
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
        
        // 元数据
        const entrypoint = Buffer.concat([
            encodeString(1, "entrypoint"),
            encodeMessage(2, encodeMessage(3, encodeString(1, "USER_INITIATED")))
        ]);
        const autoResume = Buffer.concat([
            encodeString(1, "is_auto_resume_after_error"),
            encodeMessage(2, encodeVarintField(4, 0))
        ]);
        const autoDetect = Buffer.concat([
            encodeString(1, "is_autodetected_user_query"),
            encodeMessage(2, encodeVarintField(4, 1))
        ]);
        const field4Content = Buffer.concat([
            encodeMessage(2, entrypoint),
            encodeMessage(2, autoResume),
            encodeMessage(2, autoDetect)
        ]);
        
        return Buffer.concat([
            encodeString(1, ""),
            encodeMessage(2, field2Content),
            encodeMessage(3, field3Content),
            encodeMessage(4, field4Content)
        ]);
    }
    
    /**
     * 解析 Warp 响应，提取文本和工具调用
     */
    parseWarpResponse(buffer) {
        const result = {
            text: '',
            reasoning: '',
            toolCalls: [],
            isComplete: false
        };
        
        // 提取文本内容
        for (let i = 0; i < buffer.length - 4; i++) {
            if (buffer[i] === 0x1a) {
                const outerLen = buffer[i + 1];
                if (outerLen > 2 && outerLen < 200 && buffer[i + 2] === 0x0a) {
                    const innerLen = buffer[i + 3];
                    if (innerLen > 0 && innerLen <= outerLen - 2 && i + 4 + innerLen <= buffer.length) {
                        const text = buffer.slice(i + 4, i + 4 + innerLen).toString('utf8');
                        
                        if (text.length === 0 || text.length === 36) continue;
                        if (text.includes('agent_') || text.includes('server_') ||
                            text.includes('USER_') || text.includes('primary_')) continue;
                        
                        // 检查是否有中文或英文
                        const hasChinese = /[\u4e00-\u9fff]/.test(text);
                        const hasAlpha = /[a-zA-Z]/.test(text);
                        
                        if (hasChinese || hasAlpha) {
                            if (!/^[A-Za-z0-9+/=]+$/.test(text)) {
                                result.text += text;
                            }
                        }
                    }
                }
            }
        }
        
        // 检测工具调用模式（简化版）
        const toolPatterns = [
            /run_command|run_shell_command/i,
            /list_dir|read_file|grep_search/i,
            /\bls\b|\bcat\b|\bgrep\b/
        ];
        
        const bufferStr = buffer.toString('utf8');
        for (const pattern of toolPatterns) {
            if (pattern.test(bufferStr)) {
                // 尝试提取命令
                const cmdMatch = bufferStr.match(/"command"\s*:\s*"([^"]+)"/);
                if (cmdMatch) {
                    result.toolCalls.push({
                        name: 'run_command',
                        params: { command: cmdMatch[1] }
                    });
                }
            }
        }
        
        return result;
    }
    
    /**
     * 发送请求到 Warp
     */
    sendRequest(body, accessToken) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'app.warp.dev',
                port: 443,
                path: '/ai/multi-agent',
                method: 'POST',
                headers: {
                    'x-warp-client-id': 'warp-app',
                    'x-warp-client-version': 'v0.2026.01.14.08.15.stable_02',
                    'x-warp-os-category': 'macOS',
                    'x-warp-os-name': 'macOS',
                    'x-warp-os-version': '15.7.2',
                    'content-type': 'application/x-protobuf',
                    'accept': 'text/event-stream',
                    'accept-encoding': 'identity',
                    'authorization': `Bearer ${accessToken}`,
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
                const allChunks = [];
                
                res.on('data', (chunk) => {
                    const text = chunk.toString();
                    const lines = text.split('\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data:')) {
                            const eventData = line.substring(5).trim();
                            if (eventData) {
                                try {
                                    const decoded = Buffer.from(eventData, 'base64');
                                    allChunks.push(decoded);
                                    const parsed = this.parseWarpResponse(decoded);
                                    if (parsed.text) {
                                        fullText += parsed.text;
                                    }
                                } catch (e) { }
                            }
                        }
                    }
                });
                
                res.on('end', () => {
                    resolve({
                        text: fullText,
                        chunks: allChunks
                    });
                });
            });
            
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
    
    /**
     * 执行工具
     */
    async executeTool(toolName, params) {
        // 查找工具（支持别名）
        let tool = this.tools[toolName];
        if (!tool) {
            for (const t of Object.values(this.tools)) {
                if (t.aliases && t.aliases.includes(toolName)) {
                    tool = t;
                    break;
                }
            }
        }
        
        if (!tool) {
            return { success: false, error: `未知工具: ${toolName}` };
        }
        
        try {
            const result = await tool.handler(params);
            return { success: true, result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    /**
     * 核心：多代理循环处理
     */
    async *processQuery(userQuery, options = {}) {
        // 获取或创建会话
        let session = options.sessionId ? this.getSession(options.sessionId) : null;
        if (!session) {
            session = this.createSession(options.workingDir);
        }
        
        // 添加用户消息
        session.addUserMessage(userQuery);
        
        // 获取凭证
        const credential = await this.warpStore.getRandomActive();
        if (!credential) {
            yield { type: 'error', error: '没有可用的 Warp 账号' };
            return;
        }
        
        const model = mapModelToWarp(options.model) || 'claude-4.1-opus';
        let isComplete = false;
        
        while (!isComplete && session.iteration < this.maxIterations) {
            session.iteration++;
            
            yield {
                type: 'iteration_start',
                iteration: session.iteration,
                sessionId: session.id
            };
            
            try {
                // 获取有效 token
                const accessToken = await this.getValidAccessToken(credential);
                
                // 发送请求 - 使用已有的 sendWarpRequest 函数
                yield { type: 'thinking', iteration: session.iteration };
                
                // 构建查询（包含历史上下文）
                let fullQuery = userQuery;
                if (session.toolCalls.length > 0) {
                    const lastToolCall = session.toolCalls[session.toolCalls.length - 1];
                    fullQuery = `${userQuery}\n\n[工具执行结果]\n命令: ${lastToolCall.name}\n输出:\n${lastToolCall.result}`;
                }
                
                const warpResponse = await sendWarpRequest(fullQuery, accessToken, model);
                const responseText = warpResponse.text;
                const toolCalls = warpResponse.toolCalls || [];
                
                // 更新使用计数
                await this.warpStore.incrementUseCount(credential.id);
                
                // 解析响应
                if (responseText) {
                    session.addAssistantMessage(responseText);
                    
                    yield {
                        type: 'content',
                        iteration: session.iteration,
                        content: responseText
                    };
                }
                
                // 检查是否有工具调用（从 Warp 响应中检测）
                const hasToolCall = toolCalls.length > 0 || (responseText && responseText.includes('```') && 
                    (responseText.includes('ls') || responseText.includes('cat') || 
                     responseText.includes('grep') || responseText.includes('find')));
                
                if (hasToolCall) {
                    // 提取命令
                    const cmdMatch = responseText.match(/```(?:bash|sh|shell)?\n?([\s\S]*?)```/);
                    if (cmdMatch) {
                        const command = cmdMatch[1].trim();
                        
                        yield {
                            type: 'tool_call_start',
                            iteration: session.iteration,
                            toolName: 'run_command',
                            command
                        };
                        
                        // 执行命令
                        const toolResult = await this.executeTool('run_command', {
                            command,
                            cwd: session.workingDir
                        });
                        
                        session.addToolCall('run_command', { command }, 
                            toolResult.success ? toolResult.result : toolResult.error);
                        
                        yield {
                            type: 'tool_call_end',
                            iteration: session.iteration,
                            toolName: 'run_command',
                            result: toolResult
                        };
                        
                        // 继续循环
                        continue;
                    }
                }
                
                // 没有工具调用，完成
                isComplete = true;
                
                yield {
                    type: 'complete',
                    iteration: session.iteration,
                    sessionId: session.id,
                    finalResponse: responseText
                };
                
            } catch (error) {
                await this.warpStore.incrementErrorCount(credential.id, error.message);
                
                yield {
                    type: 'error',
                    iteration: session.iteration,
                    error: error.message
                };
                
                // 尝试切换凭证继续
                break;
            }
        }
        
        if (!isComplete && session.iteration >= this.maxIterations) {
            yield {
                type: 'max_iterations_reached',
                iteration: session.iteration,
                sessionId: session.id
            };
        }
    }
    
    /**
     * 简化的同步调用
     */
    async chat(userQuery, options = {}) {
        let finalResponse = '';
        let allToolCalls = [];
        
        for await (const event of this.processQuery(userQuery, options)) {
            if (event.type === 'complete') {
                finalResponse = event.finalResponse;
            } else if (event.type === 'tool_call_end') {
                allToolCalls.push({
                    name: event.toolName,
                    result: event.result
                });
            } else if (event.type === 'error') {
                throw new Error(event.error);
            }
        }
        
        return {
            response: finalResponse,
            toolCalls: allToolCalls
        };
    }
}

// ==================== 路由设置 ====================

export function setupWarpMultiAgentRoutes(app, warpStore) {
    const service = new WarpMultiAgentService(warpStore);
    
    // 流式对话
    app.post('/api/warp/agent/stream', async (req, res) => {
        const { query, sessionId, model, workingDir } = req.body;
        
        if (!query) {
            return res.status(400).json({ error: 'query is required' });
        }
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        try {
            for await (const event of service.processQuery(query, { sessionId, model, workingDir })) {
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
        } catch (error) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    });
    
    // 非流式对话
    app.post('/api/warp/agent/chat', async (req, res) => {
        const { query, sessionId, model, workingDir } = req.body;
        
        if (!query) {
            return res.status(400).json({ error: 'query is required' });
        }
        
        try {
            const result = await service.chat(query, { sessionId, model, workingDir });
            res.json({ success: true, ...result });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    return service;
}

export default WarpMultiAgentService;
