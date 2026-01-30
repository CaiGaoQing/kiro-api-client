/**
 * Orchids 自动注册服务
 * 执行 Python 注册脚本并将结果上传到系统
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import { OrchidsAPI } from './orchids-service.js';

const log = logger.api;

// 获取当前目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 注册任务状态
const registerTasks = new Map();

/**
 * 注册任务类
 */
class RegisterTask {
    constructor(id, count, store, serverUrl) {
        this.id = id;
        this.count = count;
        this.store = store;
        this.serverUrl = serverUrl;
        this.status = 'pending';
        this.logs = [];
        this.progress = 0;
        this.success = 0;
        this.failed = 0;
        this.process = null;
        this.startTime = null;
        this.endTime = null;
    }

    addLog(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        this.logs.push({ timestamp, level, message });
        log.info(`[Register ${this.id}] ${message}`);
    }

    toJSON() {
        return {
            id: this.id,
            status: this.status,
            count: this.count,
            progress: this.progress,
            success: this.success,
            failed: this.failed,
            logs: this.logs.slice(-50), // 只返回最后50条日志
            startTime: this.startTime,
            endTime: this.endTime,
            duration: this.endTime ? (this.endTime - this.startTime) : (this.startTime ? (Date.now() - this.startTime) : 0)
        };
    }
}

/**
 * 启动注册任务
 */
export async function startRegisterTask(count, store, serverUrl) {
    const taskId = `reg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const task = new RegisterTask(taskId, count, store, serverUrl);
    registerTasks.set(taskId, task);

    task.addLog(`创建注册任务: ${count} 个账号`);
    task.status = 'running';
    task.startTime = Date.now();

    // 异步执行注册
    executeRegister(task).catch(err => {
        task.addLog(`任务异常: ${err.message}`, 'ERROR');
        task.status = 'error';
        task.endTime = Date.now();
    });

    return taskId;
}

/**
 * 执行注册流程
 */
async function executeRegister(task) {
    const scriptPath = path.join(__dirname, '..', '..', 'register', 'orchids_register.py');
    
    task.addLog(`脚本路径: ${scriptPath}`);
    task.addLog(`开始注册 ${task.count} 个账号...`);

    // 检查 Python 是否可用
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    
    return new Promise((resolve, reject) => {
        const args = [scriptPath, '--count', task.count.toString(), '--server', task.serverUrl];
        
        task.addLog(`执行命令: ${pythonCmd} ${args.join(' ')}`);
        
        const proc = spawn(pythonCmd, args, {
            cwd: path.dirname(scriptPath),
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1',
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1'
            },
            // Windows 需要 shell 模式来正确处理路径
            shell: process.platform === 'win32'
        });

        task.process = proc;

        proc.stdout.on('data', async (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                task.addLog(line);
                
                // 解析进度
                const progressMatch = line.match(/开始注册第 (\d+)\/(\d+)/);
                if (progressMatch) {
                    task.progress = parseInt(progressMatch[1]);
                }
                
                // 解析成功
                if (line.includes('成功提取 __client') || line.includes('服务器保存成功')) {
                    task.success++;
                }
                
                // 解析 client_key 并直接添加到数据库
                const clientKeyMatch = line.match(/CLIENT_KEY:(.+)/);
                if (clientKeyMatch && task.store) {
                    const clientKey = clientKeyMatch[1].trim();
                    await addAccountToStore(task, clientKey);
                }
            }
        });

        proc.stderr.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                task.addLog(line, 'ERROR');
                if (line.includes('❌')) {
                    task.failed++;
                }
            }
        });

        proc.on('close', (code) => {
            task.endTime = Date.now();
            if (code === 0) {
                task.status = 'completed';
                task.addLog(`任务完成: 成功 ${task.success} 个，失败 ${task.failed} 个`);
            } else {
                task.status = 'error';
                task.addLog(`任务异常退出，代码: ${code}`, 'ERROR');
            }
            resolve();
        });

        proc.on('error', (err) => {
            task.status = 'error';
            task.addLog(`进程错误: ${err.message}`, 'ERROR');
            task.endTime = Date.now();
            reject(err);
        });
    });
}

/**
 * 将账号添加到数据库
 */
async function addAccountToStore(task, clientKey) {
    try {
        task.addLog(`正在验证并添加账号...`);
        
        // 获取完整账号信息
        const accountInfo = await OrchidsAPI.getFullAccountInfo(clientKey);
        if (!accountInfo.success) {
            task.addLog(`Token 验证失败: ${accountInfo.error}`, 'ERROR');
            return;
        }

        const name = accountInfo.email || `orchids-${Date.now()}`;
        
        // 检查是否已存在
        const existing = await task.store.getByName(name);
        if (existing) {
            task.addLog(`账号已存在: ${name}`, 'WARN');
            return;
        }

        await task.store.add({
            name,
            email: accountInfo.email,
            clientJwt: clientKey,
            clerkSessionId: accountInfo.sessionId,
            userId: accountInfo.userId,
            expiresAt: accountInfo.expiresAt,
            weight: 1
        });

        task.addLog(`✅ 账号添加成功: ${name}`);
        task.success++;
    } catch (error) {
        task.addLog(`添加账号失败: ${error.message}`, 'ERROR');
    }
}

/**
 * 获取任务状态
 */
export function getRegisterTask(taskId) {
    return registerTasks.get(taskId);
}

/**
 * 获取所有任务
 */
export function getAllRegisterTasks() {
    return Array.from(registerTasks.values()).map(t => t.toJSON());
}

/**
 * 取消任务
 */
export function cancelRegisterTask(taskId) {
    const task = registerTasks.get(taskId);
    if (task && task.process) {
        task.process.kill('SIGTERM');
        task.status = 'cancelled';
        task.endTime = Date.now();
        task.addLog('任务已取消');
        return true;
    }
    return false;
}

/**
 * 清理旧任务
 */
export function cleanupTasks() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24小时
    
    for (const [id, task] of registerTasks) {
        if (task.endTime && (now - task.endTime) > maxAge) {
            registerTasks.delete(id);
        }
    }
}

// 定期清理
setInterval(cleanupTasks, 60 * 60 * 1000); // 每小时清理一次

export default {
    startRegisterTask,
    getRegisterTask,
    getAllRegisterTasks,
    cancelRegisterTask
};
