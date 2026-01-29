/**
 * Warp 消息转换器
 * 处理 Claude API 消息 <-> Warp 协议消息的双向转换
 */

import crypto from 'crypto';
import { createInputContext, createTaskStatus, TOOL_TYPES } from './warp-proto.js';
import {
    claudeToolUseToWarpToolCall,
    claudeToolResultToWarpResult,
    warpToolCallToClaudeToolUse,
    getWarpSupportedTools,
    getToolNameFromWarpToolCall
} from './warp-tool-mapper.js';

/**
 * 将 Claude API 请求转换为 Warp Request 对象
 * @param {Object} claudeRequest - Claude API 请求
 * @param {Object} context - 上下文信息
 * @returns {Object} Warp Request 对象
 */
export function buildWarpRequest(claudeRequest, context = {}) {
    const { model, messages, system, tools, metadata } = claudeRequest;
    const {
        workingDir = '/tmp',
        homeDir = process.env.HOME || '/root',
        conversationId = null
    } = context;

    const taskId = crypto.randomUUID();
    const convId = conversationId || metadata?.session_id || crypto.randomUUID();

    // 构建 InputContext
    const inputContext = createInputContext({
        pwd: workingDir,
        home: homeDir
    });

    // 添加 system 作为 project_rules
    if (system) {
        const systemText = typeof system === 'string'
            ? system
            : (Array.isArray(system) ? system.map(s => s.text || s).join('\n') : '');

        if (systemText) {
            inputContext.project_rules = [{
                root_path: workingDir,
                active_rule_files: [{
                    file_path: '.claude/rules.md',
                    content: systemText
                }],
                additional_rule_file_paths: []
            }];
        }
    }

    // 转换消息
    const { taskMessages, userInputs } = convertClaudeMessages(messages, inputContext);

    // 构建 Settings
    const supportedTools = getWarpSupportedTools(tools);

    // 构建请求对象
    const request = {
        task_context: {
            tasks: [{
                id: taskId,
                description: '',
                status: createTaskStatus('in_progress'),
                messages: taskMessages,
                summary: ''
            }],
            active_task_id: taskId
        },
        input: {
            context: inputContext,
            user_inputs: { inputs: userInputs }
        },
        settings: {
            model_config: {
                base: model || 'auto',
                planning: '',
                coding: ''
            },
            rules_enabled: true,
            web_context_retrieval_enabled: false,
            supports_parallel_tool_calls: true,
            use_anthropic_text_editor_tools: false,
            planning_enabled: false,
            warp_drive_context_enabled: false,
            supports_create_files: true,
            supported_tools: supportedTools,
            supports_long_running_commands: true,
            should_preserve_file_content_in_history: false,
            supports_todos_ui: true,
            supports_linked_code_blocks: true
        },
        metadata: {
            conversation_id: convId,
            logging: {}
        }
    };

    return request;
}

/**
 * 转换 Claude 消息数组为 Warp 格式
 * @param {Array} messages - Claude 消息数组
 * @param {Object} inputContext - 输入上下文
 * @returns {Object} { taskMessages, userInputs }
 */
function convertClaudeMessages(messages, inputContext) {
    const taskMessages = [];
    const userInputs = [];

    // 用于跟踪工具调用，以便在 tool_result 中查找对应的工具名称
    const toolCallMap = new Map();

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const isLastMessage = i === messages.length - 1;

        if (msg.role === 'user') {
            const converted = convertUserMessage(msg, inputContext, isLastMessage, toolCallMap);

            if (converted.userInputs) {
                userInputs.push(...converted.userInputs);
            }
            if (converted.taskMessages) {
                taskMessages.push(...converted.taskMessages);
            }
        } else if (msg.role === 'assistant') {
            const converted = convertAssistantMessage(msg, toolCallMap);
            taskMessages.push(...converted);
        }
    }

    return { taskMessages, userInputs };
}

/**
 * 转换用户消息
 * @param {Object} msg - Claude 用户消息
 * @param {Object} inputContext - 输入上下文
 * @param {boolean} isLastMessage - 是否是最后一条消息
 * @param {Map} toolCallMap - 工具调用映射
 * @returns {Object} { taskMessages, userInputs }
 */
function convertUserMessage(msg, inputContext, isLastMessage, toolCallMap) {
    const result = { taskMessages: [], userInputs: [] };

    if (typeof msg.content === 'string') {
        // 简单文本消息
        const userQuery = {
            user_query: {
                query: msg.content,
                context: inputContext,
                referenced_attachments: {}
            }
        };

        if (isLastMessage) {
            result.userInputs.push(userQuery);
        } else {
            result.taskMessages.push({
                id: crypto.randomUUID(),
                user_query: userQuery.user_query
            });
        }
    } else if (Array.isArray(msg.content)) {
        // 复合内容（可能包含 text 和 tool_result）
        let textContent = '';
        const toolResults = [];

        for (const block of msg.content) {
            if (block.type === 'text') {
                textContent += block.text;
            } else if (block.type === 'tool_result') {
                // 查找对应的工具名称
                const toolName = toolCallMap.get(block.tool_use_id) || 'Bash';
                const warpResult = claudeToolResultToWarpResult(block, toolName);
                toolResults.push({
                    tool_call_result: warpResult
                });
            }
        }

        // 添加文本内容
        if (textContent) {
            const userQuery = {
                user_query: {
                    query: textContent,
                    context: inputContext,
                    referenced_attachments: {}
                }
            };

            if (isLastMessage && toolResults.length === 0) {
                result.userInputs.push(userQuery);
            } else {
                result.taskMessages.push({
                    id: crypto.randomUUID(),
                    user_query: userQuery.user_query
                });
            }
        }

        // 添加工具结果
        if (toolResults.length > 0) {
            if (isLastMessage) {
                result.userInputs.push(...toolResults);
            } else {
                for (const tr of toolResults) {
                    result.taskMessages.push({
                        id: crypto.randomUUID(),
                        tool_call_result: tr.tool_call_result
                    });
                }
            }
        }
    }

    return result;
}

/**
 * 转换助手消息
 * @param {Object} msg - Claude 助手消息
 * @param {Map} toolCallMap - 工具调用映射（用于记录工具调用）
 * @returns {Array} Warp Message 数组
 */
function convertAssistantMessage(msg, toolCallMap) {
    const messages = [];

    if (typeof msg.content === 'string') {
        messages.push({
            id: crypto.randomUUID(),
            agent_output: {
                text: msg.content,
                reasoning: ''
            }
        });
    } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
            if (block.type === 'text') {
                messages.push({
                    id: crypto.randomUUID(),
                    agent_output: {
                        text: block.text,
                        reasoning: ''
                    }
                });
            } else if (block.type === 'tool_use') {
                // 记录工具调用以便后续查找
                toolCallMap.set(block.id, block.name);

                const warpToolCall = claudeToolUseToWarpToolCall(block);
                messages.push({
                    id: crypto.randomUUID(),
                    tool_call: warpToolCall
                });
            }
        }
    }

    return messages;
}

/**
 * 解析 Warp ResponseEvent 并转换为 Claude API 格式的事件
 * @param {Object} responseEvent - Warp ResponseEvent 对象
 * @returns {Array} Claude 格式事件数组
 */
export function parseWarpResponseEvent(responseEvent) {
    const events = [];

    // StreamInit 事件
    if (responseEvent.init) {
        events.push({
            type: 'stream_init',
            conversationId: responseEvent.init.conversation_id,
            requestId: responseEvent.init.request_id
        });
    }

    // ClientActions 事件
    if (responseEvent.client_actions) {
        const actions = responseEvent.client_actions.actions || [];

        for (const action of actions) {
            // AppendToMessageContent - 流式文本增量
            if (action.append_to_message_content) {
                const msg = action.append_to_message_content.message;
                if (msg?.agent_output?.text) {
                    events.push({
                        type: 'text_delta',
                        text: msg.agent_output.text
                    });
                }
                if (msg?.agent_output?.reasoning) {
                    events.push({
                        type: 'reasoning_delta',
                        text: msg.agent_output.reasoning
                    });
                }
            }

            // AddMessagesToTask - 完整消息
            if (action.add_messages_to_task) {
                const taskMessages = action.add_messages_to_task.messages || [];

                for (const msg of taskMessages) {
                    if (msg.agent_output) {
                        events.push({
                            type: 'agent_output',
                            text: msg.agent_output.text || '',
                            reasoning: msg.agent_output.reasoning || ''
                        });
                    }
                    if (msg.tool_call) {
                        const claudeToolUse = warpToolCallToClaudeToolUse(msg.tool_call);
                        if (claudeToolUse) {
                            events.push({
                                type: 'tool_use',
                                toolUse: claudeToolUse
                            });
                        }
                    }
                }
            }

            // UpdateTaskMessage - 消息更新
            if (action.update_task_message) {
                const msg = action.update_task_message.message;
                if (msg?.agent_output?.text) {
                    events.push({
                        type: 'text_delta',
                        text: msg.agent_output.text
                    });
                }
            }

            // CreateTask - 新任务创建
            if (action.create_task) {
                events.push({
                    type: 'task_created',
                    taskId: action.create_task.task?.id,
                    description: action.create_task.task?.description
                });
            }

            // UpdateTaskStatus - 任务状态更新
            if (action.update_task_status) {
                events.push({
                    type: 'task_status',
                    taskId: action.update_task_status.task_id,
                    status: action.update_task_status.task_status
                });
            }
        }
    }

    // StreamFinished 事件
    if (responseEvent.finished) {
        const finished = responseEvent.finished;

        // 确定停止原因
        let stopReason = 'end_turn';
        if (finished.done) {
            stopReason = 'end_turn';
        } else if (finished.quota_limit) {
            stopReason = 'quota_limit';
        } else if (finished.max_token_limit) {
            stopReason = 'max_tokens';
        } else if (finished.context_window_exceeded) {
          stopReason = 'context_window_exceeded';
        } else if (finished.llm_unavailable) {
            stopReason = 'llm_unavailable';
        } else if (finished.internal_error) {
            stopReason = 'internal_error';
        }

        // 提取 token 使用量
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;

        if (finished.token_usage && finished.token_usage.length > 0) {
            for (const usage of finished.token_usage) {
                inputTokens += usage.total_input || 0;
                outputTokens += usage.output || 0;
                cacheReadTokens += usage.input_cache_read || 0;
                cacheWriteTokens += usage.input_cache_write || 0;
            }
        }

        events.push({
            type: 'stream_finished',
            reason: stopReason,
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_read_input_tokens: cacheReadTokens,
                cache_creation_input_tokens: cacheWriteTokens
            },
            errorMessage: finished.internal_error?.message || null
        });
    }

    return events;
}

/**
 * 将 Warp 响应事件流转换为 Claude API SSE 格式
 * @param {Array} events - parseWarpResponseEvent 返回的事件数组
 * @param {Object} state - 状态对象 { messageId, model, blockIndex, contentBlocks }
 * @returns {Array} SSE 数据数组
 */
export function convertToClaudeSSE(events, state) {
    const sseData = [];

    for (const event of events) {
        switch (event.type) {
            case 'text_delta':
                // 确保有文本块
                if (state.blockIndex === 0 && !state.textBlockStarted) {
                    sseData.push({
                        event: 'content_block_start',
                        data: {
                            type: 'content_block_start',
                            index: state.blockIndex,
                            content_block: { type: 'text', text: '' }
                        }
                    });
                    state.textBlockStarted = true;
                }

                sseData.push({
                    event: 'content_block_delta',
                    data: {
                        type: 'content_block_delta',
                        index: state.blockIndex,
                        delta: { type: 'text_delta', text: event.text }
                    }
                });
                state.fullText = (state.fullText || '') + event.text;
                break;

            case 'tool_use':
                // 结束之前的文本块
                if (state.textBlockStarted) {
                    sseData.push({
                        event: 'content_block_stop',
                        data: { type: 'content_block_stop', index: state.blockIndex }
                    });
                    state.blockIndex++;
                    state.textBlockStarted = false;
                }

                // 开始工具使用块
                sseData.push({
                    event: 'content_block_start',
                    data: {
                        type: 'content_block_start',
                        index: state.blockIndex,
                        content_block: {
                            type: 'tool_use',
                            id: event.toolUse.id,
                            name: event.toolUse.name,
                            input: {}
                        }
                    }
                });

                // 发送工具输入
                sseData.push({
                    event: 'content_block_delta',
                    data: {
                        type: 'content_block_delta',
                        index: state.blockIndex,
                        delta: {
                            type: 'input_json_delta',
                            partial_json: JSON.stringify(event.toolUse.input)
                        }
                    }
                });

                // 结束工具使用块
                sseData.push({
                    event: 'content_block_stop',
                    data: { type: 'content_block_stop', index: state.blockIndex }
                });

                state.toolCalls = state.toolCalls || [];
                state.toolCalls.push(event.toolUse);
                state.blockIndex++;
                break;

            case 'stream_finished':
                // 结束任何打开的块
                if (state.textBlockStarted) {
                    sseData.push({
                        event: 'content_block_stop',
                        data: { type: 'content_block_stop', index: state.blockIndex }
                    });
                }

                // 确定停止原因
                const stopReason = (state.toolCalls && state.toolCalls.length > 0)
                    ? 'tool_use'
                    : (event.reason === 'end_turn' ? 'end_turn' : event.reason);

                sseData.push({
                    event: 'message_delta',
                    data: {
                        type: 'message_delta',
                        delta: { stop_reason: stopReason, stop_sequence: null },
                        usage: { output_tokens: event.usage.output_tokens }
                    }
                });

                sseData.push({
                    event: 'message_stop',
                    data: { type: 'message_stop' }
                });

                state.finished = true;
                state.usage = event.usage;
                state.stopReason = stopReason;
                break;
        }
    }

    return sseData;
}

/**
 * 构建 Claude API 非流式响应
 * @param {Object} state - 状态对象
 * @param {string} model - 模型名称
 * @returns {Object} Claude API 响应对象
 */
export function buildClaudeResponse(state, model) {
    const content = [];

    // 添加文本内容
    if (state.fullText) {
        content.push({
            type: 'text',
            text: state.fullText
        });
    }

    // 添加工具调用
    if (state.toolCalls && state.toolCalls.length > 0) {
        for (const toolUse of state.toolCalls) {
            content.push(toolUse);
        }
    }

    // 如果没有内容，添加默认文本
    if (content.length === 0) {
        content.push({
            type: 'text',
            text: ''
        });
    }

    return {
        id: state.messageId || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: state.stopReason || 'end_turn',
        stop_sequence: null,
        usage: state.usage || {
            input_tokens: 0,
            output_tokens: 0
        }
    };
}

/**
 * 创建初始 SSE 状态
 * @param {string} messageId - 消息 ID
 * @param {string} model - 模型名称
 * @param {number} inputTokens - 输入 token 数
 * @returns {Object} 状态对象
 */
export function createSSEState(messageId, model, inputTokens = 0) {
    return {
        messageId,
        model,
        inputTokens,
        blockIndex: 0,
        textBlockStarted: false,
        fullText: '',
        toolCalls: [],
        finished: false,
        usage: null,
        stopReason: null
    };
}

/**
 * 生成 message_start SSE 事件
 * @param {Object} state - SSE 状态
 * @returns {Object} SSE 数据
 */
export function createMessageStartSSE(state) {
    return {
        event: 'message_start',
        data: {
            type: 'message_start',
            message: {
                id: state.messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: state.model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: state.inputTokens,
                    output_tokens: 0
                }
            }
        }
    };
}
