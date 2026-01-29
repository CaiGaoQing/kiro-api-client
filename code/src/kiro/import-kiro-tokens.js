/**
 * 导入 kiro 目录下的 token 文件到数据库
 */

import fs from 'fs/promises';
import path from 'path';
import { initDatabase, CredentialStore } from '../db.js';

const KIRO_DIR = 'D:\\个人工作\\ai\\kiro';

async function importKiroTokens() {
    console.log('正在连接数据库 127..0.0.1:13306)...');
    await initDatabase();
    const store = await CredentialStore.create();

    console.log(`正在扫描目录: ${KIRO_DIR}`);

    const entries = await fs.readdir(KIRO_DIR, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && e.name.includes('kiro-auth-token'));

    console.log(`找到 ${dirs.length} 个 token 目录`);

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (const dir of dirs) {
        const dirPath = path.join(KIRO_DIR, dir.name);
        const files = await fs.readdir(dirPath);
        const jsonFile = files.find(f => f.endsWith('.json'));

        if (!jsonFile) {
            console.log(`[跳过] ${dir.name}: 没有找到 JSON 文件`);
            skipped++;
            continue;
        }

        const filePath = path.join(dirPath, jsonFile);

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);

            // 生成唯一名称（使用目录名中的时间戳）
            const timestamp = dir.name.split('_')[0];
            const name = `kiro-${data.authMethod || 'builder-id'}-${timestamp}`;

            // 检查是否已存在
            const existing = await store.getByName(name);
            if (existing) {
                console.log(`[跳过] ${name}: 已存在`);
                skipped++;
                continue;
            }

            // 插入数据库
            const id = await store.add({
                name: name,
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
                clientId: data.clientId || null,
                clientSecret: data.clientSecret || null,
                authMethod: data.authMethod || 'builder-id',
                provider: 'BuilderID',
                region: data.region || 'us-east-1',
                expiresAt: data.expiresAt || null
            });

            console.log(`[导入] ${name} (ID: ${id})`);
            imported++;

        } catch (error) {
            console.error(`[失败] ${dir.name}: ${error.message}`);
            failed++;
        }
    }

    console.log('\n========== 导入完成 ==========');
    console.log(`成功导入: ${imported}`);
    console.log(`跳过: ${skipped}`);
    console.log(`失败: ${failed}`);
    console.log(`总计: ${dirs.length}`);

    process.exit(0);
}

importKiroTokens().catch(err => {
    console.error('导入失败:', err);
    process.exit(1);
});
