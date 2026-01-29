/**
 * Kiro 认证 CLI 工具
 * 用于获取 OAuth 凭据
 */
import { KiroAuth } from './auth.js';
import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise(resolve => rl.question(prompt, resolve));
}

async function main() {
    console.log('=== Kiro OAuth 认证工具 ===\n');

    // 选择存储位置
    console.log('请选择凭据存储位置:');
    console.log('1. 默认位置 (~/.kiro/oauth_creds.json)');
    console.log('2. 项目 configs 目录 (configs/kiro/)');
    console.log('');

    const storageChoice = await question('请输入选项 (1/2): ');
    const saveToConfigs = storageChoice.trim() === '2';

    console.log('\n请选择认证方式:');
    console.log('1. Google 账号登录 (推荐)');
    console.log('2. GitHub 账号登录');
    console.log('3. AWS Builder ID');
    console.log('');

    const choice = await question('请输入选项 (1/2/3): ');

    const auth = new KiroAuth({ saveToConfigs });

    try {
        switch (choice.trim()) {
            case '1':
                console.log('\n正在启动 Google 登录...');
                const googleResult = await auth.startSocialAuth('Google');
                console.log('\n请在浏览器中打开以下链接完成授权:');
                console.log(googleResult.authUrl);
                console.log('\n等待授权完成...');
                break;

            case '2':
                console.log('\n正在启动 GitHub 登录...');
                const githubResult = await auth.startSocialAuth('Github');
                console.log('\n请在浏览器中打开以下链接完成授权:');
                console.log(githubResult.authUrl);
                console.log('\n等待授权完成...');
                break;

            case '3':
                console.log('\n正在启动 AWS Builder ID 登录...');
                const builderResult = await auth.startBuilderIDAuth();
                console.log('\n请在浏览器中打开以下链接:');
                console.log(builderResult.verificationUriComplete);
                console.log(`\n或访问 ${builderResult.verificationUri} 并输入代码: ${builderResult.userCode}`);
                console.log('\n等待授权完成...');
                break;

            default:
                console.log('无效选项');
                rl.close();
                return;
        }

        // 等待用户完成授权
        if (saveToConfigs) {
            console.log('\n授权完成后，凭据将保存到项目 configs/kiro/ 目录');
        } else {
            console.log('\n授权完成后，凭据将自动保存到 ~/.kiro/oauth_creds.json');
        }
        console.log('按 Ctrl+C 取消\n');

    } catch (error) {
        console.error('认证失败:', error.message);
        auth.close();
        rl.close();
    }
}

main();
