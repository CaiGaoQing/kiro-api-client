import crypto from 'crypto';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { KIRO_OAUTH_CONFIG, KIRO_CONSTANTS } from '../constants.js';

/**
 * 生成 PKCE 代码验证器
 */
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * 生成 PKCE 代码挑战
 */
function generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash('sha256');
    hash.update(codeVerifier);
    return hash.digest('base64url');
}

/**
 * 生成 HTML 响应页面
 */
function generateResponsePage(isSuccess, message) {
    const title = isSuccess ? '授权成功！' : '授权失败';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
               display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;
               background: ${isSuccess ? '#f0fdf4' : '#fef2f2'}; }
        .container { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        h1 { color: ${isSuccess ? '#16a34a' : '#dc2626'}; margin-bottom: 16px; }
        p { color: #6b7280; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${title}</h1>
        <p>${message}</p>
    </div>
</body>
</html>`;
}

/**
 * Kiro OAuth 认证类
 * 支持两种认证方式：
 * 1. Social Auth (Google/GitHub) - 使用 HTTP localhost 回调
 * 2. Builder ID - 使用 Device Code Flow
 */
export class KiroAuth {
    constructor(options = {}) {
        this.region = options.region || KIRO_CONSTANTS.DEFAULT_REGION;
        this.credentialsDir = options.credentialsDir || path.join(os.homedir(), KIRO_OAUTH_CONFIG.credentialsDir);
        this.credentialsFile = options.credentialsFile || KIRO_OAUTH_CONFIG.credentialsFile;
        this.saveToConfigs = options.saveToConfigs || false; // 是否保存到项目 configs 目录
        this.saveToFile = options.saveToFile !== false; // 是否保存到文件，默认 true
        this.onSuccess = options.onSuccess || null; // 认证成功回调函数
        this.server = null;
        this.pollingTask = null;
        this._lastCredentialsPath = null; // 记录最后保存的凭证路径
        this._lastCredentials = null; // 记录最后获取的凭证
    }

    /**
     * 获取凭据文件路径
     * @param {boolean} forConfigs - 是否获取 configs 目录路径
     */
    getCredentialsPath(forConfigs = false) {
        if (forConfigs || this.saveToConfigs) {
            // 返回项目 configs 目录路径
            const timestamp = Date.now();
            const folderName = `${timestamp}_kiro-auth-token`;
            return path.join(process.cwd(), 'configs', 'kiro', folderName, `${folderName}.json`);
        }
        return path.join(this.credentialsDir, this.credentialsFile);
    }

    /**
     * 获取最后保存的凭证路径
     */
    getLastCredentialsPath() {
        return this._lastCredentialsPath;
    }

    /**
     * 获取最后获取的凭证
     */
    getLastCredentials() {
        return this._lastCredentials;
    }

    /**
     * 保存凭据到文件
     * @param {object} credentials - 凭据对象
     * @param {object} options - 选项
     * @param {boolean} options.saveToConfigs - 是否保存到 configs 目录（覆盖构造函数设置）
     */
    async saveCredentials(credentials, options = {}) {
        const saveToConfigs = options.saveToConfigs !== undefined ? options.saveToConfigs : this.saveToConfigs;
        const credPath = this.getCredentialsPath(saveToConfigs);

        await fs.mkdir(path.dirname(credPath), { recursive: true });
        await fs.writeFile(credPath, JSON.stringify(credentials, null, 2));

        this._lastCredentialsPath = credPath;
        console.log(`[Kiro Auth] 凭据已保存到: ${credPath}`);

        return credPath;
    }

    /**
     * 加载凭据
     * @param {string} credPath - 可选，指定凭据文件路径
     */
    async loadCredentials(credPath = null) {
        try {
            const filePath = credPath || path.join(this.credentialsDir, this.credentialsFile);
            const content = await fs.readFile(filePath, 'utf8');
            return JSON.parse(content);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    /**
     * 从 configs 目录加载所有凭据文件
     * @returns {Promise<Array<{path: string, credentials: object}>>}
     */
    async loadAllConfigCredentials() {
        const configsDir = path.join(process.cwd(), 'configs', 'kiro');
        const results = [];

        try {
            const entries = await fs.readdir(configsDir, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.includes('kiro-auth-token')) {
                    const folderPath = path.join(configsDir, entry.name);
                    const files = await fs.readdir(folderPath);
                    const jsonFile = files.find(f => f.endsWith('.json'));

                    if (jsonFile) {
                        const filePath = path.join(folderPath, jsonFile);
                        try {
                            const content = await fs.readFile(filePath, 'utf8');
                            results.push({
                                path: filePath,
                                relativePath: path.relative(process.cwd(), filePath),
                                credentials: JSON.parse(content)
                            });
                        } catch (e) {
                            console.error(`[Kiro Auth] 读取凭据文件失败: ${filePath}`, e.message);
                        }
                    }
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        return results;
    }

    /**
     * 启动 Social Auth (Google/GitHub)
     * @param {string} provider - 'Google' 或 'Github'
     * @returns {Promise<{authUrl: string, port: number}>}
     */
    async startSocialAuth(provider = 'Google') {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = crypto.randomBytes(16).toString('base64url');

        // 启动本地回调服务器
        const port = await this._startCallbackServer(codeVerifier, state);
        const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

        // 构建授权 URL
        const authUrl = `${KIRO_OAUTH_CONFIG.authServiceEndpoint}/login?` +
            `idp=${provider}&` +
            `redirect_uri=${encodeURIComponent(redirectUri)}&` +
            `code_challenge=${codeChallenge}&` +
            `code_challenge_method=S256&` +
            `state=${state}&` +
            `prompt=select_account`;

        console.log(`[Kiro Auth] 请在浏览器中打开以下链接进行授权:`);
        console.log(authUrl);

        return { authUrl, port };
    }

    /**
     * 启动 Builder ID Device Code Flow
     * @returns {Promise<{verificationUri: string, userCode: string}>}
     */
    async startBuilderIDAuth() {
        // 1. 注册 OIDC 客户端
        const regResponse = await fetch(`${KIRO_OAUTH_CONFIG.ssoOIDCEndpoint}/client/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': KIRO_CONSTANTS.USER_AGENT
            },
            body: JSON.stringify({
                clientName: 'Kiro IDE',
                clientType: 'public',
                scopes: KIRO_OAUTH_CONFIG.scopes,
                grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
            })
        });

        if (!regResponse.ok) {
            throw new Error(`客户端注册失败: ${regResponse.status}`);
        }

        const regData = await regResponse.json();

        // 2. 启动设备授权
        const authResponse = await fetch(`${KIRO_OAUTH_CONFIG.ssoOIDCEndpoint}/device_authorization`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': KIRO_CONSTANTS.USER_AGENT
            },
            body: JSON.stringify({
                clientId: regData.clientId,
                clientSecret: regData.clientSecret,
                startUrl: KIRO_OAUTH_CONFIG.builderIDStartURL
            })
        });

        if (!authResponse.ok) {
            throw new Error(`设备授权失败: ${authResponse.status}`);
        }

        const deviceAuth = await authResponse.json();

        console.log(`[Kiro Auth] 请在浏览器中打开以下链接:`);
        console.log(deviceAuth.verificationUriComplete);
        console.log(`[Kiro Auth] 或访问 ${deviceAuth.verificationUri} 并输入代码: ${deviceAuth.userCode}`);

        // 3. 启动后台轮询
        this._pollBuilderIDToken(regData.clientId, regData.clientSecret, deviceAuth.deviceCode);

        return {
            verificationUri: deviceAuth.verificationUri,
            verificationUriComplete: deviceAuth.verificationUriComplete,
            userCode: deviceAuth.userCode,
            expiresIn: deviceAuth.expiresIn
        };
    }

    /**
     * 启动本地回调服务器
     */
    async _startCallbackServer(codeVerifier, expectedState) {
        const portStart = KIRO_OAUTH_CONFIG.callbackPortStart;
        const portEnd = KIRO_OAUTH_CONFIG.callbackPortEnd;

        for (let port = portStart; port <= portEnd; port++) {
            try {
                await this._createServer(port, codeVerifier, expectedState);
                return port;
            } catch (err) {
                if (err.code !== 'EADDRINUSE') throw err;
                console.log(`[Kiro Auth] 端口 ${port} 被占用，尝试下一个...`);
            }
        }
        throw new Error('所有端口都被占用');
    }

    /**
     * 创建 HTTP 回调服务器
     */
    _createServer(port, codeVerifier, expectedState) {
        const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                try {
                    const url = new URL(req.url, `http://127.0.0.1:${port}`);

                    if (url.pathname === '/oauth/callback') {
                        const code = url.searchParams.get('code');
                        const state = url.searchParams.get('state');
                        const errorParam = url.searchParams.get('error');

                        if (errorParam) {
                            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
                            return;
                        }

                        if (state !== expectedState) {
                            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end(generateResponsePage(false, 'State 验证失败'));
                            return;
                        }

                        // 交换 Code 获取 Token
                        const tokenResponse = await fetch(`${KIRO_OAUTH_CONFIG.authServiceEndpoint}/oauth/token`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'User-Agent': KIRO_CONSTANTS.USER_AGENT
                            },
                            body: JSON.stringify({
                                code,
                      code_verifier: codeVerifier,
                                redirect_uri: redirectUri
                            })
                        });

                        if (!tokenResponse.ok) {
                            const errorText = await tokenResponse.text();
                            console.error(`[Kiro Auth] Token exchange failed:`, errorText);
                            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end(generateResponsePage(false, `获取令牌失败: ${tokenResponse.status}`));
                            return;
                        }

                        const tokenData = await tokenResponse.json();

                        // 构建凭据对象
                        const credentials = {
                            accessToken: tokenData.accessToken,
                            refreshToken: tokenData.refreshToken,
                            profileArn: tokenData.profileArn,
                            expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1000).toISOString(),
                            authMethod: KIRO_CONSTANTS.AUTH_METHOD_SOCIAL,
                            region: this.region
                        };

                        // 保存凭据
                        this._lastCredentials = credentials;
                        if (this.saveToFile) {
                            await this.saveCredentials(credentials);
                        }

                        // 调用成功回调
                        if (this.onSuccess) {
                            try {
                                await this.onSuccess(credentials);
                            } catch (callbackError) {
                                console.error(`[Kiro Auth] 回调执行失败:`, callbackError);
                            }
                        }

                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(true, '授权成功！您可以关闭此页面'));

                        // 关闭服务器
                        this.server.close();
                        this.server = null;
                    } else {
                        res.writeHead(204);
                        res.end();
                    }
                } catch (error) {
                    console.error(`[Kiro Auth] 处理回调出错:`, error);
                    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, `服务器错误: ${error.message}`));
                }
            });

            this.server.on('error', reject);
            this.server.listen(port, '127.0.0.1', () => resolve());

            // 超时自动关闭
            setTimeout(() => {
                if (this.server && this.server.listening) {
                    this.server.close();
                    this.server = null;
                }
            }, KIRO_OAUTH_CONFIG.authTimeout);
        });
    }

    /**
     * 轮询获取 Builder ID Token
     */
    async _pollBuilderIDToken(clientId, clientSecret, deviceCode) {
        const interval = 5;
        const maxAttempts = 60; // 5分钟
        let attempts = 0;

        const poll = async () => {
            if (attempts >= maxAttempts) {
                throw new Error('授权超时');
            }

            attempts++;

            try {
                const response = await fetch(`${KIRO_OAUTH_CONFIG.ssoOIDCEndpoint}/token`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': KIRO_CONSTANTS.USER_AGENT
                    },
                    body: JSON.stringify({
                        clientId,
                        clientSecret,
                        deviceCode,
                        grantType: 'urn:ietf:params:oauth:grant-type:device_code'
                    })
                });

                const data = await response.json();

                if (response.ok && data.accessToken) {
                    console.log(`[Kiro Auth] 成功获取令牌`);

                    const credentials = {
                        accessToken: data.accessToken,
                        refreshToken: data.refreshToken,
                        expiresAt: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
                        authMethod: KIRO_CONSTANTS.AUTH_METHOD_BUILDER_ID,
                        clientId,
                        clientSecret,
                        region: this.region
                    };

                    // 保存凭据
                    this._lastCredentials = credentials;
                    if (this.saveToFile) {
                        await this.saveCredentials(credentials);
                    }

                    // 调用成功回调
                    if (this.onSuccess) {
                        try {
                            await this.onSuccess(credentials);
                        } catch (callbackError) {
                            console.error(`[Kiro Auth] 回调执行失败:`, callbackError);
                        }
                    }

                    return credentials;
                }

                if (data.error === 'authorization_pending') {
                    console.log(`[Kiro Auth] 等待用户授权... (${attempts}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, interval * 1000));
                    return poll();
                } else if (data.error === 'slow_down') {
                    await new Promise(resolve => setTimeout(resolve, (interval + 5) * 1000));
                    return poll();
                } else {
                    throw new Error(`授权失败: ${data.error || '未知错误'}`);
                }
            } catch (error) {
                if (error.message.includes('授权') || error.message.includes('超时')) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, interval * 1000));
                return poll();
            }
        };

        return poll();
    }

    /**
     * 关闭服务器
     */
    close() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
}

export default KiroAuth;
