/**
 * Warp Protobuf 加载器
 * 使用 protobufjs 加载和编解码 Warp 协议消息
 */

import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.join(__dirname, '../..', 'warp-protobuf-master');

// 缓存加载的 root 和消息类型
let root = null;
let messageTypes = {};

/**
 * 加载所有 proto 文件
 * @returns {Promise<Object>} 消息类型对象
 */
export async function loadProtos() {
    if (root) return messageTypes;

    // 创建新的 Root 实例
    root = new protobuf.Root();

    // 设置解析选项以支持 google.protobuf 类型
    root.resolvePath = (origin, target) => {
        // 处理 google/protobuf 导入
        if (target.startsWith('google/protobuf/')) {
            // protobufjs 内置了这些类型，返回 null 让它使用内置的
            return null;
        }
        // 其他文件从 PROTO_DIR 加载
        return path.join(PROTO_DIR, target);
    };

    // 按依赖顺序加载 proto 文件
    const protoFiles = [
        'options.proto',
        'citations.proto',
        'file_content.proto',
        'attachment.proto',
        'todo.proto',
        'suggestions.proto',
        'input_context.proto',
        'task.proto',
        'request.proto',
        'response.proto',
    ];

    for (const file of protoFiles) {
        await root.load(path.join(PROTO_DIR, file), { keepCase: true });
    }

    // 查找并缓存消息类型
    messageTypes = {
        // 请求/响应
        Request: root.lookupType('warp.multi_agent.v1.Request'),
        ResponseEvent: root.lookupType('warp.multi_agent.v1.ResponseEvent'),

        // 任务相关
        Task: root.lookupType('warp.multi_agent.v1.Task'),
        TaskStatus: root.lookupType('warp.multi_agent.v1.TaskStatus'),
        Message: root.lookupType('warp.multi_agent.v1.Message'),

        // 输入上下文
        InputContext: root.lookupType('warp.multi_agent.v1.InputContext'),

        // 文件内容
        FileContent: root.lookupType('warp.multi_agent.v1.FileContent'),
        FileContentLineRange: root.lookupType('warp.multi_agent.v1.FileContentLineRange'),

        // 工具类型枚举
        ToolType: root.lookupEnum('warp.multi_agent.v1.ToolType'),

        // 客户端动作
        ClientAction: root.lookupType('warp.multi_agent.v1.ClientAction'),

        // 工具结果类型
        RunShellCommandResult: root.lookupType('warp.multi_agent.v1.RunShellCommandResult'),
        ReadFilesResult: root.lookupType('warp.multi_agent.v1.ReadFilesResult'),
        ApplyFileDiffsResult: root.lookupType('warp.multi_agent.v1.ApplyFileDiffsResult'),
        GrepResult: root.lookupType('warp.multi_agent.v1.GrepResult'),
        FileGlobV2Result: root.lookupType('warp.multi_agent.v1.FileGlobV2Result'),
        CallMCPToolResult: root.lookupType('warp.multi_agent.v1.CallMCPToolResult'),
        ShellCommandFinished: root.lookupType('warp.multi_agent.v1.ShellCommandFinished'),
    };

    return messageTypes;
}

/**
 * 获取消息类型（确保已加载）
 * @returns {Promise<Object>} 消息类型对象
 */
export async function getMessageTypes() {
    if (!root) {
        await loadProtos();
    }
    return messageTypes;
}

/**
 * 编码 Request 消息
 * @param {Object} requestObj - 请求对象
 * @returns {Buffer} 编码后的二进制数据
 */
export function encodeRequest(requestObj) {
    if (!messageTypes.Request) {
        throw new Error('Proto types not loaded. Call loadProtos() first.');
    }

    const { Request } = messageTypes;

    // 验证消息
    const errMsg = Request.verify(requestObj);
    if (errMsg) {
        throw new Error(`Invalid request: ${errMsg}`);
    }

    // 创建并编码消息
    const message = Request.create(requestObj);
    return Buffer.from(Request.encode(message).finish());
}

/**
 * 解码 ResponseEvent 消息
 * @param {Buffer|Uint8Array} buffer - 二进制数据
 * @returns {Object} 解码后的响应事件对象
 */
export function decodeResponseEvent(buffer) {
    if (!messageTypes.ResponseEvent) {
        throw new Error('Proto types not loaded. Call loadProtos() first.');
    }

    const { ResponseEvent } = messageTypes;
    return ResponseEvent.decode(buffer);
}

/**
 * 解码 Message 消息
 * @param {Buffer|Uint8Array} buffer - 二进制数据
 * @returns {Object} 解码后的消息对象
 */
export function decodeMessage(buffer) {
    if (!messageTypes.Message) {
        throw new Error('Proto types not loaded. Call loadProtos() first.');
    }

    const { Message } = messageTypes;
    return Message.decode(buffer);
}

/**
 * 将 ResponseEvent 转换为普通 JavaScript 对象
 * @param {Object} responseEvent - protobufjs 解码的对象
 * @returns {Object} 普通 JavaScript 对象
 */
export function responseEventToObject(responseEvent) {
    if (!messageTypes.ResponseEvent) {
        throw new Error('Proto types not loaded. Call loadProtos() first.');
    }

    const { ResponseEvent } = messageTypes;
    return ResponseEvent.toObject(responseEvent, {
        longs: Number,
        enums: String,
        bytes: String,
        defaults: true,
        oneofs: true
    });
}

/**
 * 获取 ToolType 枚举值
 * @param {string} name - 工具类型名称
 * @returns {number} 枚举值
 */
export function getToolTypeValue(name) {
    if (!messageTypes.ToolType) {
        throw new Error('Proto types not loaded. Call loadProtos() first.');
    }

    return messageTypes.ToolType.values[name];
}

/**
 * 获取 ToolType 枚举名称
 * @param {number} value - 枚举值
 * @returns {string} 工具类型名称
 */
export function getToolTypeName(value) {
    if (!messageTypes.ToolType) {
        throw new Error('Proto types not loaded. Call loadProtos() first.');
    }

    const { ToolType } = messageTypes;
    for (const [name, val] of Object.entries(ToolType.values)) {
        if (val === value) return name;
    }
    return 'UNKNOWN';
}

/**
 * 创建 InputContext 对象
 * @param {Object} options - 选项
 * @param {string} options.pwd - 当前工作目录
 * @param {string} options.home - 用户主目录
 * @param {string} options.platform - 操作系统平台
 * @param {string} options.shellName - Shell 名称
 * @param {string} options.shellVersion - Shell 版本
 * @returns {Object} InputContext 对象
 */
export function createInputContext(options = {}) {
    const {
        pwd = '/tmp',
        home = process.env.HOME || '/root',
        platform = process.platform === 'darwin' ? 'macOS' : process.platform,
        shellName = 'zsh',
        shellVersion = '5.9'
    } = options;

    return {
        directory: {
            pwd,
            home,
            pwd_file_symbols_indexed: false
        },
        operating_system: {
            platform,
            distribution: ''
        },
        shell: {
            name: shellName,
            version: shellVersion
        },
        current_time: {
            seconds: Math.floor(Date.now() / 1000),
            nanos: (Date.now() % 1000) * 1000000
        }
    };
}

/**
 * 创建 TaskStatus 对象
 * @param {string} status - 状态名称: 'pending', 'in_progress', 'blocked', 'succeeded', 'failed', 'aborted'
 * @returns {Object} TaskStatus 对象
 */
export function createTaskStatus(status = 'in_progress') {
    const statusMap = {
        'pending': { pending: {} },
        'in_progress': { in_progress: {} },
        'blocked': { blocked: {} },
        'succeeded': { succeeded: {} },
        'failed': { failed: {} },
        'aborted': { aborted: {} }
    };

    return statusMap[status] || statusMap['in_progress'];
}

// 导出 ToolType 枚举值常量（方便使用）
export const TOOL_TYPES = {
    RUN_SHELL_COMMAND: 0,
    SEARCH_CODEBASE: 1,
    READ_FILES: 2,
    APPLY_FILE_DIFFS: 3,
    SUGGEST_PLAN: 4,
    SUGGEST_CREATE_PLAN: 5,
    GREP: 6,
    FILE_GLOB: 7,
    READ_MCP_RESOURCE: 8,
    CALL_MCP_TOOL: 9,
    WRITE_TO_LONG_RUNNING_SHELL_COMMAND: 10,
    SUGGEST_NEW_CONVERSATION: 11,
    FILE_GLOB_V2: 12
};
