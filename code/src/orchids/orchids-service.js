/**
 * Orchids API 服务
 * 提供 Orchids 账户管理和 Token 验证功能
 * 整合自 orchids-api-main 的功能
 */
import axios from 'axios';
import { logger } from '../logger.js';
import { getAxiosProxyConfig } from '../proxy.js';

const log = logger.api;

/**
 * Orchids 常量配置
 */
export const ORCHIDS_CONSTANTS = {
    CLERK_CLIENT_URL: 'https://clerk.orchids.app/v1/client',
    CLERK_CLIENT_URL_V2: 'https://clerk.orchids.app/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0',
    CLERK_TOKEN_URL: 'https://clerk.orchids.app/v1/client/sessions/{sessionId}/tokens',
    CLERK_JS_VERSION: '5.117.0',
    USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orchids/0.0.57 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36',
    ORIGIN: 'https://www.orchids.app',
    DEFAULT_TIMEOUT: 30000,
    DEFAULT_PROJECT_ID: '280b7bae-cd29-41e4-a0a6-7f603c43b607',
};

/**
 * Orchids API 服务类
 */
export class OrchidsAPI {
    /**
     * 从 clientJwt 获取完整账号信息（包括 email）
     * 参考 orchids-api-main 的 clerk.go 实现
     * @param {string} clientJwt - Clerk client JWT token (__client cookie 值)
     * @returns {Promise<Object>} {success, sessionId, userId, email, wsToken, expiresAt, clientUat, projectId, error}
     */
    static async getFullAccountInfo(clientJwt) {
        if (!clientJwt) {
            return { success: false, error: '缺少 clientJwt' };
        }

        log.info('从 Clerk API 获取完整账号信息');

        try {
            const proxyConfig = getAxiosProxyConfig();
            const response = await axios.get(ORCHIDS_CONSTANTS.CLERK_CLIENT_URL_V2, {
                headers: {
                    'Cookie': `__client=${clientJwt}`,
                    'Origin': ORCHIDS_CONSTANTS.ORIGIN,
                    'User-Agent': ORCHIDS_CONSTANTS.USER_AGENT,
                    'Accept-Language': 'zh-CN',
                },
                timeout: ORCHIDS_CONSTANTS.DEFAULT_TIMEOUT,
                ...proxyConfig
            });

            if (response.status !== 200) {
                log.error(`Clerk API 返回状态码: ${response.status}`);
                return { success: false, error: `Clerk API 返回 ${response.status}` };
            }

            const data = response.data;
            const responseData = data.response || {};
            const sessions = responseData.sessions || [];

            if (sessions.length === 0) {
                log.error('未找到活跃的 session');
                return { success: false, error: '未找到活跃的 session' };
            }

            const session = sessions[0];
            const sessionId = responseData.last_active_session_id || session.id;
            const userId = session.user?.id;
            const wsToken = session.last_active_token?.jwt;
            
            // 获取 email - 从 email_addresses 数组中提取
            let email = null;
            if (session.user?.email_addresses && session.user.email_addresses.length > 0) {
                email = session.user.email_addresses[0].email_address;
            }

            if (!sessionId || !wsToken) {
                log.error('Session 数据无效');
                return { success: false, error: 'Session 数据无效' };
            }

            // 解析 JWT 过期时间
            const expiresAt = this._parseJwtExpiry(wsToken);

            log.success('成功获取完整账号信息');
            log.info(`Session ID: ${sessionId}`);
            log.info(`User ID: ${userId || 'unknown'}`);
            log.info(`Email: ${email || 'unknown'}`);
            log.info(`Token 过期时间: ${expiresAt || '未知'}`);

            return {
                success: true,
                sessionId,
                userId,
                email,
                wsToken,
                expiresAt,
                clientUat: Math.floor(Date.now() / 1000).toString(),
                projectId: ORCHIDS_CONSTANTS.DEFAULT_PROJECT_ID
            };

        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            log.fail(`获取账号信息失败: ${errorMsg}`, error.response?.status);
            return {
                success: false,
                error: errorMsg,
                statusCode: error.response?.status
            };
        }
    }

    /**
     * 从 clientJwt 获取 session 信息（兼容旧版）
     * @param {string} clientJwt - Clerk client JWT token
     * @returns {Promise<Object>} {success, sessionId, userId, wsToken, expiresAt, email, error}
     */
    static async getSessionFromClerk(clientJwt) {
        // 使用新的完整方法获取信息
        const result = await this.getFullAccountInfo(clientJwt);
        if (!result.success) {
            return result;
        }
        
        return {
            success: true,
            sessionId: result.sessionId,
            userId: result.userId,
            wsToken: result.wsToken,
            expiresAt: result.expiresAt,
            email: result.email
        };
    }

    /**
     * 验证 clientJwt 是否有效
     * @param {string} clientJwt - Clerk client JWT token
     * @returns {Promise<Object>} {success, valid, email, userId, expiresAt, error}
     */
    static async validateToken(clientJwt) {
        const result = await this.getSessionFromClerk(clientJwt);

        if (!result.success) {
            return {
                success: true,
                valid: false,
                error: result.error
            };
        }

        return {
            success: true,
            valid: true,
            userId: result.userId,
            sessionId: result.sessionId,
            expiresAt: result.expiresAt
        };
    }

    /**
     * 从 cookies 字符串中提取 clientJwt
     * @param {string} cookies - Cookies 字符串
     * @returns {string|null} clientJwt
     */
    static extractClientJwtFromCookies(cookies) {
        if (!cookies) return null;

        const match = cookies.match(/__client=([^;]+)/);
        if (match && match[1]) {
            const jwt = match[1].trim();
            // 验证是否为有效的 JWT 格式（三部分，用 . 分隔）
            if (jwt.split('.').length === 3) {
                return jwt;
            }
        }

        return null;
    }

    /**
     * 解析 JWT 的过期时间
     * @private
     * @param {string} jwt - JWT token
     * @returns {string|null} ISO 格式的过期时间
     */
    static _parseJwtExpiry(jwt) {
        if (!jwt) return null;

        try {
            const parts = jwt.split('.');
            if (parts.length !== 3) return null;

            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));

            if (payload.exp) {
                const expiryDate = new Date(payload.exp * 1000);
                return expiryDate.toISOString();
            }

            return null;
        } catch (error) {
            log.warn(`解析 JWT 过期时间失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 检查 Token 是否即将过期
     * @param {string} expiresAt - 过期时间 ISO 字符串
     * @param {number} minutes - 提前多少分钟判定为即将过期 (默认 10)
     * @returns {boolean}
     */
    static isTokenExpiringSoon(expiresAt, minutes = 10) {
        if (!expiresAt) return false;
        try {
            const expirationTime = new Date(expiresAt);
            const thresholdTime = new Date(Date.now() + minutes * 60 * 1000);
            return expirationTime.getTime() <= thresholdTime.getTime();
        } catch {
            return false;
        }
    }

    /**
     * 批量导入 Orchids 账号
     * @param {Array} accounts - 账号数组 [{email, clientJwt}]
     * @param {Object} options - 选项
     * @param {number} options.delay - 每个请求之间的延迟毫秒 (默认 1000)
     * @param {Function} options.onProgress - 进度回调 (index, total, result)
     * @returns {Promise<Object>} 批量导入结果 {success, failed, results}
     */
    static async batchImport(accounts, options = {}) {
        const { delay = 1000, onProgress } = options;
        const results = {
            success: 0,
            failed: 0,
            results: []
        };

        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];
            const result = await this.validateToken(account.clientJwt);

            results.results.push({
                email: account.email,
                ...result
            });

            if (result.success && result.valid) {
                results.success++;
            } else {
                results.failed++;
            }

            if (onProgress) {
                onProgress(i + 1, accounts.length, result);
            }

            // 延迟，避免请求过快
            if (i < accounts.length - 1 && delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        return results;
    }

    /**
     * 测试账号激活状态
     * 发送一个简单的测试请求验证账号是否可用
     * @param {string} clientJwt - Clerk client JWT token
     * @returns {Promise<Object>} {success, isHealthy, durationMs, response, error}
     */
    static async testAccountHealth(clientJwt) {
        const startTime = Date.now();
        
        try {
            const result = await this.getFullAccountInfo(clientJwt);
            const durationMs = Date.now() - startTime;
            
            if (!result.success) {
                return {
                    success: false,
                    isHealthy: false,
                    durationMs,
                    error: result.error
                };
            }
            
            return {
                success: true,
                isHealthy: true,
                durationMs,
                response: `Session: ${result.sessionId}, Email: ${result.email || 'N/A'}`,
                data: result
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            return {
                success: false,
                isHealthy: false,
                durationMs,
                error: error.message
            };
        }
    }

    /**
     * 批量检查账号健康状态
     * @param {Array} credentials - 凭证数组 [{id, clientJwt}]
     * @returns {Promise<Object>} {accounts: [{accountId, isHealthy}]}
     */
    static async batchHealthCheck(credentials) {
        const results = {
            accounts: []
        };

        for (const cred of credentials) {
            try {
                const health = await this.testAccountHealth(cred.clientJwt);
                results.accounts.push({
                    account_id: cred.id,
                    is_healthy: health.isHealthy
                });
            } catch {
                results.accounts.push({
                    account_id: cred.id,
                    is_healthy: false
                });
            }
        }

        return results;
    }

    /**
     * 刷新单个账号信息
     * @param {string} clientJwt - Clerk client JWT token
     * @returns {Promise<Object>} 刷新后的完整账号信息
     */
    static async refreshAccountInfo(clientJwt) {
        return await this.getFullAccountInfo(clientJwt);
    }
}

export default OrchidsAPI;
