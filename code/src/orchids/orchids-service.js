/**
 * Orchids API 服务
 * 提供 Orchids 账户管理和 Token 验证功能
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
    CLERK_TOKEN_URL: 'https://clerk.orchids.app/v1/client/sessions/{sessionId}/tokens',
    CLERK_JS_VERSION: '5.114.0',
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ORIGIN: 'https://www.orchids.app',
    DEFAULT_TIMEOUT: 30000,
};

/**
 * Orchids API 服务类
 */
export class OrchidsAPI {
    /**
     * 从 clientJwt 获取 session 信息
     * @param {string} clientJwt - Clerk client JWT token
     * @returns {Promise<Object>} {success, sessionId, userId, wsToken, expiresAt, error}
     */
    static async getSessionFromClerk(clientJwt) {
        if (!clientJwt) {
            return { success: false, error: '缺少 clientJwt' };
        }

        log.info('从 Clerk API 获取 session 信息');

        try {
            const proxyConfig = getAxiosProxyConfig();
            const response = await axios.get(ORCHIDS_CONSTANTS.CLERK_CLIENT_URL, {
                headers: {
                    'Cookie': `__client=${clientJwt}`,
                    'Origin': ORCHIDS_CONSTANTS.ORIGIN,
                    'User-Agent': ORCHIDS_CONSTANTS.USER_AGENT,
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
            const sessionId = session.id;
            const userId = session.user?.id;
            const wsToken = session.last_active_token?.jwt;

            if (!sessionId || !wsToken) {
                log.error('Session 数据无效');
                return { success: false, error: 'Session 数据无效' };
            }

            // 解析 JWT 过期时间
            const expiresAt = this._parseJwtExpiry(wsToken);

            log.success('成功获取 session 信息');
            log.info(`Session ID: ${sessionId}`);
            log.info(`User ID: ${userId || 'unknown'}`);
            log.info(`Token 过期时间: ${expiresAt || '未知'}`);

            return {
                success: true,
                sessionId,
                userId,
                wsToken,
                expiresAt
            };

        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            log.fail(`获取 session 失败: ${errorMsg}`, error.response?.status);
            return {
                success: false,
                error: errorMsg,
                statusCode: error.response?.status
            };
        }
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
}

export default OrchidsAPI;
