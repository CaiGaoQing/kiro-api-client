import mysql from 'mysql2/promise';

// MySQL 连接配置
const DB_CONFIG = {
    host: process.env.MYSQL_HOST || '43.228.76.217',
    port: parseInt(process.env.MYSQL_PORT || '13306'),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '4561230wW?',
    database: process.env.MYSQL_DATABASE || 'kiro_api',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool = null;

/**
 * 初始化数据库连接池
 */
export async function initDatabase() {
    if (pool) return pool;

    pool = mysql.createPool(DB_CONFIG);

    // 创建凭据表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS credentials (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(255) NOT NULL UNIQUE,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            profile_arn VARCHAR(512),
            client_id VARCHAR(255),
            client_secret TEXT,
            auth_method VARCHAR(50) DEFAULT 'social',
            provider VARCHAR(50) DEFAULT 'Google',
            region VARCHAR(50) DEFAULT 'us-east-1',
            expires_at VARCHAR(50),
            is_active TINYINT DEFAULT 1,
            usage_data JSON,
            usage_updated_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 添加 provider 列（如果不存在）
    try {
        await pool.execute(`ALTER TABLE credentials ADD COLUMN provider VARCHAR(50) DEFAULT 'Google' AFTER auth_method`);
    } catch (e) {
        // 列已存在，忽略错误
    }

    // 创建错误凭据表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS error_credentials (
            id INT PRIMARY KEY AUTO_INCREMENT,
            original_id INT,
            name VARCHAR(255) NOT NULL,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            profile_arn VARCHAR(512),
            client_id VARCHAR(255),
            client_secret TEXT,
            auth_method VARCHAR(50) DEFAULT 'social',
            region VARCHAR(50) DEFAULT 'us-east-1',
            expires_at VARCHAR(50),
            error_message TEXT,
            error_count INT DEFAULT 1,
            last_error_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建用户表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INT PRIMARY KEY AUTO_INCREMENT,
            username VARCHAR(255) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            is_admin TINYINT DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建 API 密钥表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            name VARCHAR(255) NOT NULL,
            key_value VARCHAR(255) NOT NULL,
            key_hash VARCHAR(255) NOT NULL UNIQUE,
            key_prefix VARCHAR(50) NOT NULL,
            is_active TINYINT DEFAULT 1,
            last_used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            daily_limit INT DEFAULT 0,
            monthly_limit INT DEFAULT 0,
            total_limit INT DEFAULT 0,
            concurrent_limit INT DEFAULT 0,
            rate_limit INT DEFAULT 0,
            daily_cost_limit DECIMAL(10,2) DEFAULT 0,
            monthly_cost_limit DECIMAL(10,2) DEFAULT 0,
            total_cost_limit DECIMAL(10,2) DEFAULT 0,
            expires_in_days INT DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建 API 日志表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS api_logs (
            id INT PRIMARY KEY AUTO_INCREMENT,
            request_id VARCHAR(100) NOT NULL,
            api_key_id INT,
            api_key_prefix VARCHAR(50),
            credential_id INT,
            credential_name VARCHAR(255),
            ip_address VARCHAR(50),
            user_agent TEXT,
            method VARCHAR(10) DEFAULT 'POST',
            path VARCHAR(255) DEFAULT '/v1/messages',
            model VARCHAR(100),
            stream TINYINT DEFAULT 0,
            input_tokens INT DEFAULT 0,
            output_tokens INT DEFAULT 0,
            request_messages MEDIUMTEXT,
            response_content MEDIUMTEXT,
            status_code INT DEFAULT 200,
            error_message TEXT,
            duration_ms INT DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_created_at (created_at),
            INDEX idx_api_key_id (api_key_id),
            INDEX idx_ip_address (ip_address),
            INDEX idx_request_id (request_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建 Gemini Antigravity 凭证表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS gemini_credentials (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(255) NOT NULL UNIQUE,
            email VARCHAR(255),
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            project_id VARCHAR(255),
            expires_at VARCHAR(50),
            is_active TINYINT DEFAULT 1,
            usage_data JSON,
            usage_updated_at DATETIME,
            error_count INT DEFAULT 0,
            last_error_at DATETIME,
            last_error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建 Gemini 错误凭证表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS gemini_error_credentials (
            id INT PRIMARY KEY AUTO_INCREMENT,
            original_id INT,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255),
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            project_id VARCHAR(255),
            expires_at VARCHAR(50),
            error_message TEXT,
            error_count INT DEFAULT 1,
            last_error_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建 Orchids 凭证表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS orchids_credentials (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(255) NOT NULL UNIQUE,
            email VARCHAR(255),
            client_jwt TEXT NOT NULL,
            clerk_session_id VARCHAR(255),
            user_id VARCHAR(255),
            expires_at VARCHAR(50),
            is_active TINYINT DEFAULT 1,
            usage_data JSON,
            usage_updated_at DATETIME,
            error_count INT DEFAULT 0,
            last_error_at DATETIME,
            last_error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建 Orchids 错误凭证表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS orchids_error_credentials (
            id INT PRIMARY KEY AUTO_INCREMENT,
            original_id INT,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255),
            client_jwt TEXT NOT NULL,
            clerk_session_id VARCHAR(255),
            user_id VARCHAR(255),
            expires_at VARCHAR(50),
            error_message TEXT,
            error_count INT DEFAULT 1,
            last_error_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建 Warp 凭证表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS warp_credentials (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(255) NOT NULL UNIQUE,
            email VARCHAR(255),
            refresh_token TEXT NOT NULL,
            access_token TEXT,
            token_expires_at DATETIME,
            is_active TINYINT DEFAULT 1,
            use_count INT DEFAULT 0,
            last_used_at DATETIME,
            error_count INT DEFAULT 0,
            last_error_at DATETIME,
            last_error_message TEXT,
            quota_limit INT DEFAULT 0,
            quota_used INT DEFAULT 0,
            quota_updated_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    // 添加用量字段（如果不存在）
    try {
        await pool.execute(`ALTER TABLE warp_credentials ADD COLUMN quota_limit INT DEFAULT 0`);
    } catch (e) { /* 字段已存在 */ }
    try {
        await pool.execute(`ALTER TABLE warp_credentials ADD COLUMN quota_used INT DEFAULT 0`);
    } catch (e) { /* 字段已存在 */ }
    try {
        await pool.execute(`ALTER TABLE warp_credentials ADD COLUMN quota_updated_at DATETIME`);
    } catch (e) { /* 字段已存在 */ }

    // 创建 Warp 请求统计表（不记录消息内容）
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS warp_request_stats (
            id INT PRIMARY KEY AUTO_INCREMENT,
            credential_id INT NOT NULL,
            api_key_id INT,
            endpoint VARCHAR(100) NOT NULL,
            model VARCHAR(100) NOT NULL,
            is_stream TINYINT DEFAULT 0,
            input_tokens INT DEFAULT 0,
            output_tokens INT DEFAULT 0,
            total_tokens INT DEFAULT 0,
            duration_ms INT DEFAULT 0,
            status VARCHAR(20) DEFAULT 'success',
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_credential_id (credential_id),
            INDEX idx_api_key_id (api_key_id),
            INDEX idx_created_at (created_at),
            INDEX idx_model (model)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建 Warp 错误凭证表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS warp_error_credentials (
            id INT PRIMARY KEY AUTO_INCREMENT,
            original_id INT,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255),
            refresh_token TEXT NOT NULL,
            access_token TEXT,
            error_message TEXT,
            error_count INT DEFAULT 1,
            last_error_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建试用申请表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS trial_applications (
            id INT PRIMARY KEY AUTO_INCREMENT,
            xianyu_name VARCHAR(255) NOT NULL,
            order_screenshot MEDIUMTEXT,
            source VARCHAR(100),
            email VARCHAR(255) NOT NULL,
            status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
            api_key VARCHAR(255),
            api_key_expires_at DATETIME,
            cost_limit DECIMAL(10,2) DEFAULT 50.00,
            reject_reason TEXT,
            reviewed_by INT,
            reviewed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_email (email),
            INDEX idx_status (status),
            INDEX idx_xianyu_name (xianyu_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 修改 order_screenshot 字段为 MEDIUMTEXT（如果表已存在且字段是 TEXT）
    try {
        await pool.execute(`ALTER TABLE trial_applications MODIFY COLUMN order_screenshot MEDIUMTEXT`);
    } catch (e) {
        // 忽略错误
    }

    // 创建站点设置表
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS site_settings (
            id INT PRIMARY KEY DEFAULT 1,
            site_name VARCHAR(50) DEFAULT 'Kiro',
            site_logo VARCHAR(10) DEFAULT 'K',
            site_subtitle VARCHAR(100) DEFAULT 'Account Manager',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 确保站点设置表有默认记录
    try {
        await pool.execute(`INSERT IGNORE INTO site_settings (id, site_name, site_logo, site_subtitle) VALUES (1, 'Kiro', 'K', 'Account Manager')`);
    } catch (e) {
        // 忽略错误
    }

    return pool;
}

/**
 * 获取数据库连接池
 */
export async function getDatabase() {
    if (!pool) {
        await initDatabase();
    }
    return pool;
}

/**
 * 关闭数据库连接池
 */
export async function closeDatabase() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

/**
 * 凭据管理类
 */
export class CredentialStore {
    constructor(database) {
        this.db = database;
    }

    static async create() {
        const database = await getDatabase();
        return new CredentialStore(database);
    }

    async add(credential) {
        const [result] = await this.db.execute(`
            INSERT INTO credentials (name, access_token, refresh_token, profile_arn, client_id, client_secret, auth_method, provider, region, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            credential.name,
            credential.accessToken,
            credential.refreshToken || null,
            credential.profileArn || null,
            credential.clientId || null,
            credential.clientSecret || null,
            credential.authMethod || 'social',
            credential.provider || 'Google',
            credential.region || 'us-east-1',
            credential.expiresAt || null
        ]);
        return result.insertId;
    }

    async update(id, credential) {
        const toNull = (val) => val === undefined ? null : val;
        await this.db.execute(`
            UPDATE credentials SET
                name = COALESCE(?, name),
                access_token = COALESCE(?, access_token),
                refresh_token = COALESCE(?, refresh_token),
                profile_arn = COALESCE(?, profile_arn),
                client_id = COALESCE(?, client_id),
                client_secret = COALESCE(?, client_secret),
                auth_method = COALESCE(?, auth_method),
                provider = COALESCE(?, provider),
                region = COALESCE(?, region),
                expires_at = COALESCE(?, expires_at)
            WHERE id = ?
        `, [
            toNull(credential.name),
            toNull(credential.accessToken),
            toNull(credential.refreshToken),
            toNull(credential.profileArn),
            toNull(credential.clientId),
            toNull(credential.clientSecret),
            toNull(credential.authMethod),
            toNull(credential.provider),
            toNull(credential.region),
            toNull(credential.expiresAt),
            id
        ]);
    }

    async delete(id) {
        await this.db.execute('DELETE FROM credentials WHERE id = ?', [id]);
    }

    async getById(id) {
        const [rows] = await this.db.execute('SELECT * FROM credentials WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getByName(name) {
        const [rows] = await this.db.execute('SELECT * FROM credentials WHERE name = ?', [name]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getAll() {
        const [rows] = await this.db.execute('SELECT * FROM credentials ORDER BY created_at DESC');
        return rows.map(row => this._mapRow(row));
    }

    async getActive() {
        const [rows] = await this.db.execute('SELECT * FROM credentials WHERE is_active = 1 LIMIT 1');
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async setActive(id) {
        await this.db.execute('UPDATE credentials SET is_active = 0');
        await this.db.execute('UPDATE credentials SET is_active = 1 WHERE id = ?', [id]);
    }

    async importFromFile(filePath, name) {
        const fs = await import('fs');
        const content = fs.readFileSync(filePath, 'utf8');
        const creds = JSON.parse(content);

        return this.add({
            name: name || `imported_${Date.now()}`,
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            profileArn: creds.profileArn,
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            authMethod: creds.authMethod,
            region: creds.region,
            expiresAt: creds.expiresAt
        });
    }

    async batchImportSocialAccounts(accounts, region = 'us-east-1') {
        const results = {
            success: 0,
            failed: 0,
            errors: [],
            imported: []
        };

        for (const account of accounts) {
            try {
                if (!account.email || !account.refreshToken) {
                    results.failed++;
                    results.errors.push({
                        email: account.email || 'unknown',
                        error: '缺少 email 或 refreshToken'
                    });
                    continue;
                }

                const provider = account.provider || 'Google';

                const existing = await this.getByName(account.email);
                if (existing) {
                    await this.update(existing.id, {
                        refreshToken: account.refreshToken,
                        authMethod: 'social',
                        provider: provider,
                        region: region
                    });
                    results.success++;
                    results.imported.push({
                        email: account.email,
                        id: existing.id,
                        action: 'updated'
                    });
                } else {
                    const id = await this.add({
                        name: account.email,
                        accessToken: account.refreshToken,
                        refreshToken: account.refreshToken,
                        authMethod: 'social',
                        provider: provider,
                        region: region
                    });
                    results.success++;
                    results.imported.push({
                        email: account.email,
                        id: id,
                        action: 'created'
                    });
                }
            } catch (error) {
                results.failed++;
                results.errors.push({
                    email: account.email || 'unknown',
                    error: error.message
                });
            }
        }

        return results;
    }

    _mapRow(row) {
        return {
            id: row.id,
            name: row.name,
            email: row.name,
            accessToken: row.access_token,
            refreshToken: row.refresh_token,
            profileArn: row.profile_arn,
            clientId: row.client_id,
            clientSecret: row.client_secret,
            authMethod: row.auth_method,
            provider: row.provider || 'Google',
            region: row.region,
            expiresAt: row.expires_at,
            isActive: row.is_active === 1,
            usageData: row.usage_data ? (typeof row.usage_data === 'string' ? JSON.parse(row.usage_data) : row.usage_data) : null,
            usageUpdatedAt: row.usage_updated_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    async updateUsage(id, usageData) {
        const usageJson = JSON.stringify(usageData);
        await this.db.execute(`
            UPDATE credentials SET
                usage_data = ?,
                usage_updated_at = NOW()
            WHERE id = ?
        `, [usageJson, id]);
    }

    _mapErrorRow(row) {
        return {
            id: row.id,
            originalId: row.original_id,
            name: row.name,
            accessToken: row.access_token,
            refreshToken: row.refresh_token,
            profileArn: row.profile_arn,
            clientId: row.client_id,
            clientSecret: row.client_secret,
            authMethod: row.auth_method,
            region: row.region,
            expiresAt: row.expires_at,
            errorMessage: row.error_message,
            errorCount: row.error_count,
            lastErrorAt: row.last_error_at,
            createdAt: row.created_at
        };
    }

    async moveToError(id, errorMessage) {
        const credential = await this.getById(id);
        if (!credential) return null;

        const [existingError] = await this.db.execute(
            'SELECT id, error_count FROM error_credentials WHERE original_id = ?',
            [id]
        );

        if (existingError.length > 0) {
            const errorId = existingError[0].id;
            const errorCount = existingError[0].error_count + 1;
            await this.db.execute(`
                UPDATE error_credentials SET
                    error_message = ?,
                    error_count = ?,
                    last_error_at = NOW()
                WHERE id = ?
            `, [errorMessage, errorCount, errorId]);
        } else {
            await this.db.execute(`
                INSERT INTO error_credentials (
                    original_id, name, access_token, refresh_token, profile_arn,
                    client_id, client_secret, auth_method, region, expires_at,
                    error_message, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                credential.id,
                credential.name,
                credential.accessToken,
                credential.refreshToken,
                credential.profileArn,
                credential.clientId,
                credential.clientSecret,
                credential.authMethod,
                credential.region,
                credential.expiresAt,
                errorMessage,
                credential.createdAt
            ]);
        }

        await this.delete(id);
        return credential;
    }

    async restoreFromError(errorId, newAccessToken, newRefreshToken, newExpiresAt) {
        const [rows] = await this.db.execute('SELECT * FROM error_credentials WHERE id = ?', [errorId]);
        if (rows.length === 0) return null;

        const errorCred = this._mapErrorRow(rows[0]);

        const [result] = await this.db.execute(`
            INSERT INTO credentials (
                name, access_token, refresh_token, profile_arn,
                client_id, client_secret, auth_method, region, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            errorCred.name,
            newAccessToken || errorCred.accessToken,
            newRefreshToken || errorCred.refreshToken,
            errorCred.profileArn,
            errorCred.clientId,
            errorCred.clientSecret,
            errorCred.authMethod,
            errorCred.region,
            newExpiresAt || errorCred.expiresAt,
            errorCred.createdAt
        ]);

        await this.db.execute('DELETE FROM error_credentials WHERE id = ?', [errorId]);
        return result.insertId;
    }

    async getAllErrors() {
        const [rows] = await this.db.execute('SELECT * FROM error_credentials ORDER BY last_error_at DESC');
        return rows.map(row => this._mapErrorRow(row));
    }

    async getErrorById(id) {
        const [rows] = await this.db.execute('SELECT * FROM error_credentials WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapErrorRow(rows[0]);
    }

    async deleteError(id) {
        await this.db.execute('DELETE FROM error_credentials WHERE id = ?', [id]);
    }

    async updateErrorToken(id, accessToken, refreshToken, expiresAt) {
        const toNull = (val) => val === undefined ? null : val;
        await this.db.execute(`
            UPDATE error_credentials SET
                access_token = COALESCE(?, access_token),
                refresh_token = COALESCE(?, refresh_token),
                expires_at = COALESCE(?, expires_at)
            WHERE id = ?
        `, [toNull(accessToken), toNull(refreshToken), toNull(expiresAt), id]);
    }
}

/**
 * 用户管理类
 */
export class UserStore {
    constructor(database) {
        this.db = database;
    }

    static async create() {
        const database = await getDatabase();
        return new UserStore(database);
    }

    async create(username, passwordHash, isAdmin = false) {
        try {
            const [result] = await this.db.execute(`
                INSERT INTO users (username, password_hash, is_admin)
                VALUES (?, ?, ?)
            `, [username, passwordHash, isAdmin ? 1 : 0]);
            return result.insertId;
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                throw new Error('用户名已存在');
            }
            throw error;
        }
    }

    async getByUsername(username) {
        const [rows] = await this.db.execute('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getById(id) {
        const [rows] = await this.db.execute('SELECT * FROM users WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getAll() {
        const [rows] = await this.db.execute('SELECT * FROM users ORDER BY created_at DESC');
        return rows.map(row => this._mapRow(row));
    }

    async updatePassword(id, passwordHash) {
        await this.db.execute(`
            UPDATE users SET password_hash = ?
            WHERE id = ?
        `, [passwordHash, id]);
    }

    async delete(id) {
        await this.db.execute('DELETE FROM api_keys WHERE user_id = ?', [id]);
        await this.db.execute('DELETE FROM users WHERE id = ?', [id]);
    }

    async hasUsers() {
        const [rows] = await this.db.execute('SELECT COUNT(*) as count FROM users');
        return rows[0].count > 0;
    }

    _mapRow(row) {
        return {
            id: row.id,
            username: row.username,
            passwordHash: row.password_hash,
            isAdmin: row.is_admin === 1,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

/**
 * API 密钥管理类
 */
export class ApiKeyStore {
    constructor(database) {
        this.db = database;
    }

    static async create() {
        const database = await getDatabase();
        return new ApiKeyStore(database);
    }

    async create(userId, name, keyValue, keyHash, keyPrefix) {
        const [result] = await this.db.execute(`
            INSERT INTO api_keys (user_id, name, key_value, key_hash, key_prefix)
            VALUES (?, ?, ?, ?, ?)
        `, [userId, name, keyValue, keyHash, keyPrefix]);
        return result.insertId;
    }

    async getByKeyHash(keyHash) {
        const [rows] = await this.db.execute('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1', [keyHash]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getByUserId(userId) {
        const [rows] = await this.db.execute('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', [userId]);
        return rows.map(row => this._mapRow(row));
    }

    async getAll() {
        const [rows] = await this.db.execute(`
            SELECT ak.*, u.username
            FROM api_keys ak
            LEFT JOIN users u ON ak.user_id = u.id
            ORDER BY ak.created_at DESC
        `);
        return rows.map(row => this._mapRowWithUser(row));
    }

    async updateLastUsed(id) {
        await this.db.execute(`
            UPDATE api_keys SET last_used_at = NOW()
            WHERE id = ?
        `, [id]);
    }

    async disable(id) {
        await this.db.execute('UPDATE api_keys SET is_active = 0 WHERE id = ?', [id]);
    }

    async enable(id) {
        await this.db.execute('UPDATE api_keys SET is_active = 1 WHERE id = ?', [id]);
    }

    async delete(id) {
        await this.db.execute('DELETE FROM api_keys WHERE id = ?', [id]);
    }

    async updateLimits(id, limits) {
        const { dailyLimit, monthlyLimit, totalLimit, concurrentLimit, rateLimit, dailyCostLimit, monthlyCostLimit, totalCostLimit, expiresInDays } = limits;
        await this.db.execute(`
            UPDATE api_keys SET
                daily_limit = COALESCE(?, daily_limit),
                monthly_limit = COALESCE(?, monthly_limit),
                total_limit = COALESCE(?, total_limit),
                concurrent_limit = COALESCE(?, concurrent_limit),
                rate_limit = COALESCE(?, rate_limit),
                daily_cost_limit = COALESCE(?, daily_cost_limit),
                monthly_cost_limit = COALESCE(?, monthly_cost_limit),
                total_cost_limit = COALESCE(?, total_cost_limit),
                expires_in_days = COALESCE(?, expires_in_days)
            WHERE id = ?
        `, [
            dailyLimit ?? null,
            monthlyLimit ?? null,
            totalLimit ?? null,
            concurrentLimit ?? null,
            rateLimit ?? null,
            dailyCostLimit ?? null,
            monthlyCostLimit ?? null,
            totalCostLimit ?? null,
            expiresInDays ?? null,
            id
        ]);
    }

    async getById(id) {
        const [rows] = await this.db.execute('SELECT * FROM api_keys WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    _mapRow(row) {
        return {
            id: row.id,
            userId: row.user_id,
            name: row.name,
            keyValue: row.key_value,
            keyHash: row.key_hash,
            keyPrefix: row.key_prefix,
            isActive: row.is_active === 1,
            lastUsedAt: row.last_used_at,
            createdAt: row.created_at,
            dailyLimit: row.daily_limit || 0,
            monthlyLimit: row.monthly_limit || 0,
            totalLimit: row.total_limit || 0,
            concurrentLimit: row.concurrent_limit || 0,
            rateLimit: row.rate_limit || 0,
            dailyCostLimit: parseFloat(row.daily_cost_limit) || 0,
            monthlyCostLimit: parseFloat(row.monthly_cost_limit) || 0,
            totalCostLimit: parseFloat(row.total_cost_limit) || 0,
            expiresInDays: row.expires_in_days || 0
        };
    }

    _mapRowWithUser(row) {
        return {
            id: row.id,
            userId: row.user_id,
            username: row.username,
            name: row.name,
            keyValue: row.key_value,
            keyHash: row.key_hash,
            keyPrefix: row.key_prefix,
            isActive: row.is_active === 1,
            lastUsedAt: row.last_used_at,
            createdAt: row.created_at,
            dailyLimit: row.daily_limit || 0,
            monthlyLimit: row.monthly_limit || 0,
            totalLimit: row.total_limit || 0,
            concurrentLimit: row.concurrent_limit || 0,
            rateLimit: row.rate_limit || 0,
            dailyCostLimit: parseFloat(row.daily_cost_limit) || 0,
            monthlyCostLimit: parseFloat(row.monthly_cost_limit) || 0,
            totalCostLimit: parseFloat(row.total_cost_limit) || 0,
            expiresInDays: row.expires_in_days || 0
        };
    }
}

/**
 * API 日志管理类
 */
export class ApiLogStore {
    constructor(database) {
        this.db = database;
    }

    static async create() {
        const database = await getDatabase();
        return new ApiLogStore(database);
    }

    async create(logData) {
        const [result] = await this.db.execute(`
            INSERT INTO api_logs (
                request_id, api_key_id, api_key_prefix, credential_id, credential_name,
                ip_address, user_agent, method, path, model, stream,
                input_tokens, output_tokens,
                status_code, error_message, duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            logData.requestId || null,
            logData.apiKeyId !== undefined ? logData.apiKeyId : null,
            logData.apiKeyPrefix !== undefined ? logData.apiKeyPrefix : null,
            logData.credentialId !== undefined ? logData.credentialId : null,
            logData.credentialName !== undefined ? logData.credentialName : null,
            logData.ipAddress !== undefined ? logData.ipAddress : null,
            logData.userAgent !== undefined ? logData.userAgent : null,
            logData.method || 'POST',
            logData.path || '/v1/messages',
            logData.model !== undefined ? logData.model : null,
            logData.stream ? 1 : 0,
            logData.inputTokens || 0,
            logData.outputTokens || 0,
            logData.statusCode || 200,
            logData.errorMessage !== undefined ? logData.errorMessage : null,
            logData.durationMs || 0
        ]);
        return result.insertId;
    }

    async getAll(options = {}) {
        const { page = 1, pageSize = 100, apiKeyId, ipAddress, startDate, endDate } = options;
        const limit = parseInt(pageSize) || 100;
        const offset = ((parseInt(page) || 1) - 1) * limit;

        let query = 'SELECT * FROM api_logs WHERE 1=1';
        const params = [];

        if (apiKeyId) {
            query += ' AND api_key_id = ?';
            params.push(apiKeyId);
        }
        if (ipAddress) {
            query += ' AND ip_address = ?';
            params.push(ipAddress);
        }
        if (startDate) {
            query += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND created_at <= ?';
            params.push(endDate);
        }

        // 获取总数
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [countRows] = await this.db.execute(countQuery, params);
        const total = Number(countRows[0].total) || 0;

        query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
        const [rows] = await this.db.execute(query, params);

        return {
            logs: rows.map(row => this._mapRow(row)),
            total,
            page: parseInt(page) || 1,
            pageSize: limit,
            totalPages: Math.ceil(total / limit)
        };
    }

    async getByApiKeyId(apiKeyId, limit = 100) {
        const [rows] = await this.db.execute(
            `SELECT * FROM api_logs WHERE api_key_id = ? ORDER BY created_at DESC LIMIT ${parseInt(limit)}`,
            [apiKeyId]
        );
        return rows.map(row => this._mapRow(row));
    }

    async getStats(apiKeyId = null, startDate = null, endDate = null) {
        let query = `
            SELECT
                COUNT(*) as total_requests,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                AVG(duration_ms) as avg_duration_ms
            FROM api_logs
            WHERE 1=1
        `;
        const params = [];

        if (apiKeyId) {
            query += ' AND api_key_id = ?';
            params.push(apiKeyId);
        }
        if (startDate) {
            query += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND created_at <= ?';
            params.push(endDate);
        }

        const [rows] = await this.db.execute(query, params);
        return rows[0];
    }

    _mapRow(row) {
        return {
            id: row.id,
            requestId: row.request_id,
            apiKeyId: row.api_key_id,
            apiKeyPrefix: row.api_key_prefix,
            credentialId: row.credential_id,
            credentialName: row.credential_name,
            ipAddress: row.ip_address,
            userAgent: row.user_agent,
            method: row.method,
            path: row.path,
            model: row.model,
            stream: row.stream === 1,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            requestMessages: row.request_messages,
            responseContent: row.response_content,
            statusCode: row.status_code,
            errorMessage: row.error_message,
            durationMs: row.duration_ms,
            createdAt: row.created_at
        };
    }

    async getStatsForApiKey(apiKeyId, options = {}) {
        const { startDate, endDate } = options;
        let query = `
            SELECT
                COUNT(*) as requestCount,
                COALESCE(SUM(input_tokens), 0) as inputTokens,
                COALESCE(SUM(output_tokens), 0) as outputTokens,
                COALESCE(AVG(duration_ms), 0) as avgDurationMs
            FROM api_logs
            WHERE api_key_id = ?
        `;
        const params = [apiKeyId];

        if (startDate) {
            query += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND created_at <= ?';
            params.push(endDate);
        }

        const [rows] = await this.db.execute(query, params);
        return {
            requestCount: Number(rows[0].requestCount) || 0,
            inputTokens: Number(rows[0].inputTokens) || 0,
            outputTokens: Number(rows[0].outputTokens) || 0,
            avgDurationMs: Number(rows[0].avgDurationMs) || 0
        };
    }

    async getStatsByModel(apiKeyId, options = {}) {
        const { startDate, endDate } = options;
        let query = `
            SELECT
                model,
                COUNT(*) as requestCount,
                COALESCE(SUM(input_tokens), 0) as inputTokens,
                COALESCE(SUM(output_tokens), 0) as outputTokens
            FROM api_logs
            WHERE api_key_id = ?
        `;
        const params = [apiKeyId];

        if (startDate) {
            query += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND created_at <= ?';
            params.push(endDate);
        }

        query += ' GROUP BY model';

        const [rows] = await this.db.execute(query, params);
        return rows.map(row => ({
            model: row.model,
            requestCount: Number(row.requestCount) || 0,
            inputTokens: Number(row.inputTokens) || 0,
            outputTokens: Number(row.outputTokens) || 0
        }));
    }

    async getAllStatsByModel(options = {}) {
        const { startDate, endDate } = options;
        let query = `
            SELECT
                model,
                COUNT(*) as requestCount,
                COALESCE(SUM(input_tokens), 0) as inputTokens,
                COALESCE(SUM(output_tokens), 0) as outputTokens
            FROM api_logs
            WHERE 1=1
        `;
        const params = [];

        if (startDate) {
            query += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND created_at <= ?';
            params.push(endDate);
        }

        query += ' GROUP BY model';

        const [rows] = await this.db.execute(query, params);
        return rows.map(row => ({
            model: row.model,
            requestCount: Number(row.requestCount) || 0,
            inputTokens: Number(row.inputTokens) || 0,
            outputTokens: Number(row.outputTokens) || 0
        }));
    }

    async getStatsByApiKey(options = {}) {
        const { startDate, endDate } = options;
        let query = `
            SELECT
                al.api_key_id,
                ak.name as apiKeyName,
                ak.key_prefix as apiKeyPrefix,
                COUNT(*) as requestCount,
                COALESCE(SUM(al.input_tokens), 0) as inputTokens,
                COALESCE(SUM(al.output_tokens), 0) as outputTokens
            FROM api_logs al
            LEFT JOIN api_keys ak ON al.api_key_id = ak.id
            WHERE al.api_key_id IS NOT NULL
        `;
        const params = [];

        if (startDate) {
            query += ' AND al.created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND al.created_at <= ?';
            params.push(endDate);
        }

        query += ' GROUP BY al.api_key_id, ak.name, ak.key_prefix ORDER BY requestCount DESC';

        const [rows] = await this.db.execute(query, params);
        return rows.map(row => ({
            apiKeyId: row.api_key_id,
            apiKeyName: row.apiKeyName || '未知',
            apiKeyPrefix: row.apiKeyPrefix || '',
            requestCount: Number(row.requestCount) || 0,
            inputTokens: Number(row.inputTokens) || 0,
            outputTokens: Number(row.outputTokens) || 0
        }));
    }

    async getErrorLogs(options = {}) {
        const { limit = 100, offset = 0, startDate, endDate } = options;
        let query = `
            SELECT * FROM api_logs
            WHERE status_code >= 400
        `;
        const params = [];

        if (startDate) {
            query += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND created_at <= ?';
            params.push(endDate);
        }

        query += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;

        const [rows] = await this.db.execute(query, params);
        return {
            logs: rows.map(row => this._mapRow(row)),
            total: rows.length
        };
    }

    async getByRequestId(requestId) {
        const [rows] = await this.db.execute(
            'SELECT * FROM api_logs WHERE request_id = ?',
            [requestId]
        );
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async update(requestId, data) {
        const fields = [];
        const params = [];

        if (data.outputTokens !== undefined) {
            fields.push('output_tokens = ?');
            params.push(data.outputTokens);
        }
        if (data.statusCode !== undefined) {
            fields.push('status_code = ?');
            params.push(data.statusCode);
        }
        if (data.errorMessage !== undefined) {
            fields.push('error_message = ?');
            params.push(data.errorMessage);
        }
        if (data.durationMs !== undefined) {
            fields.push('duration_ms = ?');
            params.push(data.durationMs);
        }

        if (fields.length === 0) return;

        params.push(requestId);
        await this.db.execute(
            `UPDATE api_logs SET ${fields.join(', ')} WHERE request_id = ?`,
            params
        );
    }

    async delete(id) {
        await this.db.execute('DELETE FROM api_logs WHERE id = ?', [id]);
    }

    async cleanOldLogs(daysToKeep) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
        await this.db.execute(
            'DELETE FROM api_logs WHERE created_at < ?',
            [cutoffDate.toISOString()]
        );
    }

    async getStatsByIp(options = {}) {
        const { startDate, endDate, limit = 100 } = options;
        let query = `
            SELECT
                ip_address as ipAddress,
                COUNT(*) as requestCount,
                COALESCE(SUM(input_tokens), 0) as inputTokens,
                COALESCE(SUM(output_tokens), 0) as outputTokens
            FROM api_logs
            WHERE 1=1
        `;
        const params = [];

        if (startDate) {
            query += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND created_at <= ?';
            params.push(endDate);
        }

        query += ` GROUP BY ip_address ORDER BY requestCount DESC LIMIT ${parseInt(limit)}`;

        const [rows] = await this.db.execute(query, params);
        return rows.map(row => ({
            ipAddress: row.ipAddress,
            requestCount: Number(row.requestCount) || 0,
            inputTokens: Number(row.inputTokens) || 0,
            outputTokens: Number(row.outputTokens) || 0
        }));
  }

    async getStatsByApiKey(options = {}) {
        const { startDate, endDate } = options;
        let query = `
            SELECT
                al.api_key_id as apiKeyId,
                al.api_key_prefix as apiKeyPrefix,
                ak.name as apiKeyName,
                COUNT(*) as requestCount,
                COALESCE(SUM(al.input_tokens), 0) as inputTokens,
                COALESCE(SUM(al.output_tokens), 0) as outputTokens
            FROM api_logs al
            LEFT JOIN api_keys ak ON al.api_key_id = ak.id
            WHERE 1=1
        `;
        const params = [];

        if (startDate) {
            query += ' AND al.created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND al.created_at <= ?';
            params.push(endDate);
        }

        query += ' GROUP BY al.api_key_id, al.api_key_prefix, ak.name';

        const [rows] = await this.db.execute(query, params);
        return rows.map(row => ({
            apiKeyId: row.apiKeyId,
            apiKeyPrefix: row.apiKeyPrefix,
            apiKeyName: row.apiKeyName,
            requestCount: Number(row.requestCount) || 0,
            inputTokens: Number(row.inputTokens) || 0,
            outputTokens: Number(row.outputTokens) || 0
        }));
    }

    async getCostByApiKey(options = {}) {
        const { startDate, endDate } = options;
        let query = `
            SELECT
                al.api_key_id as apiKeyId,
                al.api_key_prefix as apiKeyPrefix,
                ak.name as apiKeyName,
                COUNT(*) as requestCount,
                COALESCE(SUM(al.input_tokens), 0) as inputTokens,
                COALESCE(SUM(al.output_tokens), 0) as outputTokens
            FROM api_logs al
            LEFT JOIN api_keys ak ON al.api_key_id = ak.id
            WHERE al.api_key_id IS NOT NULL
        `;
        const params = [];

        if (startDate) {
            query += ' AND al.created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND al.created_at <= ?';
            params.push(endDate);
        }

        query += ' GROUP BY al.api_key_id, al.api_key_prefix, ak.name';

        const [rows] = await this.db.execute(query, params);
        return rows.map(row => ({
            apiKeyId: row.apiKeyId,
            apiKeyPrefix: row.apiKeyPrefix,
            apiKeyName: row.apiKeyName,
            requestCount: Number(row.requestCount) || 0,
            inputTokens: Number(row.inputTokens) || 0,
            outputTokens: Number(row.outputTokens) || 0
        }));
    }

    async getStatsByDate(options = {}) {
        const { startDate, endDate, apiKeyId } = options;
        let query = `
            SELECT
                DATE(created_at) as date,
                COUNT(*) as requestCount,
                COALESCE(SUM(input_tokens), 0) as inputTokens,
                COALESCE(SUM(output_tokens), 0) as outputTokens
            FROM api_logs
            WHERE 1=1
        `;
        const params = [];

        if (apiKeyId) {
            query += ' AND api_key_id = ?';
            params.push(apiKeyId);
        }
        if (startDate) {
            query += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND created_at <= ?';
            params.push(endDate);
        }

        query += ' GROUP BY DATE(created_at) ORDER BY date DESC';

        const [rows] = await this.db.execute(query, params);
        return rows.map(row => ({
            date: row.date,
            requestCount: Number(row.requestCount) || 0,
            inputTokens: Number(row.inputTokens) || 0,
            outputTokens: Number(row.outputTokens) || 0
        }));
    }
}

/**
 * Gemini Antigravity 凭证管理类
 */
export class GeminiCredentialStore {
    constructor(database) {
        this.db = database;
    }

    static async create() {
        const database = await getDatabase();
        return new GeminiCredentialStore(database);
    }

    async add(credential) {
        const [result] = await this.db.execute(`
            INSERT INTO gemini_credentials (name, email, access_token, refresh_token, project_id, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            credential.name,
            credential.email || null,
            credential.accessToken,
            credential.refreshToken || null,
            credential.projectId || null,
            credential.expiresAt || null
        ]);
        return result.insertId;
    }

    async update(id, credential) {
        const toNull = (val) => val === undefined ? null : val;
        await this.db.execute(`
            UPDATE gemini_credentials SET
                name = COALESCE(?, name),
                email = COALESCE(?, email),
                access_token = COALESCE(?, access_token),
                refresh_token = COALESCE(?, refresh_token),
                project_id = COALESCE(?, project_id),
                expires_at = COALESCE(?, expires_at),
                error_count = COALESCE(?, error_count),
                last_error_at = COALESCE(?, last_error_at),
                last_error_message = COALESCE(?, last_error_message)
            WHERE id = ?
        `, [
            toNull(credential.name),
            toNull(credential.email),
            toNull(credential.accessToken),
            toNull(credential.refreshToken),
            toNull(credential.projectId),
            toNull(credential.expiresAt),
            toNull(credential.errorCount),
            toNull(credential.lastErrorAt),
            toNull(credential.lastErrorMessage),
            id
        ]);
    }

    async delete(id) {
        await this.db.execute('DELETE FROM gemini_credentials WHERE id = ?', [id]);
    }

    async getById(id) {
        const [rows] = await this.db.execute('SELECT * FROM gemini_credentials WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getByName(name) {
        const [rows] = await this.db.execute('SELECT * FROM gemini_credentials WHERE name = ?', [name]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getAll() {
        const [rows] = await this.db.execute('SELECT * FROM gemini_credentials ORDER BY created_at DESC');
        return rows.map(row => this._mapRow(row));
    }

    async getActive() {
        const [rows] = await this.db.execute('SELECT * FROM gemini_credentials WHERE is_active = 1 LIMIT 1');
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getAllActive() {
        const [rows] = await this.db.execute('SELECT * FROM gemini_credentials WHERE is_active = 1 ORDER BY error_count ASC, updated_at DESC');
        return rows.map(row => this._mapRow(row));
    }

    async setActive(id) {
        await this.db.execute('UPDATE gemini_credentials SET is_active = 0');
        await this.db.execute('UPDATE gemini_credentials SET is_active = 1 WHERE id = ?', [id]);
    }

    async updateUsage(id, usageData) {
        const usageJson = JSON.stringify(usageData);
        await this.db.execute(`
            UPDATE gemini_credentials SET
                usage_data = ?,
                usage_updated_at = NOW()
            WHERE id = ?
        `, [usageJson, id]);
    }

    async incrementErrorCount(id, errorMessage) {
        await this.db.execute(`
            UPDATE gemini_credentials SET
                error_count = error_count + 1,
                last_error_at = NOW(),
                last_error_message = ?
            WHERE id = ?
        `, [errorMessage, id]);
    }

    async resetErrorCount(id) {
        await this.db.execute(`
            UPDATE gemini_credentials SET
                error_count = 0,
                last_error_at = NULL,
                last_error_message = NULL
            WHERE id = ?
        `, [id]);
    }

    _mapRow(row) {
        return {
            id: row.id,
            name: row.name,
            email: row.email,
            accessToken: row.access_token,
            refreshToken: row.refresh_token,
            projectId: row.project_id,
            expiresAt: row.expires_at,
            isActive: row.is_active === 1,
            usageData: row.usage_data ? (typeof row.usage_data === 'string' ? JSON.parse(row.usage_data) : row.usage_data) : null,
            usageUpdatedAt: row.usage_updated_at,
            errorCount: row.error_count || 0,
            lastErrorAt: row.last_error_at,
            lastErrorMessage: row.last_error_message,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    // ============ 错误凭证管理 ============

    async moveToError(id, errorMessage) {
        const credential = await this.getById(id);
        if (!credential) return null;

        const [existingError] = await this.db.execute(
            'SELECT id, error_count FROM gemini_error_credentials WHERE original_id = ?',
            [id]
        );

        if (existingError.length > 0) {
            const errorId = existingError[0].id;
            const errorCount = existingError[0].error_count + 1;
            await this.db.execute(`
                UPDATE gemini_error_credentials SET
                    error_message = ?,
                    error_count = ?,
                    last_error_at = NOW()
                WHERE id = ?
            `, [errorMessage, errorCount, errorId]);
        } else {
            await this.db.execute(`
                INSERT INTO gemini_error_credentials (
                    original_id, name, email, access_token, refresh_token,
                    project_id, expires_at, error_message, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                credential.id,
                credential.name,
                credential.email,
                credential.accessToken,
                credential.refreshToken,
                credential.projectId,
                credential.expiresAt,
                errorMessage,
                credential.createdAt
            ]);
        }

        await this.delete(id);
        return credential;
    }

    async restoreFromError(errorId, newAccessToken, newRefreshToken, newExpiresAt) {
        const [rows] = await this.db.execute('SELECT * FROM gemini_error_credentials WHERE id = ?', [errorId]);
        if (rows.length === 0) return null;

        const errorCred = this._mapErrorRow(rows[0]);

        const [result] = await this.db.execute(`
            INSERT INTO gemini_credentials (
                name, email, access_token, refresh_token, project_id, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            errorCred.name,
            errorCred.email,
            newAccessToken || errorCred.accessToken,
            newRefreshToken || errorCred.refreshToken,
            errorCred.projectId,
            newExpiresAt || errorCred.expiresAt,
            errorCred.createdAt
        ]);

        await this.db.execute('DELETE FROM gemini_error_credentials WHERE id = ?', [errorId]);
        return result.insertId;
    }

    async getAllErrors() {
        const [rows] = await this.db.execute('SELECT * FROM gemini_error_credentials ORDER BY last_error_at DESC');
        return rows.map(row => this._mapErrorRow(row));
    }

    async getErrorById(id) {
        const [rows] = await this.db.execute('SELECT * FROM gemini_error_credentials WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapErrorRow(rows[0]);
    }

    async deleteError(id) {
        await this.db.execute('DELETE FROM gemini_error_credentials WHERE id = ?', [id]);
    }

    _mapErrorRow(row) {
        return {
            id: row.id,
            originalId: row.original_id,
            name: row.name,
            email: row.email,
            accessToken: row.access_token,
            refreshToken: row.refresh_token,
            projectId: row.project_id,
            expiresAt: row.expires_at,
            errorMessage: row.error_message,
            errorCount: row.error_count,
            lastErrorAt: row.last_error_at,
            createdAt: row.created_at
        };
    }
}

/**
 * Orchids 凭证管理类
 */
export class OrchidsCredentialStore {
    constructor(database) {
        this.db = database;
    }

    static async create() {
        const database = await getDatabase();
        return new OrchidsCredentialStore(database);
    }

    async add(credential) {
        const [result] = await this.db.execute(`
            INSERT INTO orchids_credentials (name, email, client_jwt, clerk_session_id, user_id, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            credential.name,
            credential.email || null,
            credential.clientJwt,
            credential.clerkSessionId || null,
            credential.userId || null,
            credential.expiresAt || null
        ]);
        return result.insertId;
    }

    async update(id, credential) {
        const toNull = (val) => val === undefined ? null : val;
        await this.db.execute(`
            UPDATE orchids_credentials SET
                name = COALESCE(?, name),
                email = COALESCE(?, email),
                client_jwt = COALESCE(?, client_jwt),
                clerk_session_id = COALESCE(?, clerk_session_id),
                user_id = COALESCE(?, user_id),
                expires_at = COALESCE(?, expires_at),
                error_count = COALESCE(?, error_count),
                last_error_at = COALESCE(?, last_error_at),
                last_error_message = COALESCE(?, last_error_message)
            WHERE id = ?
        `, [
            toNull(credential.name),
            toNull(credential.email),
            toNull(credential.clientJwt),
            toNull(credential.clerkSessionId),
            toNull(credential.userId),
            toNull(credential.expiresAt),
            toNull(credential.errorCount),
            toNull(credential.lastErrorAt),
            toNull(credential.lastErrorMessage),
            id
        ]);
    }

    async delete(id) {
        await this.db.execute('DELETE FROM orchids_credentials WHERE id = ?', [id]);
    }

    async getById(id) {
        const [rows] = await this.db.execute('SELECT * FROM orchids_credentials WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getByName(name) {
        const [rows] = await this.db.execute('SELECT * FROM orchids_credentials WHERE name = ?', [name]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getAll() {
        const [rows] = await this.db.execute('SELECT * FROM orchids_credentials ORDER BY created_at DESC');
        return rows.map(row => this._mapRow(row));
    }

    async getActive() {
        const [rows] = await this.db.execute('SELECT * FROM orchids_credentials WHERE is_active = 1 LIMIT 1');
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getAllActive() {
        const [rows] = await this.db.execute('SELECT * FROM orchids_credentials WHERE is_active = 1 ORDER BY error_count ASC, updated_at DESC');
        return rows.map(row => this._mapRow(row));
    }

    async setActive(id) {
        await this.db.execute('UPDATE orchids_credentials SET is_active = 0');
        await this.db.execute('UPDATE orchids_credentials SET is_active = 1 WHERE id = ?', [id]);
    }

    async updateUsage(id, usageData) {
        const usageJson = JSON.stringify(usageData);
        await this.db.execute(`
            UPDATE orchids_credentials SET
                usage_data = ?,
                usage_updated_at = NOW()
            WHERE id = ?
        `, [usageJson, id]);
    }

    async incrementErrorCount(id, errorMessage) {
        await this.db.execute(`
            UPDATE orchids_credentials SET
                error_count = error_count + 1,
                last_error_at = NOW(),
                last_error_message = ?
            WHERE id = ?
        `, [errorMessage, id]);
    }

    async resetErrorCount(id) {
        await this.db.execute(`
            UPDATE orchids_credentials SET
                error_count = 0,
                last_error_at = NULL,
                last_error_message = NULL
            WHERE id = ?
        `, [id]);
    }

    _mapRow(row) {
        return {
            id: row.id,
            name: row.name,
            email: row.email,
            clientJwt: row.client_jwt,
            clerkSessionId: row.clerk_session_id,
            userId: row.user_id,
            expiresAt: row.expires_at,
            isActive: row.is_active === 1,
            usageData: row.usage_data ? (typeof row.usage_data === 'string' ? JSON.parse(row.usage_data) : row.usage_data) : null,
            usageUpdatedAt: row.usage_updated_at,
            errorCount: row.error_count || 0,
            lastErrorAt: row.last_error_at,
            lastErrorMessage: row.last_error_message,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    // ============ 错误凭证管理 ============

    async moveToError(id, errorMessage) {
        const credential = await this.getById(id);
        if (!credential) return null;

        const [existingError] = await this.db.execute(
            'SELECT id, error_count FROM orchids_error_credentials WHERE original_id = ?',
            [id]
        );

        if (existingError.length > 0) {
            const errorId = existingError[0].id;
            const errorCount = existingError[0].error_count + 1;
            await this.db.execute(`
                UPDATE orchids_error_credentials SET
                    error_message = ?,
                    error_count = ?,
                    last_error_at = NOW()
                WHERE id = ?
            `, [errorMessage, errorCount, errorId]);
        } else {
            await this.db.execute(`
                INSERT INTO orchids_error_credentials (
                    original_id, name, email, client_jwt, clerk_session_id,
                    user_id, expires_at, error_message, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                credential.id,
                credential.name,
                credential.email,
                credential.clientJwt,
                credential.clerkSessionId,
                credential.userId,
                credential.expiresAt,
                errorMessage,
                credential.createdAt
            ]);
        }

        await this.delete(id);
        return credential;
    }

    async restoreFromError(errorId, newClientJwt, newExpiresAt) {
        const [rows] = await this.db.execute('SELECT * FROM orchids_error_credentials WHERE id = ?', [errorId]);
        if (rows.length === 0) return null;

        const errorCred = this._mapErrorRow(rows[0]);

        const [result] = await this.db.execute(`
            INSERT INTO orchids_credentials (
                name, email, client_jwt, clerk_session_id, user_id, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            errorCred.name,
            errorCred.email,
            newClientJwt || errorCred.clientJwt,
            errorCred.clerkSessionId,
            errorCred.userId,
            newExpiresAt || errorCred.expiresAt,
            errorCred.createdAt
        ]);

        await this.db.execute('DELETE FROM orchids_error_credentials WHERE id = ?', [errorId]);
        return result.insertId;
    }

    async getAllErrors() {
        const [rows] = await this.db.execute('SELECT * FROM orchids_error_credentials ORDER BY last_error_at DESC');
        return rows.map(row => this._mapErrorRow(row));
    }

    async getErrorById(id) {
        const [rows] = await this.db.execute('SELECT * FROM orchids_error_credentials WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapErrorRow(rows[0]);
    }

    async deleteError(id) {
        await this.db.execute('DELETE FROM orchids_error_credentials WHERE id = ?', [id]);
    }

    _mapErrorRow(row) {
        return {
            id: row.id,
            originalId: row.original_id,
            name: row.name,
            email: row.email,
            clientJwt: row.client_jwt,
            clerkSessionId: row.clerk_session_id,
            userId: row.user_id,
            expiresAt: row.expires_at,
            errorMessage: row.error_message,
            errorCount: row.error_count,
            lastErrorAt: row.last_error_at,
            createdAt: row.created_at
        };
    }
}

/**
 * Warp 凭证管理类
 */
export class WarpCredentialStore {
    constructor(database) {
        this.db = database;
    }

    static async create() {
        const database = await getDatabase();
        return new WarpCredentialStore(database);
    }

    async add(credential) {
        const [result] = await this.db.execute(`
            INSERT INTO warp_credentials (name, email, refresh_token, access_token, token_expires_at)
            VALUES (?, ?, ?, ?, ?)
        `, [
            credential.name,
            credential.email || null,
            credential.refreshToken,
            credential.accessToken || null,
            credential.tokenExpiresAt || null
        ]);
        return result.insertId;
    }

    async addBatch(credentials) {
        const results = [];
        for (const cred of credentials) {
            try {
                const id = await this.add(cred);
                results.push({ success: true, id, name: cred.name });
            } catch (e) {
                results.push({ success: false, name: cred.name, error: e.message });
            }
        }
        return results;
    }

    async update(id, credential) {
        const fields = [];
        const values = [];

        if (credential.name !== undefined) { fields.push('name = ?'); values.push(credential.name); }
        if (credential.email !== undefined) { fields.push('email = ?'); values.push(credential.email); }
        if (credential.refreshToken !== undefined) { fields.push('refresh_token = ?'); values.push(credential.refreshToken); }
        if (credential.accessToken !== undefined) { fields.push('access_token = ?'); values.push(credential.accessToken); }
        if (credential.tokenExpiresAt !== undefined) { fields.push('token_expires_at = ?'); values.push(credential.tokenExpiresAt); }
        if (credential.isActive !== undefined) { fields.push('is_active = ?'); values.push(credential.isActive ? 1 : 0); }

        if (fields.length === 0) return;

        values.push(id);
        await this.db.execute(`UPDATE warp_credentials SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    async updateToken(id, accessToken, expiresAt) {
        await this.db.execute(`
            UPDATE warp_credentials SET
                access_token = ?,
                token_expires_at = ?,
                error_count = 0,
                last_error_at = NULL,
                last_error_message = NULL
            WHERE id = ?
        `, [accessToken, expiresAt, id]);
    }

    async incrementUseCount(id) {
        await this.db.execute(`
            UPDATE warp_credentials SET
                use_count = use_count + 1,
                last_used_at = NOW()
            WHERE id = ?
        `, [id]);
    }

    async incrementErrorCount(id, errorMessage) {
        await this.db.execute(`
            UPDATE warp_credentials SET
                error_count = error_count + 1,
                last_error_at = NOW(),
                last_error_message = ?
            WHERE id = ?
        `, [errorMessage, id]);
    }

    async delete(id) {
        await this.db.execute('DELETE FROM warp_credentials WHERE id = ?', [id]);
    }

    async getById(id) {
        const [rows] = await this.db.execute('SELECT * FROM warp_credentials WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getByName(name) {
        const [rows] = await this.db.execute('SELECT * FROM warp_credentials WHERE name = ?', [name]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getAll() {
        const [rows] = await this.db.execute('SELECT * FROM warp_credentials ORDER BY created_at DESC');
        return rows.map(row => this._mapRow(row));
    }

    async getAllActive() {
        const [rows] = await this.db.execute('SELECT * FROM warp_credentials WHERE is_active = 1 ORDER BY use_count ASC, last_used_at ASC');
        return rows.map(row => this._mapRow(row));
    }

    async getRandomActive() {
        // 获取使用次数最少的活跃账号
        const [rows] = await this.db.execute(`
            SELECT * FROM warp_credentials 
            WHERE is_active = 1 AND error_count < 3
            ORDER BY use_count ASC, RAND()
            LIMIT 1
        `);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getRandomActiveExcluding(excludeIds = []) {
        // 获取使用次数最少的活跃账号，排除指定 ID
        let query = `
            SELECT * FROM warp_credentials 
            WHERE is_active = 1 AND error_count < 3
        `;
        
        if (excludeIds.length > 0) {
            const placeholders = excludeIds.map(() => '?').join(',');
            query += ` AND id NOT IN (${placeholders})`;
        }
        
        query += ` ORDER BY use_count ASC, RAND() LIMIT 1`;
        
        const [rows] = await this.db.execute(query, excludeIds);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async markQuotaExhausted(id) {
        // 标记账号额度耗尽（增加错误计数到阈值）
        await this.db.execute(
            'UPDATE warp_credentials SET error_count = 3, last_error_message = ?, last_error_at = NOW() WHERE id = ?',
            ['额度耗尽', id]
        );
    }

    async getCount() {
        const [rows] = await this.db.execute('SELECT COUNT(*) as count FROM warp_credentials');
        return rows[0].count;
    }

    async getActiveCount() {
        const [rows] = await this.db.execute('SELECT COUNT(*) as count FROM warp_credentials WHERE is_active = 1');
        return rows[0].count;
    }

    async getStatistics() {
        const [total] = await this.db.execute('SELECT COUNT(*) as count FROM warp_credentials');
        const [active] = await this.db.execute('SELECT COUNT(*) as count FROM warp_credentials WHERE is_active = 1');
        const [healthy] = await this.db.execute('SELECT COUNT(*) as count FROM warp_credentials WHERE is_active = 1 AND error_count < 3');
        const [errors] = await this.db.execute('SELECT COUNT(*) as count FROM warp_error_credentials');
        const [totalUse] = await this.db.execute('SELECT SUM(use_count) as total FROM warp_credentials');

        return {
            total: total[0].count,
            active: active[0].count,
            healthy: healthy[0].count,
            errors: errors[0].count,
            totalUseCount: totalUse[0].total || 0
        };
    }

    _mapRow(row) {
        return {
            id: row.id,
            name: row.name,
            email: row.email,
            refreshToken: row.refresh_token,
            accessToken: row.access_token,
            tokenExpiresAt: row.token_expires_at,
            isActive: row.is_active === 1,
            useCount: row.use_count || 0,
            lastUsedAt: row.last_used_at,
            errorCount: row.error_count || 0,
            lastErrorAt: row.last_error_at,
            lastErrorMessage: row.last_error_message,
            quotaLimit: row.quota_limit || 0,
            quotaUsed: row.quota_used || 0,
            quotaUpdatedAt: row.quota_updated_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    async updateQuota(id, quotaLimit, quotaUsed) {
        await this.db.execute(
            'UPDATE warp_credentials SET quota_limit = ?, quota_used = ?, quota_updated_at = NOW() WHERE id = ?',
            [quotaLimit, quotaUsed, id]
        );
    }

    // ============ 错误凭证管理 ============

    async moveToError(id, errorMessage) {
        const credential = await this.getById(id);
        if (!credential) return null;

        const [existingError] = await this.db.execute(
            'SELECT id, error_count FROM warp_error_credentials WHERE original_id = ?',
            [id]
        );

        if (existingError.length > 0) {
            const errorId = existingError[0].id;
            const errorCount = existingError[0].error_count + 1;
            await this.db.execute(`
                UPDATE warp_error_credentials SET
                    error_message = ?,
                    error_count = ?,
                    last_error_at = NOW()
                WHERE id = ?
            `, [errorMessage, errorCount, errorId]);
        } else {
            await this.db.execute(`
                INSERT INTO warp_error_credentials (
                    original_id, name, email, refresh_token, access_token, error_message, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                credential.id,
                credential.name,
                credential.email,
                credential.refreshToken,
                credential.accessToken,
                errorMessage,
                credential.createdAt
            ]);
        }

        await this.delete(id);
        return credential;
    }

    async restoreFromError(errorId, newRefreshToken) {
        const [rows] = await this.db.execute('SELECT * FROM warp_error_credentials WHERE id = ?', [errorId]);
        if (rows.length === 0) return null;

        const errorCred = this._mapErrorRow(rows[0]);

        const [result] = await this.db.execute(`
            INSERT INTO warp_credentials (name, email, refresh_token, created_at)
            VALUES (?, ?, ?, ?)
        `, [
            errorCred.name,
            errorCred.email,
            newRefreshToken || errorCred.refreshToken,
            errorCred.createdAt
        ]);

        await this.db.execute('DELETE FROM warp_error_credentials WHERE id = ?', [errorId]);
        return result.insertId;
    }

    async getAllErrors() {
        const [rows] = await this.db.execute('SELECT * FROM warp_error_credentials ORDER BY last_error_at DESC');
        return rows.map(row => this._mapErrorRow(row));
    }

    async deleteError(id) {
        await this.db.execute('DELETE FROM warp_error_credentials WHERE id = ?', [id]);
    }

    _mapErrorRow(row) {
        return {
            id: row.id,
            originalId: row.original_id,
            name: row.name,
            email: row.email,
            refreshToken: row.refresh_token,
            accessToken: row.access_token,
            errorMessage: row.error_message,
            errorCount: row.error_count,
            lastErrorAt: row.last_error_at,
            createdAt: row.created_at
        };
    }
}

/**
 * Warp 请求统计存储
 */
export class WarpRequestStatsStore {
    constructor(db) {
        this.db = db;
    }

    async record(stats) {
        const {
            credentialId,
            apiKeyId = null,
            endpoint,
            model,
            isStream = false,
            inputTokens = 0,
            outputTokens = 0,
            totalTokens = 0,
            durationMs = 0,
            status = 'success',
            errorMessage = null
        } = stats;

        await this.db.execute(`
            INSERT INTO warp_request_stats (
                credential_id, api_key_id, endpoint, model, is_stream,
                input_tokens, output_tokens, total_tokens, duration_ms,
                status, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            credentialId, apiKeyId, endpoint, model, isStream ? 1 : 0,
            inputTokens, outputTokens, totalTokens, durationMs,
            status, errorMessage
        ]);
    }

    async getStats(options = {}) {
        const { credentialId, apiKeyId, model, startDate, endDate, limit = 100 } = options;
        
        let sql = 'SELECT * FROM warp_request_stats WHERE 1=1';
        const params = [];

        if (credentialId) {
            sql += ' AND credential_id = ?';
            params.push(credentialId);
        }
        if (apiKeyId) {
            sql += ' AND api_key_id = ?';
            params.push(apiKeyId);
        }
        if (model) {
            sql += ' AND model = ?';
            params.push(model);
        }
        if (startDate) {
            sql += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            sql += ' AND created_at <= ?';
            params.push(endDate);
        }

        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const [rows] = await this.db.execute(sql, params);
        return rows.map(row => this._mapRow(row));
    }

    async getSummary(options = {}) {
        const { credentialId, apiKeyId, startDate, endDate } = options;
        
        let sql = `
            SELECT 
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(total_tokens) as total_tokens,
                AVG(duration_ms) as avg_duration_ms,
                model
            FROM warp_request_stats WHERE 1=1
        `;
        const params = [];

        if (credentialId) {
            sql += ' AND credential_id = ?';
            params.push(credentialId);
        }
        if (apiKeyId) {
            sql += ' AND api_key_id = ?';
            params.push(apiKeyId);
        }
        if (startDate) {
            sql += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            sql += ' AND created_at <= ?';
            params.push(endDate);
        }

        sql += ' GROUP BY model';

        const [rows] = await this.db.execute(sql, params);
        return rows;
    }

    async getTotalSummary(options = {}) {
        const { startDate, endDate } = options;
        
        let sql = `
            SELECT 
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(total_tokens) as total_tokens,
                AVG(duration_ms) as avg_duration_ms
            FROM warp_request_stats WHERE 1=1
        `;
        const params = [];

        if (startDate) {
            sql += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            sql += ' AND created_at <= ?';
            params.push(endDate);
        }

        const [rows] = await this.db.execute(sql, params);
        return rows[0];
    }

    async getCredentialSummary(options = {}) {
        const { startDate, endDate } = options;
        
        let sql = `
            SELECT 
                credential_id,
                COUNT(*) as total_requests,
                SUM(total_tokens) as total_tokens
            FROM warp_request_stats WHERE 1=1
        `;
        const params = [];

        if (startDate) {
            sql += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            sql += ' AND created_at <= ?';
            params.push(endDate);
        }

        sql += ' GROUP BY credential_id ORDER BY total_requests DESC';

        const [rows] = await this.db.execute(sql, params);
        return rows;
    }

    _mapRow(row) {
        return {
            id: row.id,
            credentialId: row.credential_id,
            apiKeyId: row.api_key_id,
            endpoint: row.endpoint,
            model: row.model,
            isStream: row.is_stream === 1,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            totalTokens: row.total_tokens,
            durationMs: row.duration_ms,
            status: row.status,
            errorMessage: row.error_message,
            createdAt: row.created_at
        };
    }
}

/**
 * 试用申请管理类
 */
export class TrialApplicationStore {
    constructor(database) {
        this.db = database;
    }

    static async create() {
        const database = await getDatabase();
        return new TrialApplicationStore(database);
    }

    async add(application) {
        const [result] = await this.db.execute(`
            INSERT INTO trial_applications (xianyu_name, order_screenshot, source, email)
            VALUES (?, ?, ?, ?)
        `, [
            application.xianyuName,
            application.orderScreenshot || null,
            application.source || null,
            application.email
        ]);
        return result.insertId;
    }

    async getById(id) {
        const [rows] = await this.db.execute('SELECT * FROM trial_applications WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getByEmail(email) {
        const [rows] = await this.db.execute(
            'SELECT * FROM trial_applications WHERE email = ? ORDER BY created_at DESC',
            [email]
        );
        return rows.map(row => this._mapRow(row));
    }

    async getLatestByEmail(email) {
        const [rows] = await this.db.execute(
            'SELECT * FROM trial_applications WHERE email = ? ORDER BY created_at DESC LIMIT 1',
            [email]
        );
        if (rows.length === 0) return null;
        return this._mapRow(rows[0]);
    }

    async getAll(options = {}) {
        const { status, page = 1, pageSize = 50 } = options;
        const limit = parseInt(pageSize) || 50;
        const offset = ((parseInt(page) || 1) - 1) * limit;

        let query = 'SELECT * FROM trial_applications WHERE 1=1';
        const params = [];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }

        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [countRows] = await this.db.execute(countQuery, params);
        const total = Number(countRows[0].total) || 0;

        query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
        const [rows] = await this.db.execute(query, params);

        return {
            applications: rows.map(row => this._mapRow(row)),
            total,
            page: parseInt(page) || 1,
            pageSize: limit,
            totalPages: Math.ceil(total / limit)
        };
    }

    async approve(id, reviewedBy, apiKey, expiresAt, costLimit = 50) {
        await this.db.execute(`
            UPDATE trial_applications SET
                status = 'approved',
                api_key = ?,
                api_key_expires_at = ?,
                cost_limit = ?,
                reviewed_by = ?,
                reviewed_at = NOW()
            WHERE id = ?
        `, [apiKey, expiresAt, costLimit, reviewedBy, id]);
    }

    async reject(id, reviewedBy, reason = null) {
        await this.db.execute(`
            UPDATE trial_applications SET
                status = 'rejected',
                reject_reason = ?,
                reviewed_by = ?,
                reviewed_at = NOW()
            WHERE id = ?
        `, [reason, reviewedBy, id]);
    }

    async delete(id) {
        await this.db.execute('DELETE FROM trial_applications WHERE id = ?', [id]);
    }

    async getStats() {
        const [rows] = await this.db.execute(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
            FROM trial_applications
        `);
        return {
            total: Number(rows[0].total) || 0,
            pending: Number(rows[0].pending) || 0,
            approved: Number(rows[0].approved) || 0,
            rejected: Number(rows[0].rejected) || 0
        };
    }

    _mapRow(row) {
        return {
            id: row.id,
            xianyuName: row.xianyu_name,
            orderScreenshot: row.order_screenshot,
            source: row.source,
            email: row.email,
            status: row.status,
            apiKey: row.api_key,
            apiKeyExpiresAt: row.api_key_expires_at,
            costLimit: parseFloat(row.cost_limit) || 50,
            rejectReason: row.reject_reason,
            reviewedBy: row.reviewed_by,
            reviewedAt: row.reviewed_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

/**
 * 站点设置管理类
 */
export class SiteSettingsStore {
    constructor(database) {
        this.db = database;
    }

    static async create() {
        const database = await getDatabase();
        return new SiteSettingsStore(database);
    }

    async get() {
        const [rows] = await this.db.execute('SELECT * FROM site_settings WHERE id = 1');
        if (rows.length === 0) {
            return {
                siteName: 'Kiro',
                siteLogo: 'K',
                siteSubtitle: 'Account Manager'
            };
        }
        return this._mapRow(rows[0]);
    }

    async update(settings) {
        await this.db.execute(`
            INSERT INTO site_settings (id, site_name, site_logo, site_subtitle)
            VALUES (1, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                site_name = VALUES(site_name),
                site_logo = VALUES(site_logo),
                site_subtitle = VALUES(site_subtitle)
        `, [
            settings.siteName || 'Kiro',
            settings.siteLogo || 'K',
            settings.siteSubtitle || 'Account Manager'
        ]);
        return this.get();
    }

    _mapRow(row) {
        return {
            siteName: row.site_name,
            siteLogo: row.site_logo,
            siteSubtitle: row.site_subtitle,
            updatedAt: row.updated_at
        };
    }
}
