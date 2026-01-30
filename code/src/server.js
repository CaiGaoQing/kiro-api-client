import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import crypto from 'crypto';
import { CredentialStore, UserStore, ApiKeyStore, ApiLogStore, GeminiCredentialStore, OrchidsCredentialStore, WarpCredentialStore, TrialApplicationStore, SiteSettingsStore, VertexCredentialStore, BedrockCredentialStore, ModelPricingStore, initDatabase } from './db.js';
import { KiroClient } from './kiro/client.js';
import { KiroService } from './kiro/kiro-service.js';
import { KiroAPI } from './kiro/api.js';
import { KiroAuth } from './kiro/auth.js';
import { OrchidsAPI } from './orchids/orchids-service.js';
import { OrchidsChatService, ORCHIDS_MODELS } from './orchids/orchids-chat-service.js';
import { setupOrchidsRoutes } from './orchids/orchids-routes.js';
import { OrchidsLoadBalancer, getOrchidsLoadBalancer, closeOrchidsLoadBalancer } from './orchids/orchids-loadbalancer.js';
import { WarpService, WARP_MODELS, refreshAccessToken, isTokenExpired, getEmailFromToken, parseJwtToken } from './warp/warp-service.js';
import { setupWarpRoutes } from './warp/warp-routes.js';
import { setupWarpMultiAgentRoutes } from './warp/warp-multi-agent.js';
import { setupWarpProxyRoutes } from './warp/warp-proxy.js';
import { KIRO_CONSTANTS, MODEL_PRICING, calculateTokenCost, setDynamicPricing } from './constants.js';
import { initProxyConfig, getProxyConfig, saveProxyConfig, testProxyConnection, getAxiosProxyConfig } from './proxy.js';
import {
    AntigravityApiService,
    GEMINI_MODELS,
    refreshGeminiToken,
    claudeToGeminiMessages,
    geminiToClaudeResponse,
    generateAuthUrl as generateGeminiAuthUrl,
    getTokenFromCode as getGeminiTokenFromCode,
    startOAuthFlow as startGeminiOAuthFlow
} from './gemini/antigravity-core.js';
import { setupGeminiRoutes } from './gemini/gemini-routes.js';
import { setupVertexRoutes } from './vertex/vertex-routes.js';
import bedrockRoutes from './bedrock/bedrock-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 格式化日期为本地时间字符串 (YYYY-MM-DD HH:mm:ss)
function formatLocalDateTime(date) {
    if (!date) return null;
    const d = new Date(date);
    // 转换为北京时间 (UTC+8)
    const beijingOffset = 8 * 60; // 北京时间偏移分钟数
    const utcTime = d.getTime() + d.getTimezoneOffset() * 60 * 1000;
    const beijingTime = new Date(utcTime + beijingOffset * 60 * 1000);

    const year = beijingTime.getFullYear();
    const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
    const day = String(beijingTime.getDate()).padStart(2, '0');
    const hours = String(beijingTime.getHours()).padStart(2, '0');
    const minutes = String(beijingTime.getMinutes()).padStart(2, '0');
    const seconds = String(beijingTime.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 首页 - 重定向到用量查询页面（必须在静态文件中间件之前）
app.get('/', (req, res) => {
    res.redirect('/pages/usage-query.html');
});

app.use(express.static(path.join(__dirname, 'public')));

// 信任代理，以便正确获取客户端 IP
app.set('trust proxy', true);

// ============ CORS 配置 ============

// CORS 中间件
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, Model-Provider, anthropic-version');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

let store = null;
let userStore = null;
let apiKeyStore = null;
let apiLogStore = null;
let geminiStore = null;
let orchidsStore = null;
let orchidsLoadBalancer = null;
let warpStore = null;
let warpService = null;
let trialStore = null;
let siteSettingsStore = null;
let pricingStore = null;

// 凭据 403 错误计数器
const credential403Counter = new Map();

// API 密钥 + IP 并发请求跟踪器 (key: `${apiKeyId}:${ip}`)
const apiKeyIpConcurrentRequests = new Map();

// API 密钥速率限制跟踪器 (每分钟请求数)
const apiKeyRateLimiter = new Map();

// ============ 凭据健康状态管理（参照 AIClient-2-API） ============
// 凭据健康状态：{ isHealthy, errorCount, lastErrorTime, lastErrorMessage, lastUsed, usageCount }
const credentialHealthStatus = new Map();

// 健康状态配置
const CREDENTIAL_HEALTH_CONFIG = {
    maxErrorCount: 3,           // 连续错误次数达到此值标记为不健康
    recoveryTimeMs: 5 * 60 * 1000,  // 5分钟后尝试恢复
    healthCheckIntervalMs: 10 * 60 * 1000  // 10分钟健康检查间隔
};

/**
 * 获取凭据健康状态
 */
function getCredentialHealth(credentialId) {
    if (!credentialHealthStatus.has(credentialId)) {
        credentialHealthStatus.set(credentialId, {
            isHealthy: true,
            errorCount: 0,
            lastErrorTime: null,
            lastErrorMessage: null,
            lastUsed: null,
            usageCount: 0
        });
    }
    return credentialHealthStatus.get(credentialId);
}

/**
 * 标记凭据为健康
 */
function markCredentialHealthy(credentialId) {
    const health = getCredentialHealth(credentialId);
    health.isHealthy = true;
    health.errorCount = 0;
    health.lastErrorTime = null;
    health.lastErrorMessage = null;
}

/**
 * 标记凭据为不健康
 */
function markCredentialUnhealthy(credentialId, errorMessage) {
    const health = getCredentialHealth(credentialId);
    health.errorCount++;
    health.lastErrorTime = Date.now();
    health.lastErrorMessage = errorMessage;

    if (health.errorCount >= CREDENTIAL_HEALTH_CONFIG.maxErrorCount) {
        health.isHealthy = false;
        // console.log(`[${getTimestamp()}] [凭据健康] 凭据 ${credentialId} 标记为不健康 (连续 ${health.errorCount} 次错误)`);
    }
}

/**
 * 更新凭据使用记录（用于 LRU 选择）
 */
function updateCredentialUsage(credentialId) {
    const health = getCredentialHealth(credentialId);
    health.lastUsed = Date.now();
    health.usageCount++;
}

/**
 * 检查凭据是否可以尝试恢复
 */
function canAttemptRecovery(credentialId) {
    const health = getCredentialHealth(credentialId);
    if (health.isHealthy) return true;
    if (!health.lastErrorTime) return true;

    const timeSinceError = Date.now() - health.lastErrorTime;
    return timeSinceError >= CREDENTIAL_HEALTH_CONFIG.recoveryTimeMs;
}

// ============ 凭据 Token 刷新锁 ============
// 防止同一凭据并发刷新 token
const credentialRefreshLocks = new Map();
const credentialRefreshPromises = new Map();

/**
 * 带锁的 token 刷新，确保同一凭据同一时间只有一个刷新操作
 * @returns {Promise<{success: boolean, credential?: object, error?: string}>}
 */
async function refreshTokenWithLock(credential, store) {
    const credentialId = credential.id;

    // 如果已经有刷新操作在进行，等待它完成
    if (credentialRefreshLocks.get(credentialId)) {
        // console.log(`[${getTimestamp()}] [Token刷新] 凭据 ${credentialId} 正在刷新中，等待...`);
        const existingPromise = credentialRefreshPromises.get(credentialId);
        if (existingPromise) {
            return existingPromise;
        }
    }

    // 设置锁
    credentialRefreshLocks.set(credentialId, true);

    // 创建刷新 Promise
    const refreshPromise = (async () => {
        try {
            const refreshResult = await KiroAPI.refreshToken(credential);
            if (refreshResult.success) {
                await store.update(credentialId, {
                    accessToken: refreshResult.accessToken,
                    refreshToken: refreshResult.refreshToken,
                    expiresAt: refreshResult.expiresAt
                });
                const updatedCredential = await store.getById(credentialId);
                // console.log(`[${getTimestamp()}] [Token刷新] 凭据 ${credentialId} 刷新成功`);
                return { success: true, credential: updatedCredential };
            } else {
                // console.log(`[${getTimestamp()}] [Token刷新] 凭据 ${credentialId} 刷新失败: ${refreshResult.error}`);
                return { success: false, error: refreshResult.error };
            }
        } catch (error) {
            // console.log(`[${getTimestamp()}] [Token刷新] 凭据 ${credentialId} 刷新异常: ${error.message}`);
            return { success: false, error: error.message };
        } finally {
            // 释放锁
            credentialRefreshLocks.set(credentialId, false);
            credentialRefreshPromises.delete(credentialId);
        }
    })();

    credentialRefreshPromises.set(credentialId, refreshPromise);
    return refreshPromise;
}

// ============ 凭据级别并发控制 ============
// 每个凭据最多1个并发请求，后续请求排队串行执行

// 凭据锁状态：true 表示正在使用
const credentialLocks = new Map();

// 凭据请求队列：每个凭据一个队列
const credentialQueues = new Map();

// 是否禁用凭据并发限制 (环境变量 DISABLE_CREDENTIAL_LOCK=true 时禁用)
const DISABLE_CREDENTIAL_LOCK = process.env.DISABLE_CREDENTIAL_LOCK === 'true';

/**
 * 获取凭据的请求队列
 */
function getCredentialQueue(credentialId) {
    if (!credentialQueues.has(credentialId)) {
        credentialQueues.set(credentialId, []);
    }
    return credentialQueues.get(credentialId);
}

/**
 * 获取凭据锁
 * @returns {Promise} 当获取到锁时 resolve
 */
function acquireCredentialLock(credentialId) {
    return new Promise((resolve) => {
        // 如果禁用了凭据锁，直接放行
        if (DISABLE_CREDENTIAL_LOCK) {
            resolve();
            return;
        }
        
        if (!credentialLocks.get(credentialId)) {
            // 凭据空闲，直接获取锁
            credentialLocks.set(credentialId, true);
            resolve();
        } else {
            // 凭据正在使用，加入队列等待
            const queue = getCredentialQueue(credentialId);
            queue.push(resolve);
            // console.log(`[${getTimestamp()}] [凭据队列] 凭据 ${credentialId} 正在使用，请求排队等待 (队列长度: ${queue.length})`);
        }
    });
}

/**
 * 释放凭据锁
 */
function releaseCredentialLock(credentialId) {
    // 如果禁用了凭据锁，直接返回
    if (DISABLE_CREDENTIAL_LOCK) {
        return;
    }
    
    const queue = getCredentialQueue(credentialId);
    if (queue.length > 0) {
        // 队列中有等待的请求，取出下一个
        const nextResolve = queue.shift();
        // console.log(`[${getTimestamp()}] [凭据队列] 凭据 ${credentialId} 处理下一个排队请求 (剩余队列: ${queue.length})`);
        nextResolve();
    } else {
        // 没有等待的请求，释放锁
        credentialLocks.set(credentialId, false);
    }
}

/**
 * 获取凭据当前状态
 */
function getCredentialQueueStatus(credentialId) {
    const isLocked = credentialLocks.get(credentialId) || false;
    const queueLength = getCredentialQueue(credentialId).length;
    return { isLocked, queueLength };
}

/**
 * LRU 凭据选择策略（参照 AIClient-2-API 的 ProviderPoolManager）
 * 优先级：健康 > 可恢复 > 空闲 > 最久未使用 > 队列最短
 * @param {Array} credentials - 凭据列表
 * @param {Array} excludeIds - 排除的凭据 ID 列表（用于 Fallback）
 * @returns {Object|null} 选中的凭据
 */
function selectBestCredential(credentials, excludeIds = []) {
    if (credentials.length === 0) return null;

    // 过滤掉排除的凭据
    let availableCredentials = credentials.filter(c => !excludeIds.includes(c.id));
    if (availableCredentials.length === 0) {
        // 如果所有凭据都被排除，使用原始列表
        availableCredentials = credentials;
    }

    if (availableCredentials.length === 1) return availableCredentials[0];

    // 获取每个凭据的综合状态
    const credentialsWithStatus = availableCredentials.map(c => {
        const health = getCredentialHealth(c.id);
        const queueStatus = getCredentialQueueStatus(c.id);
        return {
            credential: c,
            isHealthy: health.isHealthy,
            canRecover: canAttemptRecovery(c.id),
            errorCount: health.errorCount,
            lastUsed: health.lastUsed || 0,
            usageCount: health.usageCount || 0,
            isLocked: queueStatus.isLocked,
            queueLength: queueStatus.queueLength
        };
    });

    // 分离健康和不健康的凭据
    const healthyCredentials = credentialsWithStatus.filter(c => c.isHealthy);
    const recoverableCredentials = credentialsWithStatus.filter(c => !c.isHealthy && c.canRecover);

    // 优先使用健康的凭据，其次是可恢复的
    let candidates = healthyCredentials.length > 0 ? healthyCredentials : recoverableCredentials;
    if (candidates.length === 0) {
        // 如果没有健康或可恢复的凭据，使用所有凭据
        candidates = credentialsWithStatus;
    }

    // LRU 排序：优先选择空闲的，然后是最久未使用的
    candidates.sort((a, b) => {
        // 1. 优先选择未锁定的（空闲）
        if (!a.isLocked && b.isLocked) return -1;
        if (a.isLocked && !b.isLocked) return 1;

        // 2. 如果都空闲或都锁定，选择最久未使用的（LRU）
        if (a.lastUsed !== b.lastUsed) {
            return a.lastUsed - b.lastUsed;  // 时间戳小的（更早使用的）排前面
        }

        // 3. 如果最后使用时间相同，选择使用次数少的
        if (a.usageCount !== b.usageCount) {
            return a.usageCount - b.usageCount;
        }

        // 4. 如果都锁定，选择队列短的
        return a.queueLength - b.queueLength;
    });

    const selected = candidates[0];
    if (!selected.isHealthy) {
        // console.log(`[${getTimestamp()}] [凭据选择] 尝试恢复不健康凭据 ${selected.credential.id} (错误次数: ${selected.errorCount})`);
    } else if (selected.isLocked) {
        // console.log(`[${getTimestamp()}] [凭据选择] 所有凭据都在使用，选择队列最短的凭据 ${selected.credential.id} (队列: ${selected.queueLength})`);
    }

    return selected.credential;
}

/**
 * 生成 API Key + IP 的组合键
 */
function getConcurrentKey(apiKeyId, clientIp) {
    return `${apiKeyId}:${clientIp || 'unknown'}`;
}

/**
 * 尝试获取并发槽位（原子操作：检查+增加）
 * @returns {Object} { success: boolean, current: number }
 */
function tryAcquireConcurrentSlot(apiKeyId, clientIp, limit) {
    const key = getConcurrentKey(apiKeyId, clientIp);
    const current = apiKeyIpConcurrentRequests.get(key) || 0;
    if (limit > 0 && current >= limit) {
        return { success: false, current };
    }
    apiKeyIpConcurrentRequests.set(key, current + 1);
    return { success: true, current: current + 1 };
}

/**
 * 增加 API 密钥 + IP 的并发计数
 */
function incrementConcurrent(apiKeyId, clientIp) {
    const key = getConcurrentKey(apiKeyId, clientIp);
    const current = apiKeyIpConcurrentRequests.get(key) || 0;
    apiKeyIpConcurrentRequests.set(key, current + 1);
    return current + 1;
}

/**
 * 减少 API 密钥 + IP 的并发计数
 */
function decrementConcurrent(apiKeyId, clientIp) {
    const key = getConcurrentKey(apiKeyId, clientIp);
    const current = apiKeyIpConcurrentRequests.get(key) || 0;
    if (current > 0) {
        apiKeyIpConcurrentRequests.set(key, current - 1);
    }
}

/**
 * 获取 API 密钥 + IP 的当前并发数
 */
function getConcurrentCount(apiKeyId, clientIp) {
    const key = getConcurrentKey(apiKeyId, clientIp);
    return apiKeyIpConcurrentRequests.get(key) || 0;
}

/**
 * 获取 API 密钥的总并发数（所有 IP 的总和）
 */
function getTotalConcurrentCount(apiKeyId) {
    let total = 0;
    const prefix = `${apiKeyId}:`;
    for (const [key, count] of apiKeyIpConcurrentRequests.entries()) {
        if (key.startsWith(prefix)) {
            total += count;
        }
    }
    return total;
}

/**
 * 检查并记录速率限制
 * @returns {boolean} true 如果在限制内，false 如果超出限制
 */
function checkRateLimit(apiKeyId, rateLimit) {
    if (!rateLimit || rateLimit <= 0) return true;

    const now = Date.now();
    const windowStart = now - 60000; // 1分钟窗口

    let requests = apiKeyRateLimiter.get(apiKeyId) || [];
    // 清理过期的请求记录
    requests = requests.filter(timestamp => timestamp > windowStart);

    if (requests.length >= rateLimit) {
        apiKeyRateLimiter.set(apiKeyId, requests);
        return false;
    }

    requests.push(now);
    apiKeyRateLimiter.set(apiKeyId, requests);
    return true;
}

/**
 * 检查 API 密钥的用量限制
 * @param {Object} keyRecord - API 密钥记录
 * @param {string} clientIp - 客户端 IP 地址
 * @returns {Object} { allowed: boolean, reason?: string }
 */
async function checkUsageLimits(keyRecord, clientIp) {
    const { id, dailyLimit, monthlyLimit, totalLimit, concurrentLimit, rateLimit, dailyCostLimit, monthlyCostLimit, totalCostLimit, expiresInDays, createdAt } = keyRecord;

    // 检查有效期
    if (expiresInDays > 0 && createdAt) {
        // createdAt 是数据库存储的北京时间字符串 "YYYY-MM-DD HH:mm:ss"
        // 解析时指定为北京时间（UTC+8）
        const createDateStr = createdAt.replace(' ', 'T') + '+08:00';
        const createDate = new Date(createDateStr);
        const expireDate = new Date(createDate.getTime() + expiresInDays * 24 * 60 * 60 * 1000);
        const now = new Date();
        // console.log(`[API Key 过期检查] createdAt: ${createdAt}, createDate: ${createDate.toISOString()}, expireDate: ${expireDate.toISOString()}, now: ${now.toISOString()}, expired: ${now > expireDate}`);
        if (now > expireDate) {
            return { allowed: false, reason: `密钥已过期 (有效期 ${expiresInDays} 天)` };
        }
    }

    // 检查并发限制 (基于 API Key + IP) - 使用原子操作
    if (concurrentLimit > 0) {
        const result = tryAcquireConcurrentSlot(id, clientIp, concurrentLimit);
        // console.log(`[${getTimestamp()}] [并发检查] API Key ${id} | IP: ${clientIp} | 当前并发: ${result.current} | 限制: ${concurrentLimit} | 结果: ${result.success ? '通过' : '拒绝'}`);
        if (!result.success) {
            return { allowed: false, reason: `并发请求数已达上限 (${concurrentLimit})`, concurrentAcquired: false };
        }
        // 标记已获取并发槽位，后续不需要再调用 incrementConcurrent
        return { allowed: true, concurrentAcquired: true };
    }

    // 检查速率限制
    if (rateLimit > 0 && !checkRateLimit(id, rateLimit)) {
        return { allowed: false, reason: `请求频率超限 (${rateLimit}/分钟)` };
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // 检查用量限制
    if (dailyLimit > 0 || monthlyLimit > 0 || totalLimit > 0) {
        // 获取今日用量
        if (dailyLimit > 0) {
            const dailyStats = await apiLogStore.getStatsForApiKey(id, { startDate: todayStart });
            if (dailyStats.requestCount >= dailyLimit) {
                return { allowed: false, reason: `今日请求数已达上限 (${dailyLimit})` };
            }
        }

        // 获取本月用量
        if (monthlyLimit > 0) {
            const monthlyStats = await apiLogStore.getStatsForApiKey(id, { startDate: monthStart });
            if (monthlyStats.requestCount >= monthlyLimit) {
                return { allowed: false, reason: `本月请求数已达上限 (${monthlyLimit})` };
            }
        }

        // 获取总用量
        if (totalLimit > 0) {
            const totalStats = await apiLogStore.getStatsForApiKey(id, {});
            if (totalStats.requestCount >= totalLimit) {
                return { allowed: false, reason: `总请求数已达上限 (${totalLimit})` };
            }
        }
    }

    // 检查金额限制
    if (dailyCostLimit > 0 || monthlyCostLimit > 0 || totalCostLimit > 0) {
        // 获取今日费用
        if (dailyCostLimit > 0) {
            const dailyCost = await calculateApiKeyCost(id, { startDate: todayStart });
            if (dailyCost >= dailyCostLimit) {
                return { allowed: false, reason: `今日费用已达上限 ($${dailyCostLimit.toFixed(2)})` };
            }
        }

        // 获取本月费用
        if (monthlyCostLimit > 0) {
            const monthlyCost = await calculateApiKeyCost(id, { startDate: monthStart });
            if (monthlyCost >= monthlyCostLimit) {
                return { allowed: false, reason: `本月费用已达上限 ($${monthlyCostLimit.toFixed(2)})` };
            }
        }

        // 获取总费用
        if (totalCostLimit > 0) {
            const totalCost = await calculateApiKeyCost(id, {});
            if (totalCost >= totalCostLimit) {
                return { allowed: false, reason: `总费用已达上限 ($${totalCostLimit.toFixed(2)})` };
            }
        }
    }

    return { allowed: true };
}

/**
 * 计算 API 密钥的费用
 */
async function calculateApiKeyCost(apiKeyId, options = {}) {
    const modelStats = await apiLogStore.getStatsByModel(apiKeyId, options);
    let totalCost = 0;
    for (const stat of modelStats) {
        const cost = calculateTokenCost(stat.model, stat.inputTokens, stat.outputTokens);
        totalCost += cost.totalCost;
    }
    return totalCost;
}

/**
 * 记录凭据 403 错误，连续 2 次则移动到错误表
 */
async function recordCredential403Error(credentialId, errorMessage) {
    const count = (credential403Counter.get(credentialId) || 0) + 1;
    credential403Counter.set(credentialId, count);

    // console.log(`[${getTimestamp()}] [凭据监控] 凭据 ${credentialId} 第 ${count} 次 403 错误`);

    if (count >= 2) {
        try {
            await store.moveToError(credentialId, `连续 ${count} 次 403 错误: ${errorMessage}`);
            credential403Counter.delete(credentialId);
            // console.log(`[${getTimestamp()}] [凭据监控] 凭据 ${credentialId} 已移动到错误表`);
        } catch (e) {
            console.error(`[${getTimestamp()}] [凭据监控] 移动凭据失败: ${e.message}`);
        }
    }
}

/**
 * 清除凭据 403 错误计数（请求成功时调用）
 */
function clearCredential403Counter(credentialId) {
    if (credential403Counter.has(credentialId)) {
        credential403Counter.delete(credentialId);
    }
}

// ============ 工具函数 ============

/**
 * 获取客户端真实 IP 地址
 */
function getClientIp(req) {
    let ip = null;

    // 优先从 X-Forwarded-For 获取（代理场景）
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        // X-Forwarded-For 可能包含多个 IP，取第一个
        ip = forwarded.split(',')[0].trim();
    }
    // 其次从 X-Real-IP 获取（Nginx 等代理）
    else if (req.headers['x-real-ip']) {
        ip = req.headers['x-real-ip'];
    }
    // 最后使用 socket 连接的 IP
    else {
        ip = req.ip || req.socket?.remoteAddress || 'unknown';
    }

    // 处理 IPv6 格式的 IPv4 地址 (::ffff:192.168.1.1 -> 192.168.1.1)
    if (ip && ip.startsWith('::ffff:')) {
        ip = ip.substring(7);
    }

    return ip || 'unknown';
}

/**
 * 生成密码哈希
 */
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * 生成 API 密钥
 * @param {string} customKey - 可选的自定义密钥
 */
function generateApiKey(customKey = null) {
    let key;
    if (customKey && customKey.trim()) {
        // 使用自定义密钥，如果没有 sk- 前缀则自动添加
        key = customKey.trim();
        if (!key.startsWith('sk-')) {
            key = 'sk-' + key;
        }
    } else {
        // 自动生成密钥
        key = 'sk-' + crypto.randomBytes(32).toString('hex');
    }
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const prefix = key.substring(0, 10) + '...';
    return { key, hash, prefix };
}

/**
 * 验证 API 密钥
 */
async function verifyApiKey(key) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return await apiKeyStore.getByKeyHash(hash);
}

/**
 * 简单的 session 存储（生产环境应使用 Redis 等）
 */
const sessions = new Map();

function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId, createdAt: Date.now() });
    return token;
}

function getSession(token) {
    const session = sessions.get(token);
    if (!session) return null;
    // 24小时过期
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
        sessions.delete(token);
        return null;
    }
    return session;
}

function deleteSession(token) {
    sessions.delete(token);
}

/**
 * 认证中间件
 */
async function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ success: false, error: '未登录' });
    }
    const session = getSession(token);
    if (!session) {
        return res.status(401).json({ success: false, error: '登录已过期' });
    }
    req.userId = session.userId;
    req.user = await userStore.getById(session.userId);
    next();
}

// ============ 公开 API 端点（无需认证）============

// 健康检查端点 (参考 AIClient-2-API)
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        provider: 'claude-kiro-oauth',
        version: '1.0.0'
    });
});

// 获取客户端 IP (用于状态页面)
app.get('/api/client-ip', (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.headers['x-real-ip'] ||
               req.socket.remoteAddress ||
               '127.0.0.1';
    res.json({ ip });
});

// 负载均衡状态 (单节点模式)
app.get('/lb/status', (req, res) => {
    const port = process.env.PORT || 13004;
    res.json({
        balancer: { port: 13003, mode: 'single' },
        summary: { total: 1, healthy: 1, unhealthy: 0 },
        backends: [{
            host: '127.0.0.1',
            port: parseInt(port),
            healthy: true,
            reachable: true,
            latency: '1ms',
            error: null,
            lastCheck: new Date().toISOString()
        }],
        cache: { size: 0 },
        timestamp: new Date().toISOString()
    });
});

// 模型列表端点 - OpenAI 格式
app.get('/v1/models', (req, res) => {
    const models = Object.keys(KIRO_CONSTANTS.MODEL_MAPPING || {});
    const defaultModels = [
        'claude-sonnet-4-20250514',
        'claude-opus-4-5-20251101',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-sonnet-20240620',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
        'claude-3-5-haiku-20241022'
    ];

    const modelList = (models.length > 0 ? models : defaultModels).map(id => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'anthropic',
        permission: [],
        root: id,
        parent: null
    }));

    res.json({
        object: 'list',
        data: modelList
    });
});

// ============ 认证 API ============

// 检查是否需要初始化（是否有用户）
app.get('/api/auth/status', async (req, res) => {
    try {
        const hasUsers = await userStore.hasUsers();
        res.json({ success: true, data: { needsSetup: !hasUsers } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 初始化管理员账户
app.post('/api/auth/setup', async (req, res) => {
    try {
        if (await userStore.hasUsers()) {
            return res.status(400).json({ success: false, error: '系统已初始化' });
        }
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, error: '用户名和密码是必需的' });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: '密码至少6位' });
        }
        const passwordHash = hashPassword(password);
        const userId = await userStore.create(username, passwordHash, true);
        const token = createSession(userId);
        res.json({ success: true, data: { token, userId, username, isAdmin: true } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 登录
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, error: '用户名和密码是必需的' });
        }
        const user = await userStore.getByUsername(username);
        if (!user) {
            return res.status(401).json({ success: false, error: '用户名或密码错误' });
        }
        const passwordHash = hashPassword(password);
        if (user.passwordHash !== passwordHash) {
            return res.status(401).json({ success: false, error: '用户名或密码错误' });
        }
        const token = createSession(user.id);
        res.json({ success: true, data: { token, userId: user.id, username: user.username, isAdmin: user.isAdmin } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 登出
app.post('/api/auth/logout', (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token) {
        deleteSession(token);
    }
    res.json({ success: true });
});

// 获取当前用户信息
app.get('/api/auth/me', authMiddleware, async (req, res) => {
    res.json({
        success: true,
        data: {
            userId: req.user.id,
            username: req.user.username,
            isAdmin: req.user.isAdmin
        }
    });
});

// 修改密码
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;

        if (!oldPassword || !newPassword) {
            return res.status(400).json({ success: false, error: '请提供旧密码和新密码' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: '新密码长度至少6位' });
        }

        // 验证旧密码
        const user = await userStore.getById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        const oldPasswordHash = hashPassword(oldPassword);
        if (user.passwordHash !== oldPasswordHash) {
            return res.status(400).json({ success: false, error: '旧密码错误' });
        }

        // 更新密码
        const newPasswordHash = hashPassword(newPassword);
        await userStore.updatePassword(req.user.id, newPasswordHash);

        res.json({ success: true, message: '密码修改成功' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ 站点设置 API ============

// 获取站点设置（公开接口，无需登录）
app.get('/api/site-settings', async (req, res) => {
    try {
        const settings = await siteSettingsStore.get();
        res.json({ success: true, data: settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 更新站点设置（管理员接口）
app.put('/api/site-settings', authMiddleware, async (req, res) => {
    try {
        const { siteName, siteLogo, siteSubtitle } = req.body;

        // 验证 siteLogo 长度
        if (siteLogo && siteLogo.length > 10) {
            return res.status(400).json({ success: false, error: 'Logo 文字最多 10 个字符' });
        }

        const settings = await siteSettingsStore.update({
            siteName: siteName || 'Kiro',
            siteLogo: siteLogo || 'K',
            siteSubtitle: siteSubtitle || 'Account Manager'
        });

        res.json({ success: true, data: settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ 试用申请 API ============

// 提交试用申请（公开接口，无需登录）
app.post('/api/trial/apply', async (req, res) => {
    try {
        const { xianyuName, email, source, orderScreenshot } = req.body;

        if (!xianyuName || !email) {
            return res.status(400).json({ success: false, error: '咸鱼名称和邮箱是必填项' });
        }

        // 验证邮箱格式
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, error: '邮箱格式不正确' });
        }

        const id = await trialStore.add({
            xianyuName,
            email,
            source: source || null,
            orderScreenshot: orderScreenshot || null
        });

        res.json({ success: true, data: { id, message: '申请提交成功，请等待审核' } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 查询申请状态（公开接口，根据邮箱查询）
app.get('/api/trial/query', async (req, res) => {
    try {
        const { email } = req.query;

        if (!email) {
            return res.status(400).json({ success: false, error: '请提供邮箱地址' });
        }

        const application = await trialStore.getLatestByEmail(email);

        if (!application) {
            return res.status(404).json({ success: false, error: '未找到相关申请记录' });
        }

        // 返回申请信息（隐藏截图数据以减少传输）
        const result = {
            id: application.id,
            xianyuName: application.xianyuName,
            email: application.email,
            source: application.source,
            status: application.status,
            rejectReason: application.rejectReason,
            createdAt: application.createdAt
        };

        // 如果已通过，返回 API Key 信息
        if (application.status === 'approved') {
            result.apiKey = application.apiKey;
            result.apiKeyExpiresAt = application.apiKeyExpiresAt;
            result.costLimit = application.costLimit;
        }

        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取申请列表（管理员接口）
app.get('/api/trial/admin/list', authMiddleware, async (req, res) => {
    try {
        const { status, page, pageSize } = req.query;
        const result = await trialStore.getAll({ status, page, pageSize });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取申请统计（管理员接口）
app.get('/api/trial/admin/stats', authMiddleware, async (req, res) => {
    try {
        const stats = await trialStore.getStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 审批通过（管理员接口）
app.post('/api/trial/admin/:id/approve', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { costLimit = 50, expireHours = 24 } = req.body;

        const application = await trialStore.getById(id);
        if (!application) {
            return res.status(404).json({ success: false, error: '申请不存在' });
        }

        if (application.status !== 'pending') {
            return res.status(400).json({ success: false, error: '该申请已处理' });
        }

        // 生成 API Key
        const { key, hash, prefix } = generateApiKey();

        // 计算过期时间
        const expiresAt = new Date(Date.now() + expireHours * 60 * 60 * 1000);

        // 创建 API Key 记录（关联到管理员用户）
        const keyId = await apiKeyStore.create(req.userId, `试用-${application.xianyuName}`, key, hash, prefix);

        // 设置 API Key 限制
        await apiKeyStore.updateLimits(keyId, {
            totalCostLimit: costLimit,
            expiresInDays: Math.ceil(expireHours / 24)
        });

        // 更新申请状态
        await trialStore.approve(id, req.userId, key, expiresAt, costLimit);

        res.json({
            success: true,
            data: {
                apiKey: key,
                expiresAt,
                costLimit,
                message: '审批通过，API Key 已生成'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 审批拒绝（管理员接口）
app.post('/api/trial/admin/:id/reject', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        const application = await trialStore.getById(id);
        if (!application) {
            return res.status(404).json({ success: false, error: '申请不存在' });
        }

        if (application.status !== 'pending') {
            return res.status(400).json({ success: false, error: '该申请已处理' });
        }

        await trialStore.reject(id, req.userId, reason);

        res.json({ success: true, data: { message: '已拒绝申请' } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除申请记录（管理员接口）
app.delete('/api/trial/admin/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await trialStore.delete(id);
        res.json({ success: true, data: { message: '删除成功' } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API 密钥管理 ============

// 获取当前用户的 API 密钥列表
app.get('/api/keys', authMiddleware, async (req, res) => {
    try {
        const keys = req.user.isAdmin ? await apiKeyStore.getAll() : await apiKeyStore.getByUserId(req.userId);
        // 返回完整信息（包含 keyValue）
        const safeKeys = keys.map(k => ({
            id: k.id,
            userId: k.userId,
            username: k.username,
            name: k.name,
            keyValue: k.keyValue,
            keyPrefix: k.keyPrefix,
            isActive: k.isActive,
            lastUsedAt: k.lastUsedAt,
            createdAt: k.createdAt
        }));
        res.json({ success: true, data: safeKeys });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 创建 API 密钥
app.post('/api/keys', authMiddleware, async (req, res) => {
    try {
        const { name, customKey } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: '密钥名称是必需的' });
        }
        const { key, hash, prefix } = generateApiKey(customKey);

        // 检查密钥是否已存在
        const existingKey = await apiKeyStore.getByKeyHash(hash);
        if (existingKey) {
            return res.status(400).json({ success: false, error: '该密钥已存在' });
        }

        const id = await apiKeyStore.create(req.userId, name, key, hash, prefix);
        // 只在创建时返回完整密钥
        res.json({
            success: true,
            data: {
                id,
                name,
                key, // 完整密钥，只显示一次
                keyPrefix: prefix,
                createdAt: new Date().toISOString()
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除 API 密钥
app.delete('/api/keys/:id', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const keys = await apiKeyStore.getByUserId(req.userId);
        const key = keys.find(k => k.id === id);
        if (!key && !req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '无权删除此密钥' });
        }
        await apiKeyStore.delete(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 禁用/启用 API 密钥
app.post('/api/keys/:id/toggle', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const keys = await apiKeyStore.getByUserId(req.userId);
        const key = keys.find(k => k.id === id);
        if (!key && !req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '无权操作此密钥' });
        }
        // 获取当前状态
        const allKeys = await apiKeyStore.getAll();
        const targetKey = allKeys.find(k => k.id === id);
        if (targetKey.isActive) {
            await apiKeyStore.disable(id);
        } else {
            await apiKeyStore.enable(id);
        }
        res.json({ success: true, data: { isActive: !targetKey.isActive } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取单个 API 密钥详情（包含限制配置）
app.get('/api/keys/:id', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const key = await apiKeyStore.getById(id);
        if (!key) {
            return res.status(404).json({ success: false, error: '密钥不存在' });
        }
        // 检查权限
        if (key.userId !== req.userId && !req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '无权查看此密钥' });
        }
        res.json({ success: true, data: key });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 更新 API 密钥限制配置
app.put('/api/keys/:id/limits', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const key = await apiKeyStore.getById(id);
        if (!key) {
            return res.status(404).json({ success: false, error: '密钥不存在' });
        }
        // 检查权限（只有管理员可以修改限制）
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '只有管理员可以修改限制配置' });
        }

        const { dailyLimit, monthlyLimit, totalLimit, concurrentLimit, rateLimit, dailyCostLimit, monthlyCostLimit, totalCostLimit, expiresInDays } = req.body;

        // 验证参数
        const limits = {};
        if (dailyLimit !== undefined) {
            limits.dailyLimit = Math.max(0, parseInt(dailyLimit) || 0);
        }
        if (monthlyLimit !== undefined) {
            limits.monthlyLimit = Math.max(0, parseInt(monthlyLimit) || 0);
        }
        if (totalLimit !== undefined) {
            limits.totalLimit = Math.max(0, parseInt(totalLimit) || 0);
        }
        if (concurrentLimit !== undefined) {
            limits.concurrentLimit = Math.max(0, parseInt(concurrentLimit) || 0);
        }
        if (rateLimit !== undefined) {
            limits.rateLimit = Math.max(0, parseInt(rateLimit) || 0);
        }
        // 金额限制
        if (dailyCostLimit !== undefined) {
            limits.dailyCostLimit = Math.max(0, parseFloat(dailyCostLimit) || 0);
        }
        if (monthlyCostLimit !== undefined) {
            limits.monthlyCostLimit = Math.max(0, parseFloat(monthlyCostLimit) || 0);
        }
        if (totalCostLimit !== undefined) {
            limits.totalCostLimit = Math.max(0, parseFloat(totalCostLimit) || 0);
        }
        // 有效期
        if (expiresInDays !== undefined) {
            limits.expiresInDays = Math.max(0, parseInt(expiresInDays) || 0);
        }

        await apiKeyStore.updateLimits(id, limits);

        // 返回更新后的密钥信息
        const updatedKey = await apiKeyStore.getById(id);
        res.json({ success: true, data: updatedKey });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 续费 API 密钥（增加有效期天数）
app.post('/api/keys/:id/renew', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const key = await apiKeyStore.getById(id);
        if (!key) {
            return res.status(404).json({ success: false, error: '密钥不存在' });
        }
        // 检查权限（只有管理员可以续费）
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '只有管理员可以续费' });
        }

        const { days } = req.body;
        if (!days || days <= 0) {
            return res.status(400).json({ success: false, error: '续费天数必须大于 0' });
        }

        const result = await apiKeyStore.renew(id, parseInt(days));
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取 API 密钥的当前用量统计（包含限制对比）
app.get('/api/keys/:id/limits-status', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const key = await apiKeyStore.getById(id);
        if (!key) {
            return res.status(404).json({ success: false, error: '密钥不存在' });
        }
        // 检查权限
        if (key.userId !== req.userId && !req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '无权查看此密钥' });
        }

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        // 获取各时间段的用量
        const dailyStats = await apiLogStore.getStatsForApiKey(id, { startDate: todayStart });
        const monthlyStats = await apiLogStore.getStatsForApiKey(id, { startDate: monthStart });
        const totalStats = await apiLogStore.getStatsForApiKey(id, {});

        // 获取当前并发数（所有 IP 的总和）
        const currentConcurrent = getTotalConcurrentCount(id);

        // 计算费用
        const dailyCost = calculateApiKeyCost(id, { startDate: todayStart });
        const monthlyCost = calculateApiKeyCost(id, { startDate: monthStart });
        const totalCost = calculateApiKeyCost(id, {});

        // 计算有效期剩余天数
        let remainingDays = null;
        let expireDate = null;
        if (key.expiresInDays > 0 && key.createdAt) {
            // createdAt 是数据库存储的北京时间字符串 "YYYY-MM-DD HH:mm:ss"
            // 解析时指定为北京时间（UTC+8）
            const createDateStr = key.createdAt.replace(' ', 'T') + '+08:00';
            const createDate = new Date(createDateStr);
            // 添加天数
            expireDate = new Date(createDate.getTime() + key.expiresInDays * 24 * 60 * 60 * 1000);
            remainingDays = Math.max(0, Math.ceil((expireDate - now) / (24 * 60 * 60 * 1000)));
        }

        res.json({
            success: true,
            data: {
                limits: {
                    dailyLimit: key.dailyLimit,
                    monthlyLimit: key.monthlyLimit,
                    totalLimit: key.totalLimit,
                    concurrentLimit: key.concurrentLimit,
        rateLimit: key.rateLimit,
                    dailyCostLimit: key.dailyCostLimit,
                    monthlyCostLimit: key.monthlyCostLimit,
                    totalCostLimit: key.totalCostLimit,
                    expiresInDays: key.expiresInDays
                },
                usage: {
                    daily: dailyStats.requestCount,
                    monthly: monthlyStats.requestCount,
                    total: totalStats.requestCount,
                    currentConcurrent,
                    dailyCost,
                    monthlyCost,
                    totalCost
                },
                remaining: {
                    daily: key.dailyLimit > 0 ? Math.max(0, key.dailyLimit - dailyStats.requestCount) : null,
                    monthly: key.monthlyLimit > 0 ? Math.max(0, key.monthlyLimit - monthlyStats.requestCount) : null,
                    total: key.totalLimit > 0 ? Math.max(0, key.totalLimit - totalStats.requestCount) : null,
                    concurrent: key.concurrentLimit > 0 ? Math.max(0, key.concurrentLimit - currentConcurrent) : null,
                    dailyCost: key.dailyCostLimit > 0 ? Math.max(0, key.dailyCostLimit - dailyCost) : null,
                    monthlyCost: key.monthlyCostLimit > 0 ? Math.max(0, key.monthlyCostLimit - monthlyCost) : null,
                    totalCost: key.totalCostLimit > 0 ? Math.max(0, key.totalCostLimit - totalCost) : null,
                    days: remainingDays
                },
                expireDate: formatLocalDateTime(expireDate)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ 外部 API 转发（通过 API 密钥认证）============

/**
 * 执行带 Fallback 的 API 请求（参照 AIClient-2-API 的 handleStreamRequest）
 * @param {Object} options - 请求选项
 * @returns {Promise<Object>} 响应结果
 */
async function executeWithFallback(options) {
    const {
        credentials,
        requestModel,
        requestBody,
        maxRetries = 2,  // 最多尝试的凭据数量
        excludeIds = [],
        stream = false
    } = options;

    let lastError = null;
    const triedCredentialIds = [...excludeIds];

    for (let attempt = 0; attempt < maxRetries && attempt < credentials.length; attempt++) {
        // 选择凭据（排除已尝试过的）
        const credential = selectBestCredential(credentials, triedCredentialIds);
        if (!credential) {
            break;
        }

        triedCredentialIds.push(credential.id);

        try {
            // 获取凭据锁
            await acquireCredentialLock(credential.id);

            // 检查并刷新 token
            let activeCredential = credential;
            if (credential.refreshToken && isTokenExpiringSoon(credential)) {
                // console.log(`[${getTimestamp()}] [Fallback] 凭据 ${credential.id} token 即将过期，先刷新...`);
                const refreshResult = await refreshTokenWithLock(credential, store);
                if (refreshResult.success && refreshResult.credential) {
                    activeCredential = refreshResult.credential;
                }
            }

            // 更新使用记录
            updateCredentialUsage(credential.id);

            // 创建服务并执行请求
            const service = new KiroService(activeCredential);

            if (stream) {
                // 流式请求 - 返回生成器
                return {
                    success: true,
                    credential: activeCredential,
                    generator: service.generateContentStream(requestModel, requestBody)
                };
            } else {
                // 非流式请求
                const response = await service.generateContent(requestModel, requestBody);

                // 请求成功，标记凭据为健康
                markCredentialHealthy(credential.id);
                releaseCredentialLock(credential.id);

                return {
                    success: true,
                    credential: activeCredential,
                    response
                };
            }
        } catch (error) {
            // 释放凭据锁
            releaseCredentialLock(credential.id);

            const errorStatus = error.status || error.response?.status;
            lastError = error;

            // console.log(`[${getTimestamp()}] [Fallback] 凭据 ${credential.id} 请求失败 (${errorStatus}): ${error.message}`);

            // 根据错误类型决定是否标记为不健康
            if (errorStatus === 401 || errorStatus === 403) {
                // 认证错误 - 标记为不健康，尝试下一个凭据
                markCredentialUnhealthy(credential.id, error.message);
                // console.log(`[${getTimestamp()}] [Fallback] 尝试下一个凭据... (已尝试 ${attempt + 1}/${maxRetries})`);
                continue;
            } else if (errorStatus === 429) {
                // 速率限制 - 标记为不健康，尝试下一个凭据
                markCredentialUnhealthy(credential.id, 'Rate limited');
                // console.log(`[${getTimestamp()}] [Fallback] 凭据 ${credential.id} 被限流，尝试下一个凭据...`);
                continue;
            } else if (errorStatus >= 500) {
                // 服务器错误 - 不标记为不健康（可能是临时问题），但尝试下一个凭据
                // console.log(`[${getTimestamp()}] [Fallback] 服务器错误 ${errorStatus}，尝试下一个凭据...`);
                continue;
            } else {
                // 其他错误（如请求格式错误）- 不重试，直接返回错误
                throw error;
            }
        }
    }

    // 所有凭据都失败了
    throw lastError || new Error('All credentials failed');
}

// Claude API 兼容接口
app.post('/v1/messages', async (req, res) => {
    const startTime = Date.now();
    const requestId = 'req_' + Date.now() + Math.random().toString(36).substring(2, 8);
    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    // 日志数据
    let logData = {
        requestId,
        ipAddress: clientIp,
        userAgent,
        method: 'POST',
        path: '/v1/messages',
        stream: false,
        inputTokens: 0,
        outputTokens: 0,
        statusCode: 200
    };

    try {
        const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
        const keyPrefix = apiKey ? apiKey.substring(0, 8) : '?';
        const reqModel = req.body?.model;
        const reqStream = req.body?.stream;

        // 打印请求日志
        console.log(`[${getTimestamp()}] /v1/messages | ip=${clientIp} | key=${keyPrefix}*** | model=${reqModel || '?'} | stream=${Boolean(reqStream)}`);

        if (!apiKey) {
            logData.statusCode = 401;
            logData.errorMessage = 'Missing API key';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            console.error(`  ✗ ${Date.now() - startTime}ms | error: Missing API key`);
            return res.status(401).json({ error: { type: 'authentication_error', message: 'Missing API key' } });
        }

        const keyRecord = await verifyApiKey(apiKey);
        if (!keyRecord) {
            logData.statusCode = 401;
            logData.errorMessage = 'Invalid API key';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            console.error(`  ✗ ${Date.now() - startTime}ms | error: Invalid API key`);
            return res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid API key' } });
        }

        // 记录 API 密钥信息
        logData.apiKeyId = keyRecord.id;
        logData.apiKeyPrefix = keyRecord.keyPrefix;

        // 检查用量限制（包含并发限制检查，基于 API Key + IP）
        const limitCheck = await checkUsageLimits(keyRecord, clientIp);
        if (!limitCheck.allowed) {
            logData.statusCode = 429;
            logData.errorMessage = limitCheck.reason;
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            console.error(`  ✗ ${Date.now() - startTime}ms | error: ${limitCheck.reason}`);
            return res.status(429).json({ error: { type: 'rate_limit_error', message: limitCheck.reason } });
        }

        // 如果并发限制检查时没有获取槽位，则手动增加并发计数
        if (!limitCheck.concurrentAcquired) {
            incrementConcurrent(keyRecord.id, clientIp);
        }

        // 更新最后使用时间
        await apiKeyStore.updateLastUsed(keyRecord.id);

        // ============ Model-Provider 路由支持（参照 AIClient-2-API）============
        // 通过请求头 Model-Provider 或模型名称前缀指定 Provider
        const modelProvider = req.headers['model-provider'] || req.headers['x-model-provider'] || '';
        const { model } = req.body;

        // 检查是否需要路由到 Gemini
        const isGeminiProvider = modelProvider.toLowerCase() === 'gemini' ||
                                 modelProvider.toLowerCase() === 'gemini-antigravity' ||
                                 (model && model.toLowerCase().startsWith('gemini'));

        if (isGeminiProvider) {
            // 路由到 Gemini Antigravity 处理
            // console.log(`[${getTimestamp()}] [API] 请求 ${requestId} 路由到 Gemini Provider | Model: ${model}`);
            logData.path = '/v1/messages (gemini)';

            // 释放并发槽位（Gemini 处理函数会重新获取）
            decrementConcurrent(keyRecord.id, clientIp);

            // 调用 Gemini 处理函数
            return handleGeminiAntigravityRequest(req, res);
        }

        // 检查是否需要路由到 Orchids
        const isOrchidsProvider = modelProvider.toLowerCase() === 'orchids' ||
                                  (model && ORCHIDS_MODELS.includes(model));

        if (isOrchidsProvider) {
            // 路由到 Orchids 处理
            // console.log(`[${getTimestamp()}] [API] 请求 ${requestId} 路由到 Orchids Provider | Model: ${model}`);
            logData.path = '/v1/messages (orchids)';

            const { messages, max_tokens, stream, system } = req.body;

            // 获取 Orchids 凭证
            const orchidsCredentials = await orchidsStore.getAll();
            if (orchidsCredentials.length === 0) {
                decrementConcurrent(keyRecord.id, clientIp);
                logData.statusCode = 503;
                logData.errorMessage = 'No available Orchids credentials';
                await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
                return res.status(503).json({ error: { type: 'service_error', message: 'No available Orchids credentials' } });
            }

            // 选择活跃凭证或第一个凭证
            const orchidsCredential = orchidsCredentials.find(c => c.isActive) || orchidsCredentials[0];
            logData.credentialId = orchidsCredential.id;
            logData.credentialName = orchidsCredential.name;
            logData.model = model || 'claude-sonnet-4-5';
            logData.stream = !!stream;

            try {
                const orchidsService = new OrchidsChatService(orchidsCredential);
                const requestBody = { messages, system, max_tokens };

                if (stream) {
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.setHeader('X-Accel-Buffering', 'no');

                    let outputTokens = 0;
                    try {
                        for await (const event of orchidsService.generateContentStream(model, requestBody)) {
                            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                            if (event.usage?.output_tokens) {
                                outputTokens = event.usage.output_tokens;
                            }
                        }
                        logData.outputTokens = outputTokens;
                        logData.statusCode = 200;
                    } catch (streamError) {
                        const errorEvent = {
                            type: 'error',
                            error: { type: 'api_error', message: streamError.message }
                        };
                        res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                        logData.statusCode = 500;
                        logData.errorMessage = streamError.message;
                    }
                    res.end();
                } else {
                    const response = await orchidsService.generateContent(model, requestBody);
                    logData.outputTokens = response.usage?.output_tokens || 0;
                    logData.statusCode = 200;
                    res.json(response);
                }
            } catch (error) {
                logData.statusCode = 500;
                logData.errorMessage = error.message;
                res.status(500).json({ error: { type: 'api_error', message: error.message } });
            } finally {
                decrementConcurrent(keyRecord.id, clientIp);
                await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            }
            return;
        }

        // ============ 默认使用 Kiro/Claude Provider ============
        const { messages, max_tokens, stream, system, tools, thinking } = req.body;

        // 记录请求信息
        logData.model = model || 'claude-sonnet-4-20250514';
        logData.stream = !!stream;

        // 获取所有可用凭据
        const credentials = await store.getAll();
        if (credentials.length === 0) {
            decrementConcurrent(keyRecord.id, clientIp);
            logData.statusCode = 503;
            logData.errorMessage = 'No available credentials';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(503).json({ error: { type: 'service_error', message: 'No available credentials' } });
        }

        // 构建请求体
        const requestBody = { messages, system, tools };
        const messageId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 8);
        const requestModel = model || 'claude-sonnet-4-20250514';

        // 粗略估算输入 token 数
        const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
        logData.inputTokens = inputTokens;

        // 打印请求日志
        // console.log(`[${getTimestamp()}] [API] 请求 ${requestId} | IP: ${clientIp} | Key: ${keyRecord.keyPrefix} | Model: ${requestModel} | Stream: ${!!stream} | 可用凭据: ${credentials.length}`);

        if (stream) {
            // ============ 流式响应（带 Fallback）============
            await apiLogStore.create({ ...logData, durationMs: 0 });

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let credential = null;
            let fullText = '';
            let outputTokens = 0;
            const toolCalls = [];
            let hasToolUse = false;
            let streamStarted = false;

            try {
                // 使用 Fallback 机制获取凭据和生成器
                const result = await executeWithFallback({
                    credentials,
                    requestModel,
                    requestBody,
                    maxRetries: Math.min(3, credentials.length),
                    stream: true
                });

                credential = result.credential;
                logData.credentialId = credential.id;
                logData.credentialName = credential.name;

                console.log(`[${getTimestamp()}] [API] 使用账号: ${credential.name}`);

                // 发送 message_start 事件
                res.write(`event: message_start\ndata: ${JSON.stringify({
                    type: 'message_start',
                    message: {
                        id: messageId,
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: requestModel,
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: inputTokens, output_tokens: 0 }
                    }
                })}\n\n`);

                // 发送 content_block_start 事件
                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' }
                })}\n\n`);

                streamStarted = true;

                // 处理流式响应
                for await (const event of result.generator) {
                    if (event.type === 'content_block_delta' && event.delta?.text) {
                        fullText += event.delta.text;
                        outputTokens += Math.ceil(event.delta.text.length / 4);
                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                            type: 'content_block_delta',
                            index: 0,
                            delta: { type: 'text_delta', text: event.delta.text }
                        })}\n\n`);
             } else if (event.type === 'tool_use' && event.toolUse) {
                        hasToolUse = true;
                        toolCalls.push(event.toolUse);
                    }
                }

                // 流式响应成功，标记凭据为健康
                markCredentialHealthy(credential.id);

                // 发送 content_block_stop 事件
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: 0
                })}\n\n`);

                // 处理工具调用
                if (toolCalls.length > 0) {
                    for (let i = 0; i < toolCalls.length; i++) {
                        const tc = toolCalls[i];
                        const blockIndex = i + 1;

                        res.write(`event: content_block_start\ndata: ${JSON.stringify({
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: { type: 'tool_use', id: tc.toolUseId, name: tc.name, input: {} }
                        })}\n\n`);

                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'input_json_delta', partial_json: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {}) }
                        })}\n\n`);

                        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);

                        outputTokens += Math.ceil(JSON.stringify(tc.input || {}).length / 4);
                    }
                }

                // 发送 message_delta 和 message_stop 事件
                res.write(`event: message_delta\ndata: ${JSON.stringify({
                    type: 'message_delta',
                    delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
                    usage: { output_tokens: outputTokens }
                })}\n\n`);

                res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                res.end();

                // 更新日志
                const durationMs = Date.now() - startTime;
                console.log(`  ✓ ${durationMs}ms | in=${inputTokens} out=${outputTokens}`);
                await apiLogStore.update(requestId, { outputTokens, statusCode: 200, durationMs });

                // 释放凭据锁
                releaseCredentialLock(credential.id);
                decrementConcurrent(keyRecord.id, clientIp);

            } catch (streamError) {
                // 释放资源
                if (credential) {
                    releaseCredentialLock(credential.id);
                    markCredentialUnhealthy(credential.id, streamError.message);
                }
                decrementConcurrent(keyRecord.id, clientIp);

                const durationMs = Date.now() - startTime;
                const errorStatus = streamError.status || streamError.response?.status || 500;

                console.error(`  ✗ ${durationMs}ms | error: ${streamError.message}`);

                await apiLogStore.update(requestId, {
                    outputTokens,
                    statusCode: errorStatus,
                    errorMessage: streamError.message,
                    durationMs
                });

                // 屏蔽特定的错误消息，返回友好提示
                let userFriendlyMessage = streamError.message;
                if (errorStatus === 403 && (
                    streamError.message.includes('AccessDeniedException') ||
                    streamError.message.includes('Please run /login') ||
                    streamError.message.includes('服务处理错误')
                )) {
                    userFriendlyMessage = '服务暂时不可用，请稍后重试';
                } else if (errorStatus === 400 && streamError.message.includes('ValidationException')) {
                    userFriendlyMessage = '上下文超出限制，或工具参数过多，请关闭窗口，重新对话，或恢复对话';
                }

                if (streamStarted) {
                    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: userFriendlyMessage } })}\n\n`);
                    res.end();
                } else {
                    res.status(errorStatus).json({ error: { type: 'api_error', message: userFriendlyMessage } });
                }
            }
        } else {
            // ============ 非流式响应（带 Fallback）============
            let credential = null;

            try {
                const result = await executeWithFallback({
                    credentials,
                    requestModel,
                    requestBody,
                    maxRetries: Math.min(3, credentials.length),
                    stream: false
                });

                credential = result.credential;
                logData.credentialId = credential.id;
                logData.credentialName = credential.name;

                console.log(`[${getTimestamp()}] [API] 使用账号: ${credential.name}`);

                const response = result.response;

                // 构建响应内容
                const content = [];
                let outputTokens = 0;
                let stopReason = 'end_turn';
                let responseText = '';

                if (response.content) {
                    content.push({ type: 'text', text: response.content });
                    outputTokens += Math.ceil(response.content.length / 4);
                }

                if (response.toolCalls && response.toolCalls.length > 0) {
                    stopReason = 'tool_use';
                    for (const tc of response.toolCalls) {
                        content.push({ type: 'tool_use', id: tc.toolUseId, name: tc.name, input: tc.input });
                        outputTokens += Math.ceil(JSON.stringify(tc.input || {}).length / 4);
                    }
                }

                const durationMs = Date.now() - startTime;
                console.log(`  ✓ ${durationMs}ms | in=${inputTokens} out=${outputTokens}`);

                await apiLogStore.create({ ...logData, outputTokens, durationMs });
                decrementConcurrent(keyRecord.id, clientIp);

                res.json({
                    id: messageId,
                    type: 'message',
                    role: 'assistant',
                    content,
                    model: requestModel,
                    stop_reason: stopReason,
                    stop_sequence: null,
                    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
                });

            } catch (error) {
                if (credential) {
                    markCredentialUnhealthy(credential.id, error.message);
                }
                decrementConcurrent(keyRecord.id, clientIp);

                const durationMs = Date.now() - startTime;
                const errorStatus = error.status || error.response?.status || 500;

                console.error(`  ✗ ${durationMs}ms | error: ${error.message}`);

                logData.statusCode = errorStatus;
                logData.errorMessage = error.message;
                await apiLogStore.create({ ...logData, durationMs });

                // 屏蔽特定的错误消息，返回友好提示
                let userFriendlyMessage = error.message;
                if (errorStatus === 403 && (
                    error.message.includes('AccessDeniedException') ||
                    error.message.includes('Please run /login') ||
                    error.message.includes('服务处理错误')
                )) {
                    userFriendlyMessage = '服务暂时不可用，请稍后重试';
                } else if (errorStatus === 400 && error.message.includes('ValidationException')) {
                    userFriendlyMessage = '请求参数验证失败，请检查输入';
                }

                res.status(errorStatus).json({ error: { type: 'api_error', message: userFriendlyMessage } });
            }
        }
    } catch (error) {
        // 减少并发计数（如果已经增加过）
        if (logData.apiKeyId) {
            decrementConcurrent(logData.apiKeyId, clientIp);
        }

        const durationMs = Date.now() - startTime;
        const outerErrorStatus = error.response?.status || error.status || 500;
        logData.statusCode = outerErrorStatus;
        logData.errorMessage = error.message;
        logData.durationMs = durationMs;

        console.error(`  ✗ ${durationMs}ms | error: ${error.message}`);

        // 记录错误日志
        if (!logData.apiKeyId) {
            await apiLogStore.create(logData);
        }

        // 屏蔽特定的错误消息，返回友好提示
        let userFriendlyMessage = error.message;
        if (outerErrorStatus === 403 && (
            error.message.includes('AccessDeniedException') ||
            error.message.includes('Please run /login') ||
            error.message.includes('服务处理错误')
        )) {
            userFriendlyMessage = '服务暂时不可用，请稍后重试';
        } else if (outerErrorStatus === 400 && error.message.includes('ValidationException')) {
            userFriendlyMessage = '请求参数验证失败，请检查输入';
        }

        if (!res.headersSent) {
            res.status(outerErrorStatus).json({ error: { type: 'api_error', message: userFriendlyMessage } });
        } else {
            try {
                res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: userFriendlyMessage } })}\n\n`);
                res.end();
            } catch (e) {
                // 忽略写入错误
            }
        }
    }
});


// ============ Gemini Antigravity API 端点 ============

// Gemini 凭证池选择 - LRU 策略（最久未使用优先）
async function selectGeminiCredential(requestedModel = null, excludeIds = []) {
    const allCredentials = await geminiStore.getAllActive();
    if (allCredentials.length === 0) return null;

    // 过滤掉排除的凭证
    let availableCredentials = allCredentials.filter(c => !excludeIds.includes(c.id));
    if (availableCredentials.length === 0) {
        // 如果所有凭证都被排除，重置排除列表
        availableCredentials = allCredentials;
    }

    // 过滤健康的凭证（错误次数小于阈值 且 projectId 不为空）
    const maxErrorCount = 5;
    let healthyCredentials = availableCredentials.filter(c =>
        (c.errorCount || 0) < maxErrorCount && c.projectId
    );

    // 如果没有健康凭证，尝试只过滤 projectId 不为空的
    if (healthyCredentials.length === 0) {
        healthyCredentials = availableCredentials.filter(c => c.projectId);
    }

    // 如果仍然没有，使用所有可用凭证（会触发 onboarding）
    if (healthyCredentials.length === 0) {
        healthyCredentials = availableCredentials;
    }

    // LRU 策略：按最后使用时间排序，优先选择最久未使用的
    healthyCredentials.sort((a, b) => {
        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        if (timeA !== timeB) return timeA - timeB;
        return (a.errorCount || 0) - (b.errorCount || 0);
    });

    return healthyCredentials[0];
}

// Gemini Token 过期检查（提前 50 分钟刷新）
function isGeminiTokenExpiringSoon(credential, minutes = 50) {
    if (!credential.expiresAt) return false;
    try {
        const expirationTime = new Date(credential.expiresAt).getTime();
        const currentTime = Date.now();
        const thresholdTime = currentTime + minutes * 60 * 1000;
        return expirationTime <= thresholdTime;
    } catch {
        return false;
    }
}

// Gemini Token 刷新（带锁）
const geminiRefreshLocks = new Map();
const geminiRefreshPromises = new Map();

async function refreshGeminiTokenWithLock(credential) {
    const credentialId = credential.id;

    if (geminiRefreshLocks.get(credentialId)) {
        const existingPromise = geminiRefreshPromises.get(credentialId);
        if (existingPromise) return existingPromise;
    }

    geminiRefreshLocks.set(credentialId, true);

    const refreshPromise = (async () => {
        try {
            if (!credential.refreshToken) {
                return { success: false, error: 'No refresh token' };
            }

            // console.log(`[${getTimestamp()}] [Gemini Token] 刷新凭证 ${credentialId} (${credential.name})...`);
            const result = await refreshGeminiToken(credential.refreshToken);

            await geminiStore.update(credentialId, {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt
            });
            await geminiStore.resetErrorCount(credentialId);

            const updatedCredential = await geminiStore.getById(credentialId);
            // console.log(`[${getTimestamp()}] [Gemini Token] 凭证 ${credentialId} 刷新成功`);
            return { success: true, credential: updatedCredential };
        } catch (error) {
            // console.log(`[${getTimestamp()}] [Gemini Token] 凭证 ${credentialId} 刷新失败: ${error.message}`);
            await geminiStore.incrementErrorCount(credentialId, error.message);
            return { success: false, error: error.message };
        } finally {
            geminiRefreshLocks.set(credentialId, false);
            geminiRefreshPromises.delete(credentialId);
        }
    })();

    geminiRefreshPromises.set(credentialId, refreshPromise);
    return refreshPromise;
}

// Gemini API - Claude 格式兼容 (/gemini-antigravity/v1/messages)
app.post('/gemini-antigravity/v1/messages', handleGeminiAntigravityRequest);
app.post('/v1/gemini/messages', handleGeminiAntigravityRequest);  // 兼容旧路径

// Orchids API - Claude 格式兼容 (/orchids/v1/messages)
app.post('/orchids/v1/messages', handleOrchidsRequest);
app.post('/v1/orchids/messages', handleOrchidsRequest);  // 兼容路径

/**
 * Orchids API 请求处理函数
 * 支持负载均衡和故障转移（参考 orchids-api-main 的 handler.go）
 */
async function handleOrchidsRequest(req, res) {
    const startTime = Date.now();
    const requestId = 'orchids_' + Date.now() + Math.random().toString(36).substring(2, 8);
    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    // 重试配置
    const MAX_RETRY_COUNT = 3;
    const BASE_RETRY_DELAY = 100; // ms

    let logData = {
        requestId,
        ipAddress: clientIp,
        userAgent,
        method: 'POST',
        path: req.path,
        stream: false,
        inputTokens: 0,
        outputTokens: 0,
        statusCode: 200
    };

    let keyRecord = null;
    let retryCount = 0;
    let failedAccountIds = [];
    let currentCredential = null;

    try {
        // API Key 认证
        const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
        if (!apiKey) {
            logData.statusCode = 401;
            logData.errorMessage = 'Missing API key';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(401).json({ error: { type: 'authentication_error', message: 'Missing API key' } });
        }

        keyRecord = await verifyApiKey(apiKey);
        if (!keyRecord) {
            logData.statusCode = 401;
            logData.errorMessage = 'Invalid API key';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid API key' } });
        }

        logData.apiKeyId = keyRecord.id;
        logData.apiKeyPrefix = keyRecord.keyPrefix;

        // 检查用量限制
        const limitCheck = await checkUsageLimits(keyRecord, clientIp);
        if (!limitCheck.allowed) {
            logData.statusCode = 429;
            logData.errorMessage = limitCheck.reason;
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(429).json({ error: { type: 'rate_limit_error', message: limitCheck.reason } });
        }

        if (!limitCheck.concurrentAcquired) {
            incrementConcurrent(keyRecord.id, clientIp);
        }

        await apiKeyStore.updateLastUsed(keyRecord.id);

        const { model, messages, max_tokens, stream, system } = req.body;

        // 使用负载均衡器选择账号
        const selectAccount = async () => {
            if (orchidsLoadBalancer) {
                const credential = await orchidsLoadBalancer.getNextAccountExcluding(failedAccountIds);
                if (credential) {
                    console.log(`[${getTimestamp()}] [Orchids] 使用账号: ${credential.name} (${credential.email || 'N/A'})`);
                    return credential;
                }
            }
            // 回退到传统方式
            const orchidsCredentials = await orchidsStore.getAll();
            if (orchidsCredentials.length === 0) return null;
            return orchidsCredentials.find(c => c.isActive && !failedAccountIds.includes(c.id)) 
                || orchidsCredentials.find(c => !failedAccountIds.includes(c.id))
                || orchidsCredentials[0];
        };

        currentCredential = await selectAccount();
        if (!currentCredential) {
            decrementConcurrent(keyRecord.id, clientIp);
            logData.statusCode = 503;
            logData.errorMessage = 'No available Orchids credentials';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(503).json({ error: { type: 'service_error', message: 'No available Orchids credentials' } });
        }

        logData.credentialId = currentCredential.id;
        logData.credentialName = currentCredential.name;
        logData.model = model || 'claude-sonnet-4-5';
        logData.stream = !!stream;

        // 粗略估算输入 token 数
        const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
        logData.inputTokens = inputTokens;

        const requestBody = { messages, system, max_tokens };

        // 执行请求（带重试逻辑）
        const executeRequest = async (credential) => {
            const orchidsService = new OrchidsChatService(credential);
            
            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');

                let outputTokens = 0;
                for await (const event of orchidsService.generateContentStream(model, requestBody)) {
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                    if (event.usage?.output_tokens) {
                        outputTokens = event.usage.output_tokens;
                    }
                }
                logData.outputTokens = outputTokens;
                logData.statusCode = 200;
                res.end();
                return { success: true };
            } else {
                const response = await orchidsService.generateContent(model, requestBody);
                logData.outputTokens = response.usage?.output_tokens || 0;
                logData.statusCode = 200;
                res.json(response);
                return { success: true };
            }
        };

        // 主请求循环（带故障转移）
        let lastError = null;
        while (retryCount <= MAX_RETRY_COUNT) {
            try {
                const result = await executeRequest(currentCredential);
                if (result.success) {
                    // 请求成功，记录成功计数
                    if (orchidsLoadBalancer) {
                        orchidsLoadBalancer.scheduleSuccessCount(currentCredential.id);
                        await orchidsLoadBalancer.markAccountActive(currentCredential.id);
                    }
                    break;
                }
            } catch (error) {
                lastError = error;
                console.error(`[${getTimestamp()}] [Orchids] 账号 ${currentCredential.name} 请求失败: ${error.message}`);

                // 记录失败
                if (orchidsLoadBalancer) {
                    orchidsLoadBalancer.scheduleFailureCount(currentCredential.id);
                }
                failedAccountIds.push(currentCredential.id);
                retryCount++;

                // 检查是否超过最大重试次数
                if (retryCount >= MAX_RETRY_COUNT) {
                    console.log(`[${getTimestamp()}] [Orchids] 已达到最大重试次数 (${MAX_RETRY_COUNT})，停止重试`);
                    break;
                }

                console.log(`[${getTimestamp()}] [Orchids] 尝试切换账号 (重试 ${retryCount}/${MAX_RETRY_COUNT}, 已排除 ${failedAccountIds.length} 个)`);

                // 指数退避
                const backoff = Math.pow(2, retryCount - 1) * BASE_RETRY_DELAY;
                await new Promise(resolve => setTimeout(resolve, backoff));

                // 选择新账号
                const newCredential = await selectAccount();
                if (!newCredential || failedAccountIds.includes(newCredential.id)) {
                    console.log(`[${getTimestamp()}] [Orchids] 无更多可用账号`);
                    break;
                }
                currentCredential = newCredential;
                logData.credentialId = currentCredential.id;
                logData.credentialName = currentCredential.name;
                console.log(`[${getTimestamp()}] [Orchids] 切换到账号: ${currentCredential.name}`);
            }
        }

        // 如果所有重试都失败
        if (lastError && !res.headersSent) {
            const errorEvent = {
                type: 'error',
                error: { type: 'api_error', message: lastError.message }
            };
            if (stream) {
                res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                res.end();
            } else {
                res.status(500).json({ error: { type: 'api_error', message: lastError.message } });
            }
            logData.statusCode = 500;
            logData.errorMessage = lastError.message;
        }

        console.log(`[${getTimestamp()}] [Orchids] ${requestId} | 完成 | 重试=${retryCount} | 耗时=${Date.now() - startTime}ms`);

    } catch (error) {
        logData.statusCode = 500;
        logData.errorMessage = error.message;
        if (!res.headersSent) {
            res.status(500).json({ error: { type: 'api_error', message: error.message } });
        }
    } finally {
        if (keyRecord) {
            decrementConcurrent(keyRecord.id, clientIp);
        }
        await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
    }
}

async function handleGeminiAntigravityRequest(req, res) {
    const startTime = Date.now();
    const requestId = 'gemini_' + Date.now() + Math.random().toString(36).substring(2, 8);
    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    let logData = {
        requestId,
        ipAddress: clientIp,
        userAgent,
        method: 'POST',
        path: req.path,
        stream: false, inputTokens: 0,
        outputTokens: 0,
        statusCode: 200
    };

    let credential = null;
    let keyRecord = null;
    const maxRetries = 3;  // 最大重试次数
    const triedCredentialIds = [];  // 已尝试的凭证 ID

    try {
        // API Key 认证
        const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
        if (!apiKey) {
            logData.statusCode = 401;
            logData.errorMessage = 'Missing API key';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(401).json({ error: { type: 'authentication_error', message: 'Missing API key' } });
        }

        keyRecord = await verifyApiKey(apiKey);
        if (!keyRecord) {
            logData.statusCode = 401;
            logData.errorMessage = 'Invalid API key';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid API key' } });
        }

        logData.apiKeyId = keyRecord.id;
        logData.apiKeyPrefix = keyRecord.keyPrefix;

        // 检查用量限制
        const limitCheck = await checkUsageLimits(keyRecord, clientIp);
        if (!limitCheck.allowed) {
            logData.statusCode = 429;
            logData.errorMessage = limitCheck.reason;
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(429).json({ error: { type: 'rate_limit_error', message: limitCheck.reason } });
        }

        if (!limitCheck.concurrentAcquired) {
            incrementConcurrent(keyRecord.id, clientIp);
        }

        await apiKeyStore.updateLastUsed(keyRecord.id);

        const { model, messages, stream, system, max_tokens } = req.body;
        const requestModel = model || 'gemini-3-preview';

        logData.model = requestModel;
        logData.stream = !!stream;

        // 转换 Claude 格式消息到 Gemini 格式（只需转换一次）
        const contents = claudeToGeminiMessages(messages);
        const requestBody = { contents };

        // 添加系统提示
        if (system) {
            const systemText = typeof system === 'string' ? system : (Array.isArray(system) ? system.map(s => s.text || s).join('\n') : String(system));
            requestBody.systemInstruction = { parts: [{ text: systemText }] };
        }

        // 添加生成配置
        if (max_tokens) {
            requestBody.generationConfig = { maxOutputTokens: max_tokens };
        }

        const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
        logData.inputTokens = inputTokens;

        // 429 重试循环
        let lastError = null;
        for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
            // 选择 Gemini 凭证（排除已尝试的）
            credential = await selectGeminiCredential(requestModel, triedCredentialIds);
            if (!credential) {
                if (triedCredentialIds.length > 0) {
                    // 所有凭证都试过了，报错
                    decrementConcurrent(keyRecord.id, clientIp);
                    logData.statusCode = 429;
                    logData.errorMessage = 'All Gemini credentials rate limited';
                    await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
                    return res.status(429).json({ error: { type: 'rate_limit_error', message: 'All Gemini credentials are rate limited, please try again later' } });
                }
                decrementConcurrent(keyRecord.id, clientIp);
                logData.statusCode = 503;
                logData.errorMessage = 'No available Gemini credentials';
                await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
                return res.status(503).json({ error: { type: 'service_error', message: 'No available Gemini credentials' } });
            }

            triedCredentialIds.push(credential.id);
            logData.credentialId = credential.id;
            logData.credentialName = credential.name;

            // console.log(`[${getTimestamp()}] [Gemini API] 请求 ${requestId} | IP: ${clientIp} | Key: ${keyRecord.keyPrefix} | Cred: ${credential.name} | Model: ${requestModel} | Stream: ${!!stream} | Retry: ${retryCount}`);

            // 检查并刷新 Token（如果即将过期）
            if (credential.refreshToken && isGeminiTokenExpiringSoon(credential)) {
                // console.log(`[${getTimestamp()}] [Gemini API] 凭证 ${credential.id} Token 即将过期，先刷新...`);
                const refreshResult = await refreshGeminiTokenWithLock(credential);
                if (refreshResult.success && refreshResult.credential) {
                    credential = refreshResult.credential;
                }
            }

            // 创建 Antigravity 服务
            const service = AntigravityApiService.fromCredentials(credential);

            try {
                if (stream) {
                    // ============ 流式响应 ============
                    await apiLogStore.create({ ...logData, durationMs: 0 });

                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');

                    const messageId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 8);

                    // 发送 message_start 事件
                    res.write(`event: message_start\ndata: ${JSON.stringify({
                        type: 'message_start',
                        message: {
                            id: messageId,
                            type: 'message',
                            role: 'assistant',
                            content: [],
                            model: requestModel,
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: inputTokens, output_tokens: 0 }
                        }
                    })}\n\n`);

                    // 发送 content_block_start 事件
                    res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'text', text: '' }
                    })}\n\n`);

                    let fullText = '';
                    let outputTokens = 0;

                    for await (const chunk of service.generateContentStream(requestModel, requestBody)) {
                        if (chunk && chunk.candidates && chunk.candidates[0]?.content?.parts) {
                            for (const part of chunk.candidates[0].content.parts) {
                                if (part.text) {
                                    fullText += part.text;
                                    outputTokens += Math.ceil(part.text.length / 4);
                                    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                                        type: 'content_block_delta',
                                        index: 0,
                                        delta: { type: 'text_delta', text: part.text }
                                    })}\n\n`);
                                }
                            }
                        }

                        // 提取 usageMetadata
                        if (chunk?.usageMetadata) {
                            if (chunk.usageMetadata.candidatesTokenCount) {
                                outputTokens = chunk.usageMetadata.candidatesTokenCount;
                            }
                        }
                    }

                    // 发送结束事件
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                    res.write(`event: message_delta\ndata: ${JSON.stringify({
                        type: 'message_delta',
                        delta: { stop_reason: 'end_turn', stop_sequence: null },
                        usage: { output_tokens: outputTokens }
                    })}\n\n`);
                    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                    res.end();

                    // 更新日志和凭证状态
                    await apiLogStore.update(requestId, {
                        outputTokens,
                        durationMs: Date.now() - startTime
                    });
                    await geminiStore.resetErrorCount(credential.id);

                    // console.log(`[${getTimestamp()}] [Gemini] ${requestId} | ${keyRecord.keyPrefix} | ${clientIp} | ${Date.now() - startTime}ms | in:${inputTokens} out:${outputTokens}`);
                    decrementConcurrent(keyRecord.id, clientIp);
                    return;  // 成功，退出

                } else {
                    // ============ 非流式响应 ============
                    const response = await service.generateContent(requestModel, requestBody);
                    const claudeResponse = geminiToClaudeResponse(response, requestModel);

                    // 更新 token 统计
                    const outputTokens = claudeResponse.usage?.output_tokens || 0;
                    logData.outputTokens = outputTokens;
                    logData.durationMs = Date.now() - startTime;

                    await apiLogStore.create(logData);
                    await geminiStore.resetErrorCount(credential.id);
                    decrementConcurrent(keyRecord.id, clientIp);

                    // console.log(`[${getTimestamp()}] [Gemini] ${requestId} | ${keyRecord.keyPrefix} | ${clientIp} | ${Date.now() - startTime}ms | in:${inputTokens} out:${outputTokens}`);

                    return res.json(claudeResponse);  // 成功，退出
                }

            } catch (apiError) {
                lastError = apiError;
                const errorStatus = apiError.response?.status || apiError.status;
                const errorMessage = apiError.message || 'Unknown error';

                console.error(`[${getTimestamp()}] [Gemini API] 凭证 ${credential.name} 错误: ${errorMessage} (status: ${errorStatus})`);

                // 增加错误计数
                await geminiStore.incrementErrorCount(credential.id, errorMessage);

                // 如果是 429 错误，尝试下一个凭证
                if (errorStatus === 429) {
                    // console.log(`[${getTimestamp()}] [Gemini API] 凭证 ${credential.name} 触发 429，尝试切换账号...`);
                    // 短暂延迟后重试
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;  // 继续下一次循环，尝试其他凭证
                }

                // 其他错误直接抛出
                throw apiError;
            }
        }

        // 所有重试都失败了
        throw lastError || new Error('All retries failed');

    } catch (error) {
        logData.statusCode = error.response?.status || 500;
        logData.errorMessage = error.message;
        logData.durationMs = Date.now() - startTime;

        if (!logData.apiKeyId) {
            await apiLogStore.create(logData);
        }

        console.error(`[${getTimestamp()}] [Gemini API] 错误 ${requestId} | ${error.message}`);

        if (keyRecord) {
            decrementConcurrent(keyRecord.id, clientIp);
        }

        if (!res.headersSent) {
            res.status(500).json({ error: { type: 'api_error', message: error.message } });
        }
    }
}

// OpenAI API 兼容接口
app.post('/v1/chat/completions', async (req, res) => {
    const startTime = Date.now();
    const requestId = 'chatcmpl-' + Date.now() + Math.random().toString(36).substring(2, 8);
    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    let logData = {
        requestId,
        ipAddress: clientIp,
        userAgent,
        method: 'POST',
        path: '/v1/chat/completions',
        stream: false,
        inputTokens: 0,
        outputTokens: 0,
        statusCode: 200
    };

    try {
        const apiKey = req.headers['authorization']?.replace('Bearer ', '');
        if (!apiKey) {
            logData.statusCode = 401;
            logData.errorMessage = 'Missing API key';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
        }

        const keyRecord = await verifyApiKey(apiKey);
        if (!keyRecord) {
            logData.statusCode = 401;
            logData.errorMessage = 'Invalid API key';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
        }

        logData.apiKeyId = keyRecord.id;
        logData.apiKeyPrefix = keyRecord.keyPrefix;

        // 检查用量限制（包含并发限制检查，基于 API Key + IP）
        const limitCheck = await checkUsageLimits(keyRecord, clientIp);
        if (!limitCheck.allowed) {
            logData.statusCode = 429;
            logData.errorMessage = limitCheck.reason;
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(429).json({ error: { message: limitCheck.reason, type: 'rate_limit_error' } });
        }

        // 如果并发限制检查时没有获取槽位，则手动增加并发计数
        if (!limitCheck.concurrentAcquired) {
            incrementConcurrent(keyRecord.id, clientIp);
        }

        await apiKeyStore.updateLastUsed(keyRecord.id);

        const { model, messages, max_tokens, stream, temperature, top_p, tools, tool_choice } = req.body;

        // 转换 OpenAI 消息格式到 Claude 格式
        let systemPrompt = '';
        const convertedMessages = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                systemPrompt += (systemPrompt ? '\n' : '') + msg.content;
            } else if (msg.role === 'user' || msg.role === 'assistant') {
                let content = msg.content;
                if (Array.isArray(content)) {
                    content = content.map(c => c.type === 'text' ? c.text : '').join('');
                }
                convertedMessages.push({ role: msg.role, content });
            } else if (msg.role === 'tool') {
                convertedMessages.push({
                    role: 'user',
                    content: `Tool result for ${msg.tool_call_id}: ${msg.content}`
                });
            }
        }

        logData.model = model || 'gpt-4';
        logData.stream = !!stream;

        const credentials = await store.getAll();
        if (credentials.length === 0) {
            logData.statusCode = 503;
            logData.errorMessage = 'No available credentials';
            await apiLogStore.create({ ...logData, durationMs: Date.now() - startTime });
            return res.status(503).json({ error: { message: 'No available credentials', type: 'server_error' } });
        }

        // 智能选择凭据（优先选择空闲的，如果都忙则选择队列最短的）
        let credential = selectBestCredential(credentials);
        // console.log(`[${getTimestamp()}] [凭据分发] 选择凭据 ${credential.id} (${credential.name}) | 可用凭据数: ${credentials.length}`);
        logData.credentialId = credential.id;
        logData.credentialName = credential.name;

        // 获取凭据锁（如果凭据正在使用，会排队等待）
        await acquireCredentialLock(credential.id);

        // 检查并刷新 token（如果即将过期）- 必须在获取锁之后执行
        if (credential.refreshToken && isTokenExpiringSoon(credential)) {
            // console.log(`[${getTimestamp()}] [OpenAI API] 凭据 ${credential.id} token 即将过期，先刷新...`);
            const refreshResult = await refreshTokenWithLock(credential, store);
            if (refreshResult.success && refreshResult.credential) {
                credential = refreshResult.credential;
            }
        }

        // 使用 KiroService（与 /v1/messages 保持一致）
        const service = new KiroService(credential);

        // OpenAI 模型映射到 Claude 模型
        const modelMapping = {
            'gpt-4': 'claude-sonnet-4-20250514',
            'gpt-4-turbo': 'claude-sonnet-4-20250514',
            'gpt-4-turbo-preview': 'claude-sonnet-4-20250514',
            'gpt-4o': 'claude-sonnet-4-20250514',
            'gpt-4o-mini': 'claude-3-5-haiku-20241022',
            'gpt-3.5-turbo': 'claude-3-5-haiku-20241022',
            'o1': 'claude-opus-4-5-20251101',
            'o1-preview': 'claude-opus-4-5-20251101'
        };
        const claudeModel = modelMapping[model] || model || 'claude-sonnet-4-20250514';

        // 转换 OpenAI 工具格式到 Claude 格式
        let claudeTools = null;
        if (tools && Array.isArray(tools) && tools.length > 0) {
            claudeTools = tools.map(tool => ({
                name: tool.function.name,
                description: tool.function.description || '',
                input_schema: tool.function.parameters || {}
            }));
        }

        // 构建 Claude 请求体
        const requestBody = {
            messages: convertedMessages,
            system: systemPrompt || undefined,
            tools: claudeTools || undefined
        };

        const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
        logData.inputTokens = inputTokens;

        // console.log(`[${getTimestamp()}] [OpenAI API] 请求 ${requestId} | IP: ${clientIp} | Key: ${keyRecord.keyPrefix} | Model: ${model} -> ${claudeModel} | Stream: ${!!stream}`);

        if (stream) {
            await apiLogStore.create({ ...logData, durationMs: 0 });

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let fullText = '';
            let outputTokens = 0;
            const toolCalls = [];

            try {
                for await (const event of service.generateContentStream(claudeModel, requestBody)) {
                    if (event.type === 'content_block_delta' && event.delta?.text) {
                        fullText += event.delta.text;
                        outputTokens += Math.ceil(event.delta.text.length / 4);

                        const chunk = {
                            id: requestId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: model || 'gpt-4',
                            choices: [{
                                index: 0,
                                delta: { content: event.delta.text },
                                finish_reason: null
                            }]
                        };
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    } else if (event.type === 'tool_use' && event.toolUse) {
                        toolCalls.push(event.toolUse);
                    }
                }

                // 发送工具调用（如果有）
                if (toolCalls.length > 0) {
                    const toolCallsChunk = {
                        id: requestId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model || 'gpt-4',
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: toolCalls.map((tc, idx) => ({
                                    index: idx,
                                    id: tc.toolUseId,
                                    type: 'function',
                                    function: {
                                        name: tc.name,
                                        arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {})
                                    }
                                }))
                            },
                            finish_reason: null
                        }]
                    };
                    res.write(`data: ${JSON.stringify(toolCallsChunk)}\n\n`);
                }

                const finalChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model || 'gpt-4',
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
                    }]
                };
                res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();

                const durationMs = Date.now() - startTime;
                await apiLogStore.update(requestId, { outputTokens, statusCode: 200, durationMs });

                // 减少并发计数
                decrementConcurrent(keyRecord.id, clientIp);

                // 释放凭据锁
                releaseCredentialLock(credential.id);

                // console.log(`[${getTimestamp()}] [OpenAI] ${requestId} | ${keyRecord.keyPrefix} | ${clientIp} | ${durationMs}ms | in:${inputTokens} out:${outputTokens}`);

            } catch (streamError) {
                // 减少并发计数
                decrementConcurrent(keyRecord.id, clientIp);

                // 释放凭据锁
                releaseCredentialLock(credential.id);

                const durationMs = Date.now() - startTime;
                await apiLogStore.update(requestId, { statusCode: 500, errorMessage: streamError.message, durationMs });
                // console.error(`[${getTimestamp()}] [OpenAI API] 错误 ${requestId} | ${streamError.message}`);
                res.write(`data: ${JSON.stringify({ error: { message: streamError.message, type: 'server_error' } })}\n\n`);
                res.end();
            }
        } else {
            // 非流式响应
            const response = await service.generateContent(claudeModel, requestBody);

            let outputTokens = 0;
            let responseText = response.content || '';
            outputTokens += Math.ceil(responseText.length / 4);

            const durationMs = Date.now() - startTime;

            await apiLogStore.create({ ...logData, outputTokens, durationMs });

            // 减少并发计数
            decrementConcurrent(keyRecord.id, clientIp);

            // 释放凭据锁
            releaseCredentialLock(credential.id);

            // console.log(`[${getTimestamp()}] [OpenAI] ${requestId} | ${keyRecord.keyPrefix} | ${clientIp} | ${durationMs}ms | in:${inputTokens} out:${outputTokens}`);

            // 构建响应
            const message = {
                role: 'assistant',
                content: responseText
            };

            // 添加工具调用（如果有）
            if (response.toolCalls && response.toolCalls.length > 0) {
                message.tool_calls = response.toolCalls.map((tc, idx) => ({
                    id: tc.toolUseId,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {})
                    }
                }));
            }

            res.json({
                id: requestId,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: model || 'gpt-4',
                choices: [{
                    index: 0,
                    message,
                    finish_reason: response.toolCalls && response.toolCalls.length > 0 ? 'tool_calls' : 'stop'
                }],
                usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens
                }
            });
        }
    } catch (error) {
        // 减少并发计数（如果已经增加过）
        if (logData.apiKeyId) {
            decrementConcurrent(logData.apiKeyId, clientIp);
        }

        // 释放凭据锁（如果已经获取过）
        if (logData.credentialId) {
            releaseCredentialLock(logData.credentialId);
        }

        const durationMs = Date.now() - startTime;
        logData.statusCode = 500;
        logData.errorMessage = error.message;
        logData.durationMs = durationMs;
        await apiLogStore.create(logData);
        console.error(`[${getTimestamp()}] [OpenAI API] 错误 ${requestId} | ${error.message}`);

        if (!res.headersSent) {
            res.status(500).json({ error: { message: error.message, type: 'server_error' } });
        } else {
            res.write(`data: ${JSON.stringify({ error: { message: error.message, type: 'server_error' } })}\n\n`);
            res.end();
        }
    }
});

// ============ API 路由 ============

// 获取凭据列表
app.get('/api/credentials', async (req, res) => {
    try {
        const credentials = await store.getAll();
        // 隐藏敏感信息
        const safeCredentials = credentials.map(c => ({
            ...c,
            accessToken: c.accessToken ? '***' + c.accessToken.slice(-8) : null,
            refreshToken: c.refreshToken ? '***' : null,
            clientSecret: c.clientSecret ? '***' : null
        }));
        res.json({ success: true, data: safeCredentials });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取单个凭据
app.get('/api/credentials/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const showFull = req.query.full === 'true';
        const credential = await store.getById(id);
        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }

        // 根据参数决定是否隐藏敏感信息
        let responseData;
        if (showFull) {
            // 详情页面需要完整信息
            responseData = credential;
        } else {
            // 列表页面隐藏敏感信息
            responseData = {
                ...credential,
                accessToken: credential.accessToken ? '***' + credential.accessToken.slice(-8) : null,
                refreshToken: credential.refreshToken ? '***' : null,
                clientSecret: credential.clientSecret ? '***' : null
            };
        }
        res.json({ success: true, data: responseData });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 添加凭据
app.post('/api/credentials', async (req, res) => {
    try {
        const { email, region, provider, refreshToken, authMethod, clientId, clientSecret } = req.body;
        
        if (!refreshToken) {
            return res.status(400).json({ success: false, error: 'refreshToken 是必需的' });
        }
        
        // IdC 认证需要 clientId 和 clientSecret
        if (authMethod === 'IdC' || authMethod === 'builder-id') {
            if (!clientId || !clientSecret) {
                return res.status(400).json({ success: false, error: 'IdC/builder-id 认证需要 clientId 和 clientSecret' });
            }
        }
        
        // 先刷新 token 获取 accessToken
        const refreshResult = await KiroAPI.refreshToken({
            refreshToken,
            authMethod: authMethod || 'social',
            region: region || 'us-east-1',
            clientId,
            clientSecret
        });
        
        if (!refreshResult.success) {
            return res.status(400).json({ success: false, error: `Token 刷新失败: ${refreshResult.error}` });
        }
        
        // 生成名称
        const name = email || `account_${Date.now()}`;
        
        // 保存到数据库
        const id = await store.add({
            name,
            accessToken: refreshResult.accessToken,
            refreshToken: refreshResult.refreshToken || refreshToken,
            authMethod: authMethod || 'social',
            provider: provider || 'Google',
            region: region || 'us-east-1',
            clientId: clientId || null,
            clientSecret: clientSecret || null,
            expiresAt: refreshResult.expiresAt
        });
        
        // console.log(`[${getTimestamp()}] 添加凭据成功: id=${id}, name=${name}, authMethod=${authMethod || 'social'}`);
        res.json({ success: true, id, name });
    } catch (error) {
        console.error(`[${getTimestamp()}] 添加凭据失败:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除凭据
app.delete('/api/credentials/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await store.delete(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 设置活跃凭据
app.post('/api/credentials/:id/activate', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await store.setActive(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 从文件导入凭据
app.post('/api/credentials/import', async (req, res) => {
    try {
        const { filePath, name } = req.body;

        if (!filePath) {
            return res.status(400).json({ success: false, error: '文件路径是必需的' });
        }

        const id = await store.importFromFile(filePath, name);
        res.json({ success: true, data: { id } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 批量导入 Google/Social 账号
app.post('/api/credentials/batch-import', async (req, res) => {
    try {
        const { accounts, region } = req.body;

        if (!accounts || !Array.isArray(accounts)) {
            return res.status(400).json({ success: false, error: 'accounts 必须是数组' });
        }

        if (accounts.length === 0) {
            return res.status(400).json({ success: false, error: 'accounts 数组不能为空' });
        }

        const results = await store.batchImportSocialAccounts(accounts, region || 'us-east-1');
        res.json({ success: true, data: results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== OAuth 登录 API ====================

// 存储活跃的 OAuth 认证实例
const activeOAuthSessions = new Map();

/**
 * 生成凭据名称
 */
function generateCredentialName(provider) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${provider}-${timestamp}`;
}

// 启动 OAuth 登录 (Builder ID)
app.post('/api/oauth/builder-id/start', async (req, res) => {
    try {
        const {
            saveToConfigs = false,
            saveToDatabase = true,  // 默认直接保存到数据库
            saveToFile = false,     // 默认不保存到文件
            name,                   // 可选的凭据名称
            region = 'us-east-1'
        } = req.body;

        const sessionId = crypto.randomBytes(16).toString('hex');
        let credentialId = null;

        // 创建成功回调，用于保存到数据库
        const onSuccess = saveToDatabase ? async (credentials) => {
            const credName = name || generateCredentialName('BuilderID');
            credentialId = await store.add({
                name: credName,
                ...credentials
            });
            // console.log(`[OAuth] 凭据已保存到数据库，ID: ${credentialId}, 名称: ${credName}`);
        } : null;

        const auth = new KiroAuth({
            saveToConfigs,
            saveToFile: saveToFile || saveToConfigs,
            region,
            onSuccess
        });

        const result = await auth.startBuilderIDAuth();

        // 存储会话
        activeOAuthSessions.set(sessionId, {
            auth,
            provider: 'BuilderID',
            saveToConfigs,
            saveToDatabase,
            getCredentialId: () => credentialId,
            startTime: Date.now()
        });

        // 5分钟后自动清理会话
        setTimeout(() => {
            const session = activeOAuthSessions.get(sessionId);
            if (session) {
                session.auth.close();
                activeOAuthSessions.delete(sessionId);
            }
        }, 5 * 60 * 1000);

        res.json({
            success: true,
            data: {
                sessionId,
                verificationUri: result.verificationUri,
                verificationUriComplete: result.verificationUriComplete,
                userCode: result.userCode,
                expiresIn: result.expiresIn,
                saveToDatabase
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 启动 OAuth 登录 (Social Auth - Google/GitHub)
app.post('/api/oauth/social/start', async (req, res) => {
    try {
        const {
            provider = 'Google',  // 'Google' 或 'Github'
            saveToDatabase = true,
            saveToFile = false,
            name,
            region = 'us-east-1'
        } = req.body;

        const sessionId = crypto.randomBytes(16).toString('hex');
        let credentialId = null;

        // 创建成功回调，用于保存到数据库
        const onSuccess = saveToDatabase ? async (credentials) => {
            const credName = name || generateCredentialName(provider);
            credentialId = await store.add({
                name: credName,
                provider: provider,
                ...credentials
            });
            // console.log(`[OAuth] Social Auth 凭据已保存到数据库，ID: ${credentialId}, 名称: ${credName}`);
        } : null;

        const auth = new KiroAuth({
            saveToFile,
            region,
            onSuccess
        });

        const result = await auth.startSocialAuth(provider);

        // 存储会话
        activeOAuthSessions.set(sessionId, {
            auth,
            provider: provider,
            saveToDatabase,
            getCredentialId: () => credentialId,
            startTime: Date.now()
        });

        // 5分钟后自动清理会话
        setTimeout(() => {
            const session = activeOAuthSessions.get(sessionId);
            if (session) {
                session.auth.close();
                activeOAuthSessions.delete(sessionId);
            }
        }, 5 * 60 * 1000);

        res.json({
            success: true,
            data: {
                sessionId,
                authUrl: result.authUrl,
                port: result.port,
                provider,
                saveToDatabase
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 检查 OAuth 会话状态
app.get('/api/oauth/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = activeOAuthSessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ success: false, error: '会话不存在或已过期' });
    }

    const credPath = session.auth.getLastCredentialsPath();
    const credentials = session.auth.getLastCredentials();
    const credentialId = session.getCredentialId ? session.getCredentialId() : null;

    res.json({
        success: true,
        data: {
            provider: session.provider,
            saveToConfigs: session.saveToConfigs,
            saveToDatabase: session.saveToDatabase,
            startTime: session.startTime,
            completed: !!credentials,
            credentialsPath: credPath,
            credentialId: credentialId
        }
    });
});

// 关闭 OAuth 会话
app.delete('/api/oauth/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = activeOAuthSessions.get(sessionId);

    if (session) {
        session.auth.close();
        activeOAuthSessions.delete(sessionId);
    }

    res.json({ success: true });
});

// 从 configs 目录加载所有凭据
app.get('/api/oauth/configs', async (req, res) => {
    try {
        const auth = new KiroAuth();
        const credentials = await auth.loadAllConfigCredentials();
        res.json({ success: true, data: credentials });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 从 configs 目录导入凭据到数据库
app.post('/api/oauth/configs/import', async (req, res) => {
    try {
        const { credPath, name } = req.body;

        if (!credPath) {
            return res.status(400).json({ success: false, error: '凭据路径是必需的' });
        }

        const id = await store.importFromFile(credPath, name);
        res.json({ success: true, data: { id } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 批量从 configs 目录导入所有凭据
app.post('/api/oauth/configs/import-all', async (req, res) => {
    try {
        const auth = new KiroAuth();
        const allCreds = await auth.loadAllConfigCredentials();

        const results = {
            total: allCreds.length,
            imported: 0,
            failed: 0,
            details: []
        };

        for (const item of allCreds) {
            try {
                const id = await store.importFromFile(item.path);
                results.imported++;
                results.details.push({ path: item.relativePath, id, success: true });
            } catch (error) {
                results.failed++;
                results.details.push({ path: item.relativePath, success: false, error: error.message });
            }
        }

        res.json({ success: true, data: results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 凭据测试 ====================

// 测试凭据
app.post('/api/credentials/:id/test', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const credential = await store.getById(id);

        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }

        const client = new KiroClient({
            accessToken: credential.accessToken,
            refreshToken: credential.refreshToken,
            profileArn: credential.profileArn,
            region: credential.region,
            authMethod: credential.authMethod,
            clientId: credential.clientId,
            clientSecret: credential.clientSecret,
            expiresAt: credential.expiresAt
        });

        const response = await client.chat([
            { role: 'user', content: '请回复"测试成功"' }
        ]);

        res.json({
            success: true,
            data: {
                message: '凭据有效',
                response: response.substring(0, 100)
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `凭据测试失败: ${error.message}`
        });
    }
});

// 获取可用模型列表
app.get('/api/models', async (req, res) => {
    try {
        // 优先使用活跃凭据
        const activeCredential = await store.getActive();
        if (!activeCredential) {
            return res.status(400).json({ success: false, error: '没有活跃的凭据，请先激活一个凭据' });
        }

        const client = new KiroClient({
            accessToken: activeCredential.accessToken,
            refreshToken: activeCredential.refreshToken,
            profileArn: activeCredential.profileArn,
            region: activeCredential.region,
            authMethod: activeCredential.authMethod,
            clientId: activeCredential.clientId,
            clientSecret: activeCredential.clientSecret,
            expiresAt: activeCredential.expiresAt
        });

        const models = await client.listAvailableModels();
        res.json({ success: true, data: models });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `获取模型列表失败: ${error.message}`
        });
    }
});

// 获取指定凭据的可用模型列表
app.get('/api/credentials/:id/models', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const credential = await store.getById(id);

        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }

        const client = new KiroClient({
            accessToken: credential.accessToken,
            refreshToken: credential.refreshToken,
            profileArn: credential.profileArn,
            region: credential.region,
            authMethod: credential.authMethod,
            clientId: credential.clientId,
            clientSecret: credential.clientSecret,
            expiresAt: credential.expiresAt
        });

        const models = await client.listAvailableModels();
        res.json({ success: true, data: models });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `获取模型列表失败: ${error.message}`
        });
    }
});

// 获取使用限额
app.get('/api/usage', async (req, res) => {
    try {
        const activeCredential = await store.getActive();
        if (!activeCredential) {
            return res.status(400).json({ success: false, error: '没有活跃的凭据，请先激活一个凭据' });
        }

        const client = new KiroClient({
            accessToken: activeCredential.accessToken,
            refreshToken: activeCredential.refreshToken,
            profileArn: activeCredential.profileArn,
            region: activeCredential.region,
            authMethod: activeCredential.authMethod,
            clientId: activeCredential.clientId,
            clientSecret: activeCredential.clientSecret,
            expiresAt: activeCredential.expiresAt
        });

        const usage = await client.getUsageLimits();
        res.json({ success: true, data: usage });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `获取使用限额失败: ${error.message}`
        });
    }
});

// 获取指定凭据的使用限额
app.get('/api/credentials/:id/usage', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        let credential = await store.getById(id);

        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }

        // 尝试获取用量的函数
        const tryGetUsage = async (cred) => {
            const client = new KiroClient({
                accessToken: cred.accessToken,
                refreshToken: cred.refreshToken,
                profileArn: cred.profileArn,
                region: cred.region,
                authMethod: cred.authMethod,
                clientId: cred.clientId,
                clientSecret: cred.clientSecret,
                expiresAt: cred.expiresAt
            });
            return await client.getUsageLimits();
        };

        try {
            const usage = await tryGetUsage(credential);
            // 保存用量到数据库
            await store.updateUsage(id, usage);
            res.json({ success: true, data: usage });
        } catch (error) {
            const status = error.response?.status;
            // 403 错误时尝试刷新 Token 后重试
            if (status === 403 && credential.refreshToken) {
                // console.log(`[${getTimestamp()}] 凭据 ${id} 获取用量返回 403，尝试刷新 Token...`);

                const refreshResult = await KiroAPI.refreshToken(credential);

                if (refreshResult.success) {
                    // 更新数据库中的凭据
                    await store.update(id, {
                        accessToken: refreshResult.accessToken,
                        refreshToken: refreshResult.refreshToken,
                        expiresAt: refreshResult.expiresAt
                    });

                    // 重新获取凭据并重试
                    credential = await store.getById(id);
                    try {
                        const usage = await tryGetUsage(credential);
                        // 保存用量到数据库
                        await store.updateUsage(id, usage);
                        res.json({ success: true, data: usage });
                    } catch (retryError) {
                        // 刷新后仍然失败，移动到错误表
                        await store.moveToError(id, `刷新后获取用量仍失败: ${retryError.message}`);
                        // console.log(`[${getTimestamp()}] 凭据 ${id} 刷新后获取用量仍失败，已移动到错误表`);
                        res.status(500).json({
                            success: false,
                            error: `获取使用限额失败: ${retryError.message}`
                        });
                    }
                } else {
                    // 刷新失败，移动到错误表
                    await store.moveToError(id, refreshResult.error);
                    res.status(403).json({
                        success: false,
                        error: `Token 刷新失败: ${refreshResult.error}`
                    });
                }
            } else {
                throw error;
            }
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `获取使用限额失败: ${error.message}`
        });
    }
});

// 刷新 Token
app.post('/api/credentials/:id/refresh', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const credential = await store.getById(id);

        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }

        if (!credential.refreshToken) {
            return res.status(400).json({ success: false, error: '该凭据没有 refreshToken，无法刷新' });
        }

        // 使用统一的 KiroAPI 刷新 Token
        const result = await KiroAPI.refreshToken(credential);

        if (!result.success) {
            // 将失败的凭据移动到错误表
            try {
                await store.moveToError(id, result.error);
                // console.log(`凭据 ${id} 刷新失败，已移动到错误表: ${result.error}`);
            } catch (moveError) {
                console.error(`移动凭据到错误表失败: ${moveError.message}`);
            }

            return res.status(500).json({
                success: false,
                error: `Token 刷新失败: ${result.error}`,
                movedToError: true
            });
        }

        // 更新数据库中的凭据
        await store.update(id, {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: result.expiresAt
        });

        res.json({
            success: true,
            data: {
                message: 'Token 刷新成功',
                expiresAt: result.expiresAt
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `Token 刷新失败: ${error.message}`
        });
    }
});

// 获取错误凭据列表
app.get('/api/error-credentials', async (req, res) => {
    try {
        const errors = await store.getAllErrors();
        // 隐藏敏感信息
        const safeErrors = errors.map(c => ({
            ...c,
            accessToken: c.accessToken ? '***' + c.accessToken.slice(-8) : null,
            refreshToken: c.refreshToken ? '***' : null,
            clientSecret: c.clientSecret ? '***' : null
        }));
        res.json({ success: true, data: safeErrors });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 刷新错误凭据的 Token
app.post('/api/error-credentials/:id/refresh', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const errorCred = await store.getErrorById(id);

        if (!errorCred) {
            return res.status(404).json({ success: false, error: '错误凭据不存在' });
        }

        if (!errorCred.refreshToken) {
            return res.status(400).json({ success: false, error: '该凭据没有 refreshToken，无法刷新' });
        }

        // 使用统一的 KiroAPI 刷新 Token
        const result = await KiroAPI.refreshToken(errorCred);

        if (!result.success) {
            return res.status(500).json({
                success: false,
                error: `Token 刷新失败: ${result.error}`
            });
        }

        // 刷新成功，恢复到正常表
        const newId = await store.restoreFromError(id, result.accessToken, result.refreshToken, result.expiresAt);
        // console.log(`错误凭据 ${id} 刷新成功，已恢复到正常表，新 ID: ${newId}`);

        res.json({
            success: true,
            data: {
                message: 'Token 刷新成功，凭据已恢复',
                newId,
                expiresAt: result.expiresAt
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `Token 刷新失败: ${error.message}`
        });
    }
});

// 删除错误凭据
app.delete('/api/error-credentials/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await store.deleteError(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 手动恢复错误凭据（不刷新 token）
app.post('/api/error-credentials/:id/restore', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const errorCred = await store.getErrorById(id);

        if (!errorCred) {
            return res.status(404).json({ success: false, error: '错误凭据不存在' });
        }

        const newId = await store.restoreFromError(id);
        res.json({
            success: true,
            data: { message: '凭据已恢复', newId }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 刷新错误凭据的用量（成功则恢复到正常表）
app.get('/api/error-credentials/:id/usage', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const errorCred = await store.getErrorById(id);

        if (!errorCred) {
            return res.status(404).json({ success: false, error: '错误凭据不存在' });
        }

        // 创建临时客户端获取用量
        const client = new KiroClient({
            accessToken: errorCred.accessToken,
            refreshToken: errorCred.refreshToken,
            profileArn: errorCred.profileArn,
            region: errorCred.region || 'us-east-1'
        });

        const usage = await client.getUsageLimits();

        // 用量获取成功，说明账户正常，恢复到正常表
        const newId = await store.restoreFromError(id);
        // console.log(`[${getTimestamp()}] 错误凭据 ${id} 用量获取成功，已恢复到正常表，新 ID: ${newId}`);

        res.json({
            success: true,
            data: usage,
            restored: true,
            newId: newId,
            message: '用量获取成功，账户已恢复到正常列表'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `获取用量失败: ${error.message}`
        });
    }
});

// ============ Gemini Antigravity 凭证管理 ============
// 路由已抽离到 gemini/gemini-routes.js，在 start() 中初始化

// ============ 模型定价管理 ============

// 获取所有定价配置
app.get('/api/pricing', authMiddleware, async (req, res) => {
    try {
        const pricing = await pricingStore.getAll();
        res.json({ success: true, data: pricing });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取单个定价配置
app.get('/api/pricing/:id', authMiddleware, async (req, res) => {
    try {
        const pricing = await pricingStore.getById(parseInt(req.params.id));
        if (!pricing) {
            return res.status(404).json({ success: false, error: '定价配置不存在' });
        }
        res.json({ success: true, data: pricing });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 添加定价配置
app.post('/api/pricing', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }
        
        const { modelName, displayName, provider, inputPrice, outputPrice, isActive, sortOrder } = req.body;
        
        if (!modelName || inputPrice === undefined || outputPrice === undefined) {
            return res.status(400).json({ success: false, error: '模型名称、输入价格和输出价格是必需的' });
        }
        
        const id = await pricingStore.add({
            modelName,
            displayName,
            provider,
            inputPrice: parseFloat(inputPrice),
            outputPrice: parseFloat(outputPrice),
            isActive,
            sortOrder
        });
        
        // 刷新动态定价缓存
        const pricingMap = await pricingStore.getPricingMap();
        setDynamicPricing(pricingMap);
        
        res.json({ success: true, data: { id } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 更新定价配置
app.put('/api/pricing/:id', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }
        
        const id = parseInt(req.params.id);
        const pricing = await pricingStore.getById(id);
        if (!pricing) {
            return res.status(404).json({ success: false, error: '定价配置不存在' });
        }
        
        const { modelName, displayName, provider, inputPrice, outputPrice, isActive, sortOrder } = req.body;
        
        await pricingStore.update(id, {
            modelName,
            displayName,
            provider,
            inputPrice: inputPrice !== undefined ? parseFloat(inputPrice) : undefined,
            outputPrice: outputPrice !== undefined ? parseFloat(outputPrice) : undefined,
            isActive,
            sortOrder
        });
        
        // 刷新动态定价缓存
        const pricingMap = await pricingStore.getPricingMap();
        setDynamicPricing(pricingMap);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除定价配置
app.delete('/api/pricing/:id', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }
        
        const id = parseInt(req.params.id);
        await pricingStore.delete(id);
        
        // 刷新动态定价缓存
        const pricingMap = await pricingStore.getPricingMap();
        setDynamicPricing(pricingMap);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 批量导入定价配置
app.post('/api/pricing/batch-import', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }
        
        const { pricing } = req.body;
        if (!pricing || !Array.isArray(pricing)) {
            return res.status(400).json({ success: false, error: '请提供定价配置数组' });
        }
        
        const results = await pricingStore.batchImport(pricing);
        
        // 刷新动态定价缓存
        const pricingMap = await pricingStore.getPricingMap();
        setDynamicPricing(pricingMap);
        
        res.json({ success: true, data: results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 重置为默认定价配置
app.post('/api/pricing/reset-default', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }
        
        const results = await pricingStore.initDefaultPricing();
        
        // 刷新动态定价缓存
        const pricingMap = await pricingStore.getPricingMap();
        setDynamicPricing(pricingMap);
        
        res.json({ success: true, data: results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API 日志管理 ============

// 获取错误日志列表（状态码 >= 400）
app.get('/api/error-logs', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const { page = 1, pageSize = 50, startDate, endDate } = req.query;

        const result = await apiLogStore.getErrorLogs({
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            startDate,
            endDate
        });

        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取日志列表（分页）
app.get('/api/logs', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const { page = 1, pageSize = 50, apiKeyId, ipAddress, startDate, endDate } = req.query;

        const result = await apiLogStore.getAll({
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            apiKeyId: apiKeyId ? parseInt(apiKeyId) : undefined,
            ipAddress,
            startDate,
            endDate
        });

        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取单个日志详情
app.get('/api/logs/:requestId', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const log = await apiLogStore.getByRequestId(req.params.requestId);
        if (!log) {
            return res.status(404).json({ success: false, error: '日志不存在' });
        }

        res.json({ success: true, data: log });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取日志统计信息
app.get('/api/logs-stats', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const { startDate, endDate, apiKeyId } = req.query;

        const stats = await apiLogStore.getStats({
            startDate,
            endDate,
            apiKeyId: apiKeyId ? parseInt(apiKeyId) : undefined
        });

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 按 IP 统计请求
app.get('/api/logs-stats/by-ip', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const { startDate, endDate, limit = 20 } = req.query;

        const stats = await apiLogStore.getStatsByIp({
            startDate,
            endDate,
            limit: parseInt(limit)
        });

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 手动清理旧日志
app.post('/api/logs/cleanup', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const { daysToKeep = 30 } = req.body;
        await apiLogStore.cleanOldLogs(parseInt(daysToKeep));

        res.json({ success: true, data: { message: `已清理 ${daysToKeep} 天前的日志` } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除单条日志
app.delete('/api/logs/:id', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const id = parseInt(req.params.id);
        await apiLogStore.delete(id);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取所有 API Key 的用量统计
app.get('/api/logs-stats/by-api-key', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const { startDate, endDate } = req.query;

        const stats = await apiLogStore.getStatsByApiKey({
            startDate,
            endDate
        });

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取 API Key 费用统计（按模型分类）
app.get('/api/keys/:id/cost', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { startDate, endDate } = req.query;

        // 检查权限：管理员或密钥所有者
        const keys = await apiKeyStore.getByUserId(req.userId);
        const key = keys.find(k => k.id === id);
        if (!key && !req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '无权查看此密钥费用' });
        }

        // 获取按模型分组的统计
        const modelStats = await apiLogStore.getStatsByModel(id, { startDate, endDate });

        // 计算每个模型的费用
        let totalInputCost = 0;
        let totalOutputCost = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        const modelCosts = modelStats.map(stat => {
            const cost = calculateTokenCost(stat.model, stat.inputTokens, stat.outputTokens);
            totalInputCost += cost.inputCost;
            totalOutputCost += cost.outputCost;
            totalInputTokens += stat.inputTokens;
            totalOutputTokens += stat.outputTokens;

            return {
                model: stat.model,
                requestCount: stat.requestCount,
                inputTokens: stat.inputTokens,
                outputTokens: stat.outputTokens,
                inputCost: cost.inputCost,
                outputCost: cost.outputCost,
                totalCost: cost.totalCost
            };
        });

        res.json({
            success: true,
            data: {
                models: modelCosts,
                summary: {
                    totalRequests: modelCosts.reduce((sum, m) => sum + m.requestCount, 0),
                    totalInputTokens,
                    totalOutputTokens,
                    totalInputCost,
                    totalOutputCost,
                    totalCost: totalInputCost + totalOutputCost
                }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取所有 API Key 的费用统计汇总
app.get('/api/logs-stats/cost', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const { startDate, endDate } = req.query;

        // 获取所有日志按模型分组统计
        const modelStats = await apiLogStore.getAllStatsByModel({ startDate, endDate });

        // 计算费用
        let totalInputCost = 0;
        let totalOutputCost = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        const modelCosts = modelStats.map(stat => {
            const cost = calculateTokenCost(stat.model, stat.inputTokens, stat.outputTokens);
            totalInputCost += cost.inputCost;
            totalOutputCost += cost.outputCost;
            totalInputTokens += stat.inputTokens;
            totalOutputTokens += stat.outputTokens;

            return {
                model: stat.model,
                requestCount: stat.requestCount,
                inputTokens: stat.inputTokens,
                outputTokens: stat.outputTokens,
                inputCost: cost.inputCost,
                outputCost: cost.outputCost,
                totalCost: cost.totalCost
            };
        });

        // 按 API Key 统计
        const keyStats = await apiLogStore.getCostByApiKey({ startDate, endDate });
        const keyCosts = [];
        for (const stat of keyStats) {
            const keyModelStats = await apiLogStore.getStatsByModel(stat.apiKeyId, { startDate, endDate });
            let keyCost = 0;
            keyModelStats.forEach(ms => {
                keyCost += calculateTokenCost(ms.model, ms.inputTokens, ms.outputTokens).totalCost;
            });

            keyCosts.push({
                apiKeyId: stat.apiKeyId,
                apiKeyPrefix: stat.apiKeyPrefix,
                apiKeyName: stat.apiKeyName,
                requestCount: stat.requestCount,
                inputTokens: stat.inputTokens,
                outputTokens: stat.outputTokens,
                totalCost: keyCost
            });
        }

        res.json({
            success: true,
            data: {
                byModel: modelCosts,
                byApiKey: keyCosts,
                summary: {
                    totalRequests: modelCosts.reduce((sum, m) => sum + m.requestCount, 0),
                    totalInputTokens,
                    totalOutputTokens,
                    totalInputCost,
                    totalOutputCost,
                    totalCost: totalInputCost + totalOutputCost
                }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取单个 API Key 的用量统计
app.get('/api/keys/:id/usage', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { startDate, endDate } = req.query;

        // 检查权限：管理员或密钥所有者
        const keys = await apiKeyStore.getByUserId(req.userId);
        const key = keys.find(k => k.id === id);
        if (!key && !req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '无权查看此密钥用量' });
        }

        const stats = await apiLogStore.getStatsForApiKey(id, {
            startDate,
            endDate
        });

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取按日期统计的用量（用于图表）
app.get('/api/logs-stats/by-date', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const { startDate, endDate, apiKeyId } = req.query;

        const stats = await apiLogStore.getStatsByDate({
            startDate,
            endDate,
            apiKeyId: apiKeyId ? parseInt(apiKeyId) : undefined
        });

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取按时间间隔统计的用量（默认20分钟）
app.get('/api/logs-stats/by-interval', authMiddleware, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ success: false, error: '需要管理员权限' });
        }

        const { startDate, endDate, apiKeyId, interval } = req.query;

        const stats = await apiLogStore.getStatsByTimeInterval({
            startDate,
            endDate,
            apiKeyId: apiKeyId ? parseInt(apiKeyId) : undefined,
            intervalMinutes: interval ? parseInt(interval) : 20
        });

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 流式对话
app.post('/api/chat/:id', async (req, res) => {
    const credentialId = parseInt(req.params.id);

    try {
        const credential = await store.getById(credentialId);

        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }

        const { message, model, history, skipTokenRefresh } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, error: '消息内容是必需的' });
        }

        // 获取凭据锁（如果凭据正在使用，会排队等待）
        await acquireCredentialLock(credentialId);

        const client = new KiroClient({
            accessToken: credential.accessToken,
            refreshToken: credential.refreshToken,
            profileArn: credential.profileArn,
            region: credential.region,
            authMethod: credential.authMethod,
            clientId: credential.clientId,
            clientSecret: credential.clientSecret,
            expiresAt: credential.expiresAt
        });

        // 构建消息数组
        const messages = [];
        if (history && Array.isArray(history)) {
            messages.push(...history);
        }
        messages.push({ role: 'user', content: message });

        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 流式输出
        for await (const event of client.chatStream(messages, model || 'claude-sonnet-4-20250514', { skipTokenRefresh: skipTokenRefresh !== false })) {
            if (event.type === 'content') {
                res.write(`data: ${JSON.stringify({ content: event.content })}\n\n`);
            }
        }

        // 释放凭据锁
        releaseCredentialLock(credentialId);

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    } catch (error) {
        // 释放凭据锁
        releaseCredentialLock(credentialId);

        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: `对话失败: ${error.message}`
            });
        } else {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    }
});

// 非流式对话
app.post('/api/chat/:id/sync', async (req, res) => {
    const credentialId = parseInt(req.params.id);

    try {
        const credential = await store.getById(credentialId);

        if (!credential) {
            return res.status(404).json({ success: false, error: '凭据不存在' });
        }

        const { message, model, history, skipTokenRefresh } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, error: '消息内容是必需的' });
        }

        // 获取凭据锁（如果凭据正在使用，会排队等待）
        await acquireCredentialLock(credentialId);

        const client = new KiroClient({
            accessToken: credential.accessToken,
            refreshToken: credential.refreshToken,
            profileArn: credential.profileArn,
            region: credential.region,
            authMethod: credential.authMethod,
            clientId: credential.clientId,
            clientSecret: credential.clientSecret,
            expiresAt: credential.expiresAt
        });

        // 构建消息数组
        const messages = [];
        if (history && Array.isArray(history)) {
            messages.push(...history);
        }
        messages.push({ role: 'user', content: message });

        const response = await client.chat(messages, model || 'claude-sonnet-4-20250514', { skipTokenRefresh: skipTokenRefresh !== false });

        // 释放凭据锁
        releaseCredentialLock(credentialId);

        res.json({
            success: true,
            data: { response }
        });
    } catch (error) {
        // 释放凭据锁
        releaseCredentialLock(credentialId);

        res.status(500).json({
            success: false,
            error: `对话失败: ${error.message}`
        });
    }
});

// ============ 代理配置 API ============

// 获取代理配置
app.get('/api/proxy/config', authMiddleware, async (req, res) => {
    try {
        const config = getProxyConfig() || { enabled: false, proxyUrl: '' };
        res.json({ success: true, data: config });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 保存代理配置
app.post('/api/proxy/config', authMiddleware, async (req, res) => {
    try {
        const { enabled, proxyUrl } = req.body;

        const config = {
            enabled: !!enabled,
            proxyUrl: proxyUrl || ''
        };

        await saveProxyConfig(config);

        res.json({
            success: true,
            message: enabled ? '代理已启用' : '代理已禁用',
            data: config
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 测试代理连接
app.post('/api/proxy/test', authMiddleware, async (req, res) => {
    try {
        const { proxyUrl } = req.body;

        if (!proxyUrl) {
            return res.status(400).json({ success: false, error: '请提供代理地址' });
        }

        const result = await testProxyConnection(proxyUrl);
        res.json({ success: result.success, message: result.message, ip: result.ip });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ 公开 API（无需登录）============

// 公开查询 API Key 用量
app.post('/api/public/usage', async (req, res) => {
    try {
        const { apiKey } = req.body;

        if (!apiKey) {
            return res.status(400).json({ success: false, error: '请提供 API 密钥' });
        }

        // 验证 API 密钥
        const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const keyRecord = await apiKeyStore.getByKeyHash(keyHash);

        if (!keyRecord) {
            return res.status(404).json({ success: false, error: 'API 密钥不存在或已禁用' });
        }

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        // 获取各时间段的用量
        const dailyStats = await apiLogStore.getStatsForApiKey(keyRecord.id, { startDate: todayStart });
        const monthlyStats = await apiLogStore.getStatsForApiKey(keyRecord.id, { startDate: monthStart });
        const totalStats = await apiLogStore.getStatsForApiKey(keyRecord.id, {});

        // 计算费用
        const dailyCost = await calculateApiKeyCost(keyRecord.id, { startDate: todayStart });
        const monthlyCost = await calculateApiKeyCost(keyRecord.id, { startDate: monthStart });
        const totalCost = await calculateApiKeyCost(keyRecord.id, {});

        // 获取按模型分组的统计
        const modelStats = await apiLogStore.getStatsByModel(keyRecord.id, {});
        const modelCosts = modelStats.map(stat => {
            const cost = calculateTokenCost(stat.model, stat.inputTokens, stat.outputTokens);
            return {
                model: stat.model,
                requestCount: stat.requestCount,
                inputTokens: stat.inputTokens,
                outputTokens: stat.outputTokens,
                inputCost: cost.inputCost,
                outputCost: cost.outputCost,
                totalCost: cost.totalCost
            };
        });

        // 计算有效期剩余天数和过期日期
        let remainingDays = null;
        let expireDate = null;
        if (keyRecord.expiresInDays > 0 && keyRecord.createdAt) {
            const createDate = new Date(keyRecord.createdAt);
            expireDate = new Date(createDate.getTime() + keyRecord.expiresInDays * 24 * 60 * 60 * 1000);
            remainingDays = Math.max(0, Math.ceil((expireDate - now) / (24 * 60 * 60 * 1000)));
        }

        res.json({
            success: true,
            data: {
                keyInfo: {
                    keyPrefix: keyRecord.keyPrefix,
                    name: keyRecord.name,
                    isActive: keyRecord.isActive,
                    createdAt: keyRecord.createdAt,
                    lastUsedAt: keyRecord.lastUsedAt
                },
                usage: {
                    daily: dailyStats.requestCount,
                    monthly: monthlyStats.requestCount,
                    total: totalStats.requestCount,
                    dailyCost,
                    monthlyCost,
                    totalCost
                },
                cost: {
                    models: modelCosts,
                    summary: {
                        totalRequests: totalStats.requestCount,
                        totalInputTokens: totalStats.totalInputTokens,
                        totalOutputTokens: totalStats.totalOutputTokens,
                        totalCost
                    }
                },
                limits: {
                    dailyLimit: keyRecord.dailyLimit,
                    monthlyLimit: keyRecord.monthlyLimit,
                    totalLimit: keyRecord.totalLimit,
                    dailyCostLimit: keyRecord.dailyCostLimit,
                    monthlyCostLimit: keyRecord.monthlyCostLimit,
                    totalCostLimit: keyRecord.totalCostLimit,
                    expiresInDays: keyRecord.expiresInDays,
                    remainingDays,
                    expireDate: formatLocalDateTime(expireDate)
                }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 默认管理员账户配置
const DEFAULT_ADMIN = {
    username: 'admin',
    password: 'admin123'
};

// 启动服务器
async function start() {
    // 初始化数据库
    await initDatabase();
    store = await CredentialStore.create();
    userStore = await UserStore.create();
    apiKeyStore = await ApiKeyStore.create();
    apiLogStore = await ApiLogStore.create();
    geminiStore = await GeminiCredentialStore.create();
    orchidsStore = await OrchidsCredentialStore.create();
    orchidsLoadBalancer = await getOrchidsLoadBalancer(orchidsStore);
    warpStore = await WarpCredentialStore.create();
    warpService = new WarpService(warpStore);
    trialStore = await TrialApplicationStore.create();
    siteSettingsStore = await SiteSettingsStore.create();
    pricingStore = await ModelPricingStore.create();

    // 加载动态定价配置
    try {
        const pricingMap = await pricingStore.getPricingMap();
        if (Object.keys(pricingMap).length > 0) {
            setDynamicPricing(pricingMap);
            console.log(`[${getTimestamp()}] 已加载 ${Object.keys(pricingMap).length} 个模型定价配置`);
        } else {
            // 如果没有配置，初始化默认定价
            console.log(`[${getTimestamp()}] 正在初始化默认模型定价配置...`);
            await pricingStore.initDefaultPricing();
            const newPricingMap = await pricingStore.getPricingMap();
            setDynamicPricing(newPricingMap);
            console.log(`[${getTimestamp()}] 已初始化 ${Object.keys(newPricingMap).length} 个默认定价配置`);
        }
    } catch (err) {
        console.error(`[${getTimestamp()}] 加载定价配置失败:`, err.message);
    }

    // 初始化代理配置
    const proxyConfig = await initProxyConfig();
    if (proxyConfig && proxyConfig.enabled) {
        // console.log(`[${getTimestamp()}] 代理已启用: ${proxyConfig.proxyUrl}`);
    }

    // 检测环境变量代理
    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (envProxy) {
        // console.log(`[${getTimestamp()}] 检测到环境变量代理: ${envProxy}`);
    } else {
        // console.log(`[${getTimestamp()}] 未检测到环境变量代理 (HTTPS_PROXY/HTTP_PROXY)`);
    }

    // 自动创建默认管理员账户（如果没有用户）
    if (!await userStore.hasUsers()) {
        const passwordHash = hashPassword(DEFAULT_ADMIN.password);
        await userStore.create(DEFAULT_ADMIN.username, passwordHash, true);
        // console.log(`[${getTimestamp()}] 已创建默认管理员账户`);
        // console.log(`[${getTimestamp()}] 用户名: ${DEFAULT_ADMIN.username}`);
        // console.log(`[${getTimestamp()}] 密码: ${DEFAULT_ADMIN.password}`);
        // console.log(`[${getTimestamp()}] 请登录后及时修改密码！`);
    }

    // 设置 Orchids 路由
    setupOrchidsRoutes(app, orchidsStore);

    // 设置 Warp 路由
    await setupWarpRoutes(app, warpStore, warpService, apiKeyStore);

    // 设置 Warp 多代理路由
    const warpMultiAgentService = setupWarpMultiAgentRoutes(app, warpStore);
    // console.log(`[${getTimestamp()}] Warp 多代理服务已启动`);

    // 设置 Warp 代理路由（一比一转发）
    setupWarpProxyRoutes(app, warpStore);
    // console.log(`[${getTimestamp()}] Warp 代理服务已启动`);

    // 设置 Gemini 路由
    setupGeminiRoutes(app, geminiStore, getTimestamp);
    
    // 设置 Vertex AI 路由
    await setupVertexRoutes(app);

    // 设置 Bedrock 路由
    app.use('/api/bedrock', bedrockRoutes);
    console.log(`[${getTimestamp()}] Bedrock 服务已启动`);

    // 启动定时刷新任务
    startCredentialsRefreshTask();
    startErrorCredentialsRefreshTask();

    // 启动日志清理任务（每天清理30天前的日志）
    startLogCleanupTask();

    const PORT = process.env.PORT || 13004;
    app.listen(PORT, () => {
        console.log(`[${getTimestamp()}] Kiro API Server 已启动 | http://localhost:${PORT}`);
        console.log('[API] 支持的端点:');
        console.log('[API]   Claude 格式:  /v1/messages');
        console.log('[API]   OpenAI 格式:  /v1/chat/completions');
        console.log('[API]   Gemini 格式:  /gemini-antigravity/v1/messages');
        console.log('[API]   Orchids 格式: /orchids/v1/messages');
        console.log('[API]   Vertex 格式:  /vertex/v1/messages');
        console.log('[API]   Bedrock 格式: /api/bedrock/chat');
        console.log('[API]   模型列表:     /v1/models');
    });
}

/**
 * 启动日志清理任务
 */
function startLogCleanupTask() {
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 每24小时执行一次
    const DAYS_TO_KEEP = 30; // 保留30天的日志

    // console.log(`[${getTimestamp()}] [日志清理] 任务已启动，每24小时清理${DAYS_TO_KEEP}天前的日志`);

    setInterval(async () => {
        try {
            await apiLogStore.cleanOldLogs(DAYS_TO_KEEP);
            // console.log(`[${getTimestamp()}] [日志清理] 已清理${DAYS_TO_KEEP}天前的日志`);
        } catch (error) {
            console.error(`[${getTimestamp()}] [日志清理] 清理失败: ${error.message}`);
        }
    }, CLEANUP_INTERVAL);
}

/**
 * 获取当前时间戳字符串
 */
function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// ============ 正常凭据定时刷新任务 ============
const CREDENTIALS_REFRESH_INTERVAL = 12 * 60 * 60 * 1000; // 12小时检查一次
const TOKEN_EXPIRY_THRESHOLD = 10; // 提前10分钟刷新

/**
 * 检查 Token 是否即将过期
 */
function isTokenExpiringSoon(credential, minutes = TOKEN_EXPIRY_THRESHOLD) {
    if (!credential.expiresAt) return false;
    try {
        const expirationTime = new Date(credential.expiresAt);
        const currentTime = new Date();
        const thresholdTime = new Date(currentTime.getTime() + minutes * 60 * 1000);
        return expirationTime.getTime() <= thresholdTime.getTime();
    } catch (error) {
        return false;
    }
}

/**
 * 刷新单个凭据的 Token
 */
async function refreshCredential(credential) {
    const region = credential.region || KIRO_CONSTANTS.DEFAULT_REGION;

    // console.log(`[${getTimestamp()}] [定时刷新] 开始刷新凭据 ${credential.id} (${credential.name})...`);
    // console.log(`[${getTimestamp()}] [定时刷新] 认证方式: ${credential.authMethod}`);

    try {
        let newAccessToken, newRefreshToken, expiresAt;

        if (credential.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            const refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', region);
            // console.log(`[${getTimestamp()}] [定时刷新] 请求 URL: ${refreshUrl}`);

            const response = await axios.post(refreshUrl, {
                refreshToken: credential.refreshToken
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });

            newAccessToken = response.data.accessToken;
            newRefreshToken = response.data.refreshToken || credential.refreshToken;
            expiresAt = response.data.expiresAt || null;
        } else if (credential.authMethod === KIRO_CONSTANTS.AUTH_METHOD_BUILDER_ID || credential.authMethod === KIRO_CONSTANTS.AUTH_METHOD_IDC) {
            if (!credential.clientId || !credential.clientSecret) {
                // console.log(`[${getTimestamp()}] [定时刷新] 凭据 ${credential.id} 缺少 clientId/clientSecret，跳过`);
                return false;
            }

            // IdC 和 builder-id 都使用 oidc 端点 (与 kiro2api 保持一致)
            const refreshUrl = KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', region);
            // console.log(`[${getTimestamp()}] [定时刷新] 请求 URL: ${refreshUrl}`);
            // console.log(`[${getTimestamp()}] [定时刷新] clientId: ${credential.clientId.substring(0, 10)}...`);
            // console.log(`[${getTimestamp()}] [定时刷新] refreshToken: ${credential.refreshToken ? credential.refreshToken.substring(0, 20) + '...' : '无'}`);

            // 使用 JSON 格式发送请求（与 AIClient-2-API 一致）
            const response = await axios.post(refreshUrl, {
                refreshToken: credential.refreshToken,
                clientId: credential.clientId,
                clientSecret: credential.clientSecret,
                grantType: 'refresh_token'
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });

            // 响应字段使用 camelCase
            newAccessToken = response.data.accessToken;
            newRefreshToken = response.data.refreshToken || credential.refreshToken;
            expiresAt = response.data.expiresIn
                ? new Date(Date.now() + response.data.expiresIn * 1000).toISOString()
                : null;
        }

        // 更新数据库中的凭据
        await store.update(credential.id, {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresAt
        });

        // console.log(`[${getTimestamp()}] [定时刷新] 凭据 ${credential.id} (${credential.name}) 刷新成功!`);
        // console.log(`[${getTimestamp()}] [定时刷新] 新 Token 前缀: ${newAccessToken.substring(0, 20)}...`);
        // console.log(`[${getTimestamp()}] [定时刷新] 过期时间: ${expiresAt || '未知'}`);

        return true;
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
        const errorDesc = error.response?.data?.error_description || '';
        // console.log(`[${getTimestamp()}] [定时刷新] 凭据 ${credential.id} (${credential.name}) 刷新失败: ${errorMsg}`);
        if (errorDesc) {
            // console.log(`[${getTimestamp()}] [定时刷新] 错误描述: ${errorDesc}`);
        }
        if (error.response?.data) {
            // console.log(`[${getTimestamp()}] [定时刷新] 完整响应: ${JSON.stringify(error.response.data)}`);
        }

        if (error.response?.status) {
            // console.log(`[${getTimestamp()}] [定时刷新] HTTP 状态码: ${error.response.status}`);
        }

        // 刷新失败，移动到错误表
        try {
            await store.moveToError(credential.id, errorMsg);
            // console.log(`[${getTimestamp()}] [定时刷新] 凭据 ${credential.id} 已移动到错误表`);
        } catch (moveError) {
            // console.log(`[${getTimestamp()}] [定时刷新] 移动凭据到错误表失败: ${moveError.message}`);
        }

        return false;
    }
}

/**
 * 启动正常凭据定时刷新任务
 */
function startCredentialsRefreshTask() {
    // console.log(`[${getTimestamp()}] [定时刷新] 正常凭据刷新任务已启动，间隔: ${CREDENTIALS_REFRESH_INTERVAL / 1000}秒，提前 ${TOKEN_EXPIRY_THRESHOLD} 分钟刷新`);

    // 定时执行
    setInterval(async () => {
        await checkAndRefreshCredentials();
    }, CREDENTIALS_REFRESH_INTERVAL);
}

/**
 * 检查并刷新即将过期的凭据
 */
async function checkAndRefreshCredentials() {
    const credentials = await store.getAll();
    if (credentials.length === 0) {
        return;
    }

    const expiringCredentials = credentials.filter(c =>
        c.refreshToken && isTokenExpiringSoon(c, TOKEN_EXPIRY_THRESHOLD)
    );

    if (expiringCredentials.length === 0) {
        // console.log(`[${getTimestamp()}] [定时刷新] 检查完成，没有即将过期的凭据`);
        return;
    }

    // console.log(`[${getTimestamp()}] [定时刷新] 发现 ${expiringCredentials.length} 个即将过期的凭据，开始刷新...`);

    for (const credential of expiringCredentials) {
        await refreshCredential(credential);
        // 每个凭据之间间隔 2 秒，避免请求过快
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // console.log(`[${getTimestamp()}] [定时刷新] 凭据刷新完成`);
}

// 错误凭据定时刷新任务
const ERROR_REFRESH_INTERVAL = 60 * 60 * 1000; // 1小时

async function refreshErrorCredential(errorCred) {
    const region = errorCred.region || KIRO_CONSTANTS.DEFAULT_REGION;

    // console.log(`[${getTimestamp()}] [错误凭据刷新] 开始刷新错误凭据 ${errorCred.id} (${errorCred.name})...`);
    // console.log(`[${getTimestamp()}] [错误凭据刷新] 认证方式: ${errorCred.authMethod}`);

    try {
        let newAccessToken, newRefreshToken, expiresAt;

        if (errorCred.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            const refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', region);
            // console.log(`[${getTimestamp()}] [错误凭据刷新] 请求 URL: ${refreshUrl}`);

            const response = await axios.post(refreshUrl, {
                refreshToken: errorCred.refreshToken
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000,
                ...getAxiosProxyConfig()
            });

            newAccessToken = response.data.accessToken;
            newRefreshToken = response.data.refreshToken || errorCred.refreshToken;
            expiresAt = response.data.expiresAt || null;
        } else {
            if (!errorCred.clientId || !errorCred.clientSecret) {
                // console.log(`[${getTimestamp()}] [错误凭据刷新] 凭据 ${errorCred.id} 缺少 clientId/clientSecret，跳过`);
                return false;
            }

            // IdC 使用 sso-oidc 端点，builder-id 使用 oidc 端点
            const refreshUrl = errorCred.authMethod === KIRO_CONSTANTS.AUTH_METHOD_IDC
                ? KIRO_CONSTANTS.REFRESH_SSO_OIDC_URL.replace('{{region}}', region)
                : KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', region);
            // console.log(`[${getTimestamp()}] [错误凭据刷新] 请求 URL: ${refreshUrl}`);

            // 使用 JSON 格式发送请求（与 AIClient-2-API 一致）
            const response = await axios.post(refreshUrl, {
                refreshToken: errorCred.refreshToken,
                clientId: errorCred.clientId,
                clientSecret: errorCred.clientSecret,
                grantType: 'refresh_token'
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000,
                ...getAxiosProxyConfig()
            });

            // 响应字段使用 camelCase
            newAccessToken = response.data.accessToken;
            newRefreshToken = response.data.refreshToken || errorCred.refreshToken;
            expiresAt = response.data.expiresIn
                ? new Date(Date.now() + response.data.expiresIn * 1000).toISOString()
                : null;
        }

        // console.log(`[${getTimestamp()}] [错误凭据刷新] Token 刷新成功，验证用量接口...`);

        // 验证用量接口是否能正常返回
        const usageResult = await KiroAPI.getUsageLimits({
            accessToken: newAccessToken,
            profileArn: errorCred.profileArn,
            authMethod: errorCred.authMethod,
            region: region
        });

        if (!usageResult.success) {
            // console.log(`[${getTimestamp()}] [错误凭据刷新] 凭据 ${errorCred.id} (${errorCred.name}) 用量验证失败: ${usageResult.error}`);
            // 更新错误凭据的 token，但不移动到正常表
            store.updateErrorToken(errorCred.id, newAccessToken, newRefreshToken, expiresAt);
            // console.log(`[${getTimestamp()}] [错误凭据刷新] 已更新 Token，但用量验证失败，保留在错误表中`);
            return false;
        }

        // console.log(`[${getTimestamp()}] [错误凭据刷新] 用量验证成功，恢复到正常表...`);

        // 刷新成功且用量验证通过，恢复到正常表
        const newId = await store.restoreFromError(errorCred.id, newAccessToken, newRefreshToken, expiresAt);
        // console.log(`[${getTimestamp()}] [错误凭据刷新] 凭据 ${errorCred.id} (${errorCred.name}) 刷新成功!`);
        // console.log(`[${getTimestamp()}] [错误凭据刷新] 新 Token 前缀: ${newAccessToken.substring(0, 20)}...`);
        // console.log(`[${getTimestamp()}] [错误凭据刷新] 已恢复到正常表，新 ID: ${newId}`);
        return true;
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
        // console.log(`[${getTimestamp()}] [错误凭据刷新] 凭据 ${errorCred.id} (${errorCred.name}) 刷新失败: ${errorMsg}`);
        if (error.response?.status) {
            // console.log(`[${getTimestamp()}] [错误凭据刷新] HTTP 状态码: ${error.response.status}`);
        }
        return false;
    }
}

function startErrorCredentialsRefreshTask() {
    // console.log(`[${getTimestamp()}] [错误凭据刷新] 任务已启动，间隔: ${ERROR_REFRESH_INTERVAL / 1000}秒`);

    setInterval(async () => {
        const errorCredentials = await store.getAllErrors();
        if (errorCredentials.length === 0) {
            return;
        }

        // console.log(`[${getTimestamp()}] [错误凭据刷新] 开始刷新 ${errorCredentials.length} 个错误凭据...`);

        for (const errorCred of errorCredentials) {
            if (!errorCred.refreshToken) {
                // console.log(`[${getTimestamp()}] [错误凭据刷新] 凭据 ${errorCred.id} 没有 refreshToken，跳过`);
                continue;
            }

            await refreshErrorCredential(errorCred);

            // 每个凭据之间间隔 2 秒，避免请求过快
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // console.log(`[${getTimestamp()}] [错误凭据刷新] 刷新完成`);
    }, ERROR_REFRESH_INTERVAL);
}

start();

export default app;
