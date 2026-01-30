/**
 * Orchids 负载均衡器
 * 参考 orchids-api-main 的 loadbalancer.go 实现
 * 提供加权随机选择和故障转移功能
 */
import { logger } from '../logger.js';

const log = logger.api;

// 账号缓存刷新间隔（30秒）
const ACCOUNTS_CACHE_TTL = 30 * 1000;
// 请求计数批量更新间隔（10秒）
const COUNT_UPDATE_INTERVAL = 10 * 1000;

/**
 * Orchids 负载均衡器类
 */
export class OrchidsLoadBalancer {
    constructor(store) {
        this.store = store;
        
        // 账号缓存
        this.accounts = [];
        this.lastRefresh = 0;
        
        // 异步请求计数更新
        this.pendingUpdates = new Map();  // accountId -> requestCount
        this.pendingSuccess = new Map();  // accountId -> successCount
        this.pendingFailure = new Map();  // accountId -> failureCount
        
        // 正在使用的账号（防止并发请求使用同一账号）
        this.inUseAccounts = new Set();   // accountId 集合
        this.inUseTimeout = 120000;       // 120秒超时自动释放
        this.inUseTimers = new Map();     // accountId -> timeout 定时器
        
        // 定时器
        this.refreshTimer = null;
        this.updateTimer = null;
        
        // 初始化
        this._init();
    }

    /**
     * 初始化负载均衡器
     */
    async _init() {
        // 立即加载账号列表
        await this.refreshAccounts();
        
        // 启动后台任务
        this.refreshTimer = setInterval(() => this.refreshAccounts(), ACCOUNTS_CACHE_TTL);
        this.updateTimer = setInterval(() => this.flushPendingUpdates(), COUNT_UPDATE_INTERVAL);
        
        log.info(`[LoadBalancer] 已启动，账号缓存TTL=${ACCOUNTS_CACHE_TTL}ms, 计数更新间隔=${COUNT_UPDATE_INTERVAL}ms`);
    }

    /**
     * 关闭负载均衡器
     */
    async close() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
        // 最后一次刷新计数
        await this.flushPendingUpdates();
        log.info('[LoadBalancer] 已关闭');
    }

    /**
     * 刷新账号缓存
     */
    async refreshAccounts() {
        try {
            const accounts = await this.store.getEnabledAccounts();
            this.accounts = accounts;
            this.lastRefresh = Date.now();
            log.info(`[LoadBalancer] 账号缓存已刷新: ${accounts.length} 个可用账号`);
        } catch (error) {
            log.error(`[LoadBalancer] 刷新账号失败: ${error.message}`);
        }
    }

    /**
     * 强制刷新账号缓存
     */
    async forceRefresh() {
        await this.refreshAccounts();
    }

    /**
     * 将待更新的请求计数写入数据库
     */
    async flushPendingUpdates() {
        if (this.pendingUpdates.size === 0 && 
            this.pendingSuccess.size === 0 && 
            this.pendingFailure.size === 0) {
            return;
        }

        // 复制并清空待更新队列
        const updates = new Map(this.pendingUpdates);
        const successUpdates = new Map(this.pendingSuccess);
        const failureUpdates = new Map(this.pendingFailure);
        this.pendingUpdates.clear();
        this.pendingSuccess.clear();
        this.pendingFailure.clear();

        // 更新请求计数
        for (const [accountId, count] of updates) {
            try {
                await this.store.addRequestCount(accountId, count);
            } catch (error) {
                log.error(`[LoadBalancer] 更新请求计数失败: accountId=${accountId}, count=${count}, err=${error.message}`);
            }
        }

        // 更新成功计数
        for (const [accountId, count] of successUpdates) {
            try {
                await this.store.addSuccessCount(accountId, count);
            } catch (error) {
                log.error(`[LoadBalancer] 更新成功计数失败: accountId=${accountId}, count=${count}, err=${error.message}`);
            }
        }

        // 更新失败计数
        for (const [accountId, count] of failureUpdates) {
            try {
                await this.store.addFailureCount(accountId, count);
            } catch (error) {
                log.error(`[LoadBalancer] 更新失败计数失败: accountId=${accountId}, count=${count}, err=${error.message}`);
            }
        }
    }

    /**
     * 调度请求计数更新（异步）
     */
    scheduleCountUpdate(accountId) {
        const current = this.pendingUpdates.get(accountId) || 0;
        this.pendingUpdates.set(accountId, current + 1);
    }

    /**
     * 调度成功计数更新（异步）
     */
    scheduleSuccessCount(accountId) {
        const current = this.pendingSuccess.get(accountId) || 0;
        this.pendingSuccess.set(accountId, current + 1);
    }

    /**
     * 调度失败计数更新（异步）
     */
    scheduleFailureCount(accountId) {
        const current = this.pendingFailure.get(accountId) || 0;
        this.pendingFailure.set(accountId, current + 1);
    }

    /**
     * 获取缓存的账号列表（如果缓存过期则刷新）
     */
    async getCachedAccounts() {
        // 如果缓存为空或过期，同步刷新
        if (this.accounts.length === 0 || Date.now() - this.lastRefresh > ACCOUNTS_CACHE_TTL * 2) {
            await this.refreshAccounts();
        }
        return this.accounts;
    }

    /**
     * 获取下一个账号
     */
    async getNextAccount() {
        return this.getNextAccountExcluding([]);
    }

    /**
     * 获取下一个账号（排除指定账号）
     * @param {number[]} excludeIds - 要排除的账号 ID 列表
     */
    async getNextAccountExcluding(excludeIds = []) {
        // 从缓存获取账号列表
        let accounts = await this.getCachedAccounts();

        // 过滤排除的账号
        if (excludeIds.length > 0) {
            const excludeSet = new Set(excludeIds);
            accounts = accounts.filter(acc => !excludeSet.has(acc.id));
        }

        // 过滤正在使用的账号（防止并发请求使用同一账号）
        const availableAccounts = accounts.filter(acc => !this.inUseAccounts.has(acc.id));
        
        if (availableAccounts.length === 0) {
            // 如果没有可用账号，记录警告并尝试使用被排除的账号
            if (accounts.length > 0) {
                console.warn(`[LoadBalancer] ⚠️ 所有 ${accounts.length} 个账号都在使用中，强制复用账号（可能导致冲突）`);
                const account = this._selectAccount(accounts);
                this.scheduleCountUpdate(account.id);
                this.lockAccount(account.id);
                return account;
            }
            console.error(`[LoadBalancer] ❌ 没有可用账号`);
            return null;
        }
        
        console.log(`[LoadBalancer] 选择账号 | 可用: ${availableAccounts.length}/${accounts.length} | 已锁定: ${this.inUseAccounts.size}`);

        // 选择账号
        const account = this._selectAccount(availableAccounts);

        // 异步更新请求计数（不阻塞请求处理）
        this.scheduleCountUpdate(account.id);
        
        // 锁定账号
        this.lockAccount(account.id);

        return account;
    }
    
    /**
     * 锁定账号（标记为正在使用）
     */
    lockAccount(accountId) {
        this.inUseAccounts.add(accountId);
        
        // 设置超时自动释放（防止异常情况导致账号永久锁定）
        if (this.inUseTimers.has(accountId)) {
            clearTimeout(this.inUseTimers.get(accountId));
        }
        const timer = setTimeout(() => {
            this.unlockAccount(accountId);
            console.warn(`[LoadBalancer] 账号 ${accountId} 自动释放（超时）`);
        }, this.inUseTimeout);
        this.inUseTimers.set(accountId, timer);
        
        console.log(`[LoadBalancer] 锁定账号 ${accountId} | 当前使用中: ${this.inUseAccounts.size} 个 | 已锁定: [${Array.from(this.inUseAccounts).join(', ')}]`);
    }
    
    /**
     * 释放账号（标记为可用）
     */
    unlockAccount(accountId) {
        const wasLocked = this.inUseAccounts.has(accountId);
        this.inUseAccounts.delete(accountId);
        
        if (this.inUseTimers.has(accountId)) {
            clearTimeout(this.inUseTimers.get(accountId));
            this.inUseTimers.delete(accountId);
        }
        
        if (wasLocked) {
            console.log(`[LoadBalancer] 释放账号 ${accountId} | 当前使用中: ${this.inUseAccounts.size} 个`);
        }
    }

    /**
     * 使用加权随机算法选择账号
     * @param {Array} accounts - 账号列表
     */
    _selectAccount(accounts) {
        if (accounts.length === 1) {
            return accounts[0];
        }

        // 构建前缀和数组
        const prefixSum = [0];
        for (const acc of accounts) {
            prefixSum.push(prefixSum[prefixSum.length - 1] + (acc.weight || 1));
        }

        const totalWeight = prefixSum[prefixSum.length - 1];
        if (totalWeight === 0) {
            return accounts[0];
        }

        const randomWeight = Math.floor(Math.random() * totalWeight);

        // 二分查找：找到第一个 prefixSum[i+1] > randomWeight 的 i
        let left = 0;
        let right = accounts.length - 1;
        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (prefixSum[mid + 1] > randomWeight) {
                right = mid;
            } else {
                left = mid + 1;
            }
        }

        return accounts[left];
    }

    /**
     * 标记账号为活跃（成功请求后调用）
     */
    async markAccountActive(accountId) {
        try {
            await this.store.resetErrorCount(accountId);
        } catch (error) {
            log.warn(`[LoadBalancer] 标记账号活跃失败: ${error.message}`);
        }
    }

    /**
     * 标记账号失败
     */
    async markAccountFailed(accountId, errorMessage) {
        try {
            await this.store.incrementErrorCount(accountId, errorMessage);
        } catch (error) {
            log.warn(`[LoadBalancer] 标记账号失败时出错: ${error.message}`);
        }
    }

    /**
     * 获取账号数量
     */
    getAccountCount() {
        return this.accounts.length;
    }

    /**
     * 获取所有缓存的账号
     */
    getAllAccounts() {
        return [...this.accounts];
    }
}

// 全局负载均衡器实例
let globalLoadBalancer = null;

/**
 * 获取全局负载均衡器实例
 * @param {OrchidsCredentialStore} store - 凭证存储
 */
export async function getOrchidsLoadBalancer(store) {
    if (!globalLoadBalancer && store) {
        globalLoadBalancer = new OrchidsLoadBalancer(store);
        // 等待初始化完成
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return globalLoadBalancer;
}

/**
 * 关闭全局负载均衡器
 */
export async function closeOrchidsLoadBalancer() {
    if (globalLoadBalancer) {
        await globalLoadBalancer.close();
        globalLoadBalancer = null;
    }
}

export default OrchidsLoadBalancer;
