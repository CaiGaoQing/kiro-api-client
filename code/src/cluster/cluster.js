#!/usr/bin/env node
/**
 * 集群启动脚本 - 启动多个服务实例
 * 用法: node src/cluster.js [实例数量] [起始端口]
 * 默认: 5个实例，从13004开始
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const INSTANCE_COUNT = parseInt(process.env.INSTANCE_COUNT || process.argv[2] || '5');
const START_PORT = parseInt(process.env.START_PORT || process.argv[3] || '13004');

const instances = [];

function getTimestamp() {
    return new Date().toLocaleString('zh-CN', { hour12: false });
}

function startInstance(port) {
    const env = { ...process.env, PORT: port.toString() };
    const child = spawn('node', [join(__dirname, '..', 'server.js')], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (data) => {
        process.stdout.write(`[${port}] ${data}`);
    });

    child.stderr.on('data', (data) => {
        process.stderr.write(`[${port}] ${data}`);
    });

    child.on('exit', (code) => {
        console.log(`[${getTimestamp()}] 实例 ${port} 退出，代码: ${code}`);
        setTimeout(() => {
            console.log(`[${getTimestamp()}] 正在重启实例 ${port}...`);
            const index = instances.findIndex(i => i.port === port);
            if (index !== -1) {
                instances[index] = { port, process: startInstance(port) };
            }
        }, 1000);
    });

    return child;
}

console.log(`[${getTimestamp()}] 启动 ${INSTANCE_COUNT} 个服务实例...`);
console.log(`[${getTimestamp()}] 端口范围: ${START_PORT} - ${START_PORT + INSTANCE_COUNT - 1}`);

for (let i = 0; i < INSTANCE_COUNT; i++) {
    const port = START_PORT + i;
    instances.push({
        port,
        process: startInstance(port)
    });
    console.log(`[${getTimestamp()}] 启动实例 ${i + 1}/${INSTANCE_COUNT} 端口: ${port}`);
}

process.on('SIGINT', () => {
    console.log(`\n[${getTimestamp()}] 正在关闭所有实例...`);
    instances.forEach(({ port, process }) => {
        console.log(`[${getTimestamp()}] 关闭实例 ${port}`);
        process.kill('SIGTERM');
    });
    setTimeout(() => process.exit(0), 2000);
});

process.on('SIGTERM', () => {
    instances.forEach(({ process }) => process.kill('SIGTERM'));
    setTimeout(() => process.exit(0), 2000);
});

console.log(`[${getTimestamp()}] 集群已启动，按 Ctrl+C 停止所有实例`);
