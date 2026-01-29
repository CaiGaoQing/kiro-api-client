/**
 * Kiro API 测试脚本
 */
import { KiroClient } from './kiro/client.js';
import { CredentialStore, initDatabase } from './db.js';

async function main() {
    console.log('=== Kiro Client 测试 ===\n');

    // 初始化数据库
    await initDatabase();
    const store = await CredentialStore.create();

    // 检查是否有凭据
    const credentials = store.getAll();
    console.log(`数据库中有 ${credentials.length} 个凭据\n`);

    if (credentials.length === 0) {
        console.log('没有凭据，请先通过以下方式添加:');
        console.log('1. 启动管理界面: node src/server.js');
        console.log('2. 访问 http://localhost:3000');
        console.log('3. 点击"导入文件"或"添加凭据"\n');
        return;
    }

    // 获取活跃凭据
    const active = store.getActive();
    if (!active) {
        console.log('没有活跃凭据，请先激活一个凭据');
        return;
    }

    console.log(`使用凭据: ${active.name}`);
    console.log(`区域: ${active.region}`);
    console.log(`认证方式: ${active.authMethod}\n`);

    try {
        // 从数据库创建客户端
        const client = await KiroClient.fromDatabase();

        console.log('=== 支持的模型 ===');
        console.log(client.getModels());

        console.log('\n=== 发送测试消息 ===');
        const messages = [
            { role: 'user', content: '你好，请用一句话介绍你自己。' }
        ];

        // 非流式请求
        console.log('\n--- 非流式响应 ---');
        const response = await client.chat(messages);
        console.log('响应:', response);

        // 流式请求
        console.log('\n--- 流式响应 ---');
        process.stdout.write('响应: ');
        for await (const event of client.chatStream(messages)) {
            if (event.type === 'content') {
                process.stdout.write(event.content);
            }
        }
        console.log('\n');

        console.log('=== 测试完成 ===');

    } catch (error) {
        console.error('错误:', error.message);
        if (error.response) {
            console.error('状态码:', error.response.status);
        }
    }
}

main();
