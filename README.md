# Kiro API Client

通过 AWS CodeWhisperer/Kiro API 和 Google Antigravity API 访问 Claude/Gemini 模型的 Node.js 客户端。支持多种 OAuth 认证方式和 Web 管理界面。

## 功能特性

- 支持多种 Claude 模型（Opus 4.5、Sonnet 4/4.5、Haiku 4.5 等）
- 支持 Gemini 模型（Gemini 3 Pro/Flash、Gemini 2.5 等）
- 多种认证方式：Google、GitHub、AWS Builder ID、AWS IAM Identity Center
- Gemini Antigravity OAuth 认证
- 流式和非流式对话支持
- Web 管理界面，支持凭据管理和在线聊天
- 自动 Token 刷新机制
- 批量导入账号功能
- 使用量查询和费用统计
- HTTP/HTTPS 代理支持

## 安装

```bash
npm install
```

## 快速开始

### 启动 Web 管理界面

```bash
npm run server
```

访问 http://localhost:3000 打开管理界面。密码是admin admin123

### Index Page
![Index Page](https://github.com/CaiGaoQing/kiro-api-client/blob/main/index.png?raw=true)

### Index Page 2
![Index Page 2](https://github.com/CaiGaoQing/kiro-api-client/blob/main/index2.png?raw=true)

### OAuth Authentication
![OAuth Authentication](https://github.com/CaiGaoQing/kiro-api-client/blob/main/oauth.png?raw=true)

### API Interface
![API Interface](https://github.com/CaiGaoQing/kiro-api-client/blob/main/api.png?raw=true)

### Chat Interface
![Chat Interface](https://github.com/CaiGaoQing/kiro-api-client/blob/main/chat.png?raw=true)

### Usage Statistics
![Usage Statistics](https://github.com/CaiGaoQing/kiro-api-client/blob/main/usage.png?raw=true)

### 交流群
![qr](https://github.com/CaiGaoQing/kiro-api-client/blob/main/qr.jpg?raw=true)

### 打赏一下
![qr](https://github.com/CaiGaoQing/kiro-api-client/blob/main/cof.jpg?raw=true)
### 运行测试

```bash
npm test
```

## 支持的模型

| 模型名称 | 内部映射名称 |
|---------|-------------|
| `claude-opus-4-5-20251101` | `claude-opus-4.5` |
| `claude-sonnet-4-20250514` | `CLAUDE_SONNET_4_20250514_V1_0` |
| `claude-sonnet-4-5-20250929` | `CLAUDE_SONNET_4_5_20250929_V1_0` |
| `claude-3-7-sonnet-20250219` | `CLAUDE_3_7_SONNET_20250219_V1_0` |
| `claude-haiku-4-5` | `claude-haiku-4.5` |

### Gemini 模型 (Antigravity)

| 模型名称 | 内部映射名称 |
|---------|-------------|
| `gemini-3-pro-preview` | `gemini-3-pro-high` |
| `gemini-3-pro-image-preview` | `gemini-3-pro-image` |
| `gemini-3-flash-preview` | `gemini-3-flash` |
| `gemini-2.5-flash-preview` | `gemini-2.5-flash` |
| `gemini-2.5-computer-use-preview-10-2025` | `rev19-uic3-1p` |
| `gemini-claude-sonnet-4-5` | `claude-sonnet-4-5` |
| `gemini-claude-sonnet-4-5-thinking` | `claude-sonnet-4-5-thinking` |
| `gemini-claude-opus-4-5-thinking` | `claude-opus-4-5-thinking` |

## 认证方式

### 1. Social Auth (Google/GitHub)

使用 PKCE 流程，通过本地 HTTP 回调服务器（端口 19876-19880）完成认证。

```bash
node src/auth-cli.js
```

### 2. Builder ID

使用 Device Code Flow，通过 OIDC 轮询完成认证。

### 3. IAM Identity Center (IdC)

使用 `client_id` 和 `client_secret` 进行认证。

### 4. Gemini Antigravity OAuth

通过 Google OAuth 2.0 认证访问 Gemini Antigravity API。

**Web 界面认证流程：**

1. 访问 Web 管理界面 http://localhost:3000
2. 进入「Gemini 账号」页面
3. 点击「添加账号」->「OAuth 登录」
4. 在弹出的 Google 登录页面完成授权
5. 授权成功后自动保存凭据

**OAuth 配置信息：**

| 配置项 | 值 |
|-------|-----|
| Client ID | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` |
| Scope | `https://www.googleapis.com/auth/cloud-platform` |
| 回调端口 | `8086` |
| Token 端点 | `https://oauth2.googleapis.com/token` |

**Token 刷新：**

```bash
curl -X POST 'https://oauth2.googleapis.com/token' \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    "client_secret": "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",
    "refresh_token": "YOUR_REFRESH_TOKEN",
    "grant_type": "refresh_token"
  }'
```

## 代理设置

系统支持 HTTP/HTTPS 代理，用于在网络受限环境下访问 API。

### 通过 Web 界面配置

1. 访问 Web 管理界面 http://localhost:3000
2. 进入「代理设置」页面
3. 输入代理地址并启用

### 支持的代理格式

```
# 标准 URL 格式
http://host:port
http://username:password@host:port

# ISP 格式（自动转换）
host:port:username:password
host:port
```

### 代理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/proxy/config` | 获取当前代理配置 |
| POST | `/api/proxy/config` | 保存代理配置 |
| POST | `/api/proxy/test` | 测试代理连接 |

**保存代理配置示例：**

```bash
curl -X POST 'http://localhost:3000/api/proxy/config' \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled": true,
    "proxyUrl": "http://127.0.0.1:7890"
  }'
```

**测试代理连接：**

```bash
curl -X POST 'http://localhost:3000/api/proxy/test' \
  -H 'Content-Type: application/json' \
  -d '{
    "proxyUrl": "http://127.0.0.1:7890"
  }'
```

### 环境变量代理

也可以通过环境变量设置代理（优先级低于数据库配置）：

```bash
export https_proxy=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890
```

## 编程接口

### 基本使用

```javascript
import { KiroClient, KiroAPI } from 'kiro-api-client';

// 方式1: 从凭据文件创建客户端
const client = await KiroClient.fromCredentialsFile();

// 方式2: 直接创建客户端
const client = new KiroClient({
    accessToken: 'your-access-token',
    refreshToken: 'your-refresh-token',
    profileArn: 'your-profile-arn',  // Social Auth 需要
    region: 'us-east-1'
});

// 发送消息（流式）
const stream = await client.chatStream([
    { role: 'user', content: '你好' }
]);

for await (const chunk of stream) {
    process.stdout.write(chunk);
}

// 发送消息（非流式）
const response = await client.chat([
    { role: 'user', content: '你好' }
]);
console.log(response);
```

### 使用 KiroAPI 类

```javascript
import { KiroAPI } from 'kiro-api-client';

// 刷新 Token
const newTokens = await KiroAPI.refreshToken({
    refreshToken: 'your-refresh-token',
    authMethod: 'social',  //'builder-id', 'IdC'
    region: 'us-east-1'
});

// 获取使用量
const usage = await KiroAPI.getUsageLimits({
    accessToken: 'your-access-token',
    region: 'us-east-1'
});

// 列出可用模型
const models = await KiroAPI.listModels({
    accessToken: 'your-access-token',
    region: 'us-east-1'
});
```

## Web API 接口

启动服务器后，可通过以下 REST API 进行操作。

### 外部 API 端点（需要 API Key 认证）

通过 `X-API-Key` 或 `Authorization: Bearer <key>` 请求头传递 API 密钥。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/v1/models` | 获取模型列表（OpenAI 格式） |
| POST | `/v1/messages` | Claude API 兼容接口（支持流式） |
| POST | `/v1/chat/completions` | OpenAI API 兼容接口（支持流式） |
| POST | `/gemini-antigravity/v1/messages` | Gemini Antigravity API（Claude 格式） |
| POST | `/v1/gemini/messages` | Gemini API（兼容旧路径） |

**Model-Provider 路由：** 可通过 `Model-Provider` 请求头指定 Provider：
- `gemini` 或 `gemini-antigravity`：路由到 Gemini Antigravity
- 默认：使用 Kiro/Claude Provider

### 认证 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/auth/status` | 检查系统是否需要初始化 |
| POST | `/api/auth/setup` | 初始化管理员账户 |
| POST | `/api/auth/login` | 用户登录 |
| POST | `/api/auth/logout` | 用户登出 |
| GET | `/api/auth/me` | 获取当前用户信息 |

### API 密钥管理（需要登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/keys` | 获取 API 密钥列表 |
| POST | `/api/keys` | 创建 API 密钥 |
| GET | `/api/keys/:id` | 获取单个密钥详情 |
| DELETE | `/api/keys/:id` | 删除 API 密钥 |
| POST | `/api/keys/:id/toggle` | 启用/禁用密钥 |
| PUT | `/api/keys/:id/limits` | 更新密钥限制配置 |
| GET | `/api/keys/:id/limits-status` | 获取密钥用量状态 |
| GET | `/api/keys/:id/usage` | 获取密钥用量统计 |
| GET | `/api/keys/:id/cost` | 获取密钥费用统计 |

### Kiro 凭据管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/credentials` | 获取所有凭据 |
| GET | `/api/credentials/:id` | 获取单个凭据（?full=true 显示完整信息） |
| DELETE | `/api/credentials/:id` | 删除凭据 |
| POST | `/api/credentials/:id/activate` | 设为活跃凭据 |
| POST | `/api/credentials/:id/refresh` | 手动刷新 Token |
| POST | `/api/credentials/:id/test` | 测试凭据有效性 |
| GET | `/api/credentials/:id/models` | 获取可用模型 |
| GET | `/api/credentials/:id/usage` | 获取使用量 |
| POST | `/api/credentials/import` | 从文件导入凭据 |
| POST | `/api/credentials/batch-import` | 批量导入 Social 账号 |

### Kiro 错误凭据管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/error-credentials` | 获取失败凭据列表 |
| DELETE | `/api/error-credentials/:id` | 删除失败凭据 |
| POST | `/api/error-credentials/:id/refresh` | 重试刷新失败凭据 |
| POST | `/api/error-credentials/:id/restore` | 手动恢复凭据（不刷新） |
| GET | `/api/error-credentials/:id/usage` | 获取用量（成功则自动恢复） |

### Kiro OAuth 登录

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/oauth/builder-id/start` | 启动 Builder ID OAuth |
| POST | `/api/oauth/social/start` | 启动 Social Auth (Google/GitHub) |
| GET | `/api/oauth/session/:sessionId` | 检查 OAuth 会话状态 |
| DELETE | `/api/oauth/session/:sessionId` | 关闭 OAuth 会话 |
| GET | `/api/oauth/configs` | 从 configs 目录加载凭据 |
| POST | `/api/oauth/configs/import` | 从 configs 导入单个凭据 |
| POST | `/api/oauth/configs/import-all` | 批量导入所有 configs 凭据 |

### Gemini 凭证管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/gemini/credentials` | 获取所有 Gemini 凭证 |
| GET | `/api/gemini/credentials/:id` | 获取单个凭证 |
| POST | `/api/gemini/credentials` | 添加凭证 |
| PUT | `/api/gemini/credentials/:id` | 更新凭证 |
| DELETE | `/api/gemini/credentials/:id` | 删除凭证 |
| POST | `/api/gemini/credentials/:id/activate` | 激活凭证 |
| POST | `/api/gemini/credentials/:id/refresh` | 刷新 Token |
| POST | `/api/gemini/credentials/:id/test` | 测试凭证 |
| GET | `/api/gemini/credentials/:id/usage` | 获取用量 |
| POST | `/api/gemini/credentials/batch-import` | 批量导入凭证 |
| POST | `/api/gemini/oauth/start` | 启动 Gemini OAuth 登录 |
| GET | `/api/gemini/models` | 获取 Gemini 模型列表 |

### Gemini 错误凭证管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/gemini/error-credentials` | 获取错误凭证列表 |
| DELETE | `/api/gemini/error-credentials/:id` | 删除错误凭证 |
| POST | `/api/gemini/error-credentials/:id/refresh` | 刷新并恢复凭证 |

### Gemini 聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/gemini/chat/:id` | SSE 流式聊天 |
| POST | `/api/gemini/chat/:id/sync` | 非流式聊天 |

### Kiro 聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat/:id` | SSE 流式聊天 |
| POST | `/api/chat/:id/sync` | 非流式聊天 |

### API 日志管理（需要管理员权限）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/logs` | 获取日志列表（分页） |
| GET | `/api/logs/:requestId` | 获取单条日志详情 |
| DELETE | `/api/logs/:id` | 删除单条日志 |
| POST | `/api/logs/cleanup` | 清理旧日志 |
| GET | `/api/error-logs` | 获取错误日志列表 |
| GET | `/api/logs-stats` | 获取日志统计信息 |
| GET | `/api/logs-stats/by-ip` | 按 IP 统计请求 |
| GET | `/api/logs-stats/by-api-key` | 按 API Key 统计 |
| GET | `/api/logs-stats/by-date` | 按日期统计（用于图表） |
| GET | `/api/logs-stats/cost` | 获取费用统计汇总 |

### 代理配置（需要登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/proxy/config` | 获取代理配置 |
| POST | `/api/proxy/config` | 保存代理配置 |
| POST | `/api/proxy/test` | 测试代理连接 |

### 公开 API（无需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/models` | 获取可用模型列表 |
| GET | `/api/usage` | 获取活跃凭据使用限额 |
| POST | `/api/public/usage` | 通过 API Key 查询用量 |

### 批量导入示例

```bash
curl -X POST 'http://localhost:3000/api/credentials/batch-import' \
  -H 'Content-Type: application/json' \
  -d '{
    "accounts": [
      {"email": "user1@example.com", "refreshToken": "aorAAAAA..."},
      {"email": "user2@example.com", "refreshToken": "aorAAAAA..."}
    ],
    "region": "us-east-1"
  }'
```

### 外部 API 调用示例

**OpenAI 兼容接口：**

```bash
curl -X POST 'http://localhost:3000/v1/chat/completions' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

**Claude 兼容接口：**

```bash
curl -X POST 'http://localhost:3000/v1/messages' \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**Gemini Antigravity 接口：**

```bash
curl -X POST 'http://localhost:3000/gemini-antigravity/v1/messages' \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{
    "model": "gemini-3-pro-preview",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Token 刷新示例

### Social Auth (Google/GitHub)

```bash
curl -X POST 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken' \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"YOUR_REFRESH_TOKEN"}'
```

### Builder ID

```bash
curl -X POST 'https://oidc.us-east-1.amazonaws.com/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=refresh_token&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&refresh_token=YOUR_REFRESH_TOKEN'
```

### IAM Identity Center

```bash
curl -X POST 'https://sso-oidc.us-east-1.amazonaws.com/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=refresh_token&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&refresh_token=YOUR_REFRESH_TOKEN'
```

## 项目结构

```
src/
├── index.js              # 主入口，导出所有模块
├── client.js             # KiroClient 类 - API 客户端
├── api.js                # KiroAPI 类 - 无状态 API 服务
├── auth.js               # KiroAuth 类 - OAuth 认证
├── auth-cli.js           # 交互式 CLI 登录工具
├── constants.js          # 常量配置
├── db.js                 # 数据库连接和表管理
├── logger.js             # 日志模块
├── proxy.js              # 代理配置模块
├── server.js             # Express Web 服务器
├── kiro-service.js       # Kiro 服务封装
├── gemini/
│   └── antigravity-core.js  # Gemini Antigravity API 核心
└── public/               # Web 前端文件
```

## 数据库配置

系统使用 MySQL 数据库存储凭据和配置信息。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MYSQL_HOST` | `127.0.0.1` | MySQL 主机地址 |
| `MYSQL_PORT` | `13306` | MySQL 端口 |
| `MYSQL_USER` | `root` | MySQL 用户名 |
| `MYSQL_PASSWORD` | - | MySQL 密码 |
| `MYSQL_DATABASE` | `kiro_api` | 数据库名称 |

### 数据库表结构

#### credentials - Kiro 凭据表

存储 Kiro API 的认证凭据（Google/GitHub/Builder ID/IdC）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT | 主键，自增 |
| `name` | VARCHAR(255) | 凭据名称（唯一），通常为邮箱 |
| `access_token` | TEXT | 访问令牌 |
| `refresh_token` | TEXT | 刷新令牌 |
| `profile_arn` | VARCHAR(512) | AWS Profile ARN（Social Auth 需要） |
| `client_id` | VARCHAR(255) | 客户端 ID（Builder ID/IdC 需要） |
| `client_secret` | TEXT | 客户端密钥（Builder ID/IdC 需要） |
| `auth_method` | VARCHAR(50) | 认证方式：`social`/`builder-id`/`IdC` |
| `provider` | VARCHAR(50) | 提供商：`Google`/`GitHub` |
| `region` | VARCHAR(50) | AWS 区域，默认 `us-east-1` |
| `expires_at` | VARCHAR(50) | Token 过期时间 |
| `is_active` | TINYINT | 是否为活跃凭据 |
| `usage_data` | JSON | 使用量数据 |
| `usage_updated_at` | DATETIME | 使用量更新时间 |
| `created_at` | DATETIME | 创建时间 |
| `updated_at` | DATETIME | 更新时间 |

#### error_credentials - Kiro 错误凭据表

存储刷新失败的 Kiro 凭据，用于后续重试。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT | 主键，自增 |
| `original_id` | INT | 原凭据 ID |
| `name` | VARCHAR(255) | 凭据名称 |
| `access_token` | TEXT | 访问令牌 |
| `refresh_token` | TEXT | 刷新令牌 |
| `profile_arn` | VARCHAR(512) | AWS Profile ARN |
| `client_id` | VARCHAR(255) | 客户端 ID |
| `client_secret` | TEXT | 客户端密钥 |
| `auth_method` | VARCHAR(50) | 认证方式 |
| `region` | VARCHAR(50) | AWS 区域 |
| `expires_at` | VARCHAR(50) | Token 过期时间 |
| `error_message` | TEXT | 错误信息 |
| `error_count` | INT | 错误次数 |
| `last_error_at` | DATETIME | 最后错误时间 |
| `created_at` | DATETIME | 创建时间 |

#### gemini_credentials - Gemini 凭据表

存储 Gemini Antigravity API 的认证凭据。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT | 主键，自增 |
| `name` | VARCHAR(255) | 凭据名称（唯一） |
| `email` | VARCHAR(255) | Google 账号邮箱 |
| `access_token` | TEXT | 访问令牌 |
| `refresh_token` | TEXT | 刷新令牌 |
| `project_id` | VARCHAR(255) | Antigravity 项目 ID |
| `expires_at` | VARCHAR(50) | Token 过期时间 |
| `is_active` | TINYINT | 是否为活跃凭据 |
| `usage_data` | JSON | 使用量数据 |
| `usage_updated_at` | DATETIME | 使用量更新时间 |
| `error_count` | INT | 错误次数 |
| `last_error_at` | DATETIME | 最后错误时间 |
| `last_error_message` | TEXT | 最后错误信息 |
| `created_at` | DATETIME | 创建时间 |
| `updated_at` | DATETIME | 更新时间 |

#### gemini_error_credentials - Gemini 错误凭据表

存储刷新失败的 Gemini 凭据。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT | 主键，自增 |
| `original_id` | INT | 原凭据 ID |
| `name` | VARCHAR(255) | 凭据名称 |
| `email` | VARCHAR(255) | Google 账号邮箱 |
| `access_token` | TEXT | 访问令牌 |
| `refresh_token` | TEXT | 刷新令牌 |
| `project_id` | VARCHAR(255) | 项目 ID |
| `expires_at` | VARCHAR(50) | Token 过期时间 |
| `error_message` | TEXT | 错误信息 |
| `error_count` | INT | 错误次数 |
| `last_error_at` | DATETIME | 最后错误时间 |
| `created_at` | DATETIME | 创建时间 |

#### users - 用户表

存储系统用户信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT | 主键，自增 |
| `username` | VARCHAR(255) | 用户名（唯一） |
| `password_hash` | VARCHAR(255) | 密码哈希 |
| `is_admin` | TINYINT | 是否为管理员 |
| `created_at` | DATETIME | 创建时间 |
| `updated_at` | DATETIME | 更新时间 |

#### api_keys - API 密钥表

存储用户的 API 密钥，用于外部调用。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT | 主键，自增 |
| `user_id` | INT | 关联用户 ID |
| `name` | VARCHAR(255) | 密钥名称 |
| `key_value` | VARCHAR(255) | 密钥值 |
| `key_hash` | VARCHAR(255) | 密钥哈希（唯一） |
| `key_prefix` | VARCHAR(50) | 密钥前缀（用于显示） |
| `is_active` | TINYINT | 是否启用 |
| `last_used_at` | DATETIME | 最后使用时间 |
| `created_at` | DATETIME | 创建时间 |
| `daily_limit` | INT | 每日请求限制（0=无限制） |
| `monthly_limit` | INT | 每月请求限制 |
| `total_limit` | INT | 总请求限制 |
| `concurrent_limit` | INT | 并发请求限制 |
| `rate_limit` | INT | 速率限制（每分钟） |
| `daily_cost_limit` | DECIMAL(10,2) | 每日费用限制 |
| `monthly_cost_limit` | DECIMAL(10,2) | 每月费用限制 |
| `total_cost_limit` | DECIMAL(10,2) | 总费用限制 |
| `expires_in_days` | INT | 有效期（天） |

#### api_logs - API 日志表

记录所有 API 请求日志。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT | 主键，自增 |
| `request_id` | VARCHAR(100) | 请求 ID |
| `api_key_id` | INT | 关联 API 密钥 ID |
| `api_key_prefix` | VARCHAR(50) | API 密钥前缀 |
| `credential_id` | INT | 使用的凭据 ID |
| `credential_name` | VARCHAR(255) | 凭据名称 |
| `ip_address` | VARCHAR(50) | 请求 IP 地址 |
| `user_agent` | TEXT | User-Agent |
| `method` | VARCHAR(10) | 请求方法 |
| `path` | VARCHAR(255) | 请求路径 |
| `model` | VARCHAR(100) | 使用的模型 |
| `stream` | TINYINT | 是否流式请求 |
| `input_tokens` | INT | 输入 Token 数 |
| `output_tokens` | INT | 输出 Token 数 |
| `request_messages` | MEDIUMTEXT | 请求消息内容 |
| `response_content` | MEDIUMTEXT | 响应内容 |
| `status_code` | INT | HTTP 状态码 |
| `error_message` | TEXT | 错误信息 |
| `duration_ms` | INT | 请求耗时（毫秒） |
| `created_at` | DATETIME | 创建时间 |

#### settings - 系统设置表

存储系统配置（如代理设置）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | VARCHAR(255) | 配置键（主键） |
| `value` | TEXT | 配置值（JSON 格式） |
| `updated_at` | DATETIME | 更新时间 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LOG_DIR` | `./logs` | 日志文件目录 |
| `LOG_LEVEL` | `INFO` | 日志级别：DEBUG, INFO, WARN, ERROR |
| `LOG_ENABLED` | `true` | 设为 `false` 禁用日志 |
| `LOG_CONSOLE` | `true` | 设为 `false` 禁用控制台输出 |

## 模型定价

### Kiro (Claude) 模型

| 模型 | 输入价格 ($/M tokens) | 输出价格 ($/M tokens) |
|------|----------------------|----------------------|
| Claude Opus 4.5 | $15 | $75 |
| Claude Sonnet 4/4.5 | $3 | $15 |
| Claude 3.7 Sonnet | $3 | $15 |
| Claude Haiku 4.5 | $0.80 | $4 |

### Gemini 模型

| 模型 | 输入价格 ($/M tokens) | 输出价格 ($/M tokens) |
|------|----------------------|----------------------|
| Gemini 3 Pro | $1.25 | $5 |
| Gemini 3 Flash | $0.075 | $0.30 |
| Gemini 2.5 Flash | $0.075 | $0.30 |
| Gemini Claude Sonnet 4.5 | $3 | $15 |
| Gemini Claude Opus 4.5 Thinking | $15 | $75 |

## 注意事项

- Token 会在过期前 10 分钟自动刷新
- 刷新失败的凭据会被移至 `error_credentials` 表，并定期重试
- 消息历史要求 user/assistant 角色交替，相邻同角色消息会自动合并
- 默认区域为 `us-east-1`

## 许可证

MIT
