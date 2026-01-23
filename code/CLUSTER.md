# 负载均衡与集群部署指南

## 架构概览

```
客户端请求 → :13003 (负载均衡)
                 ↓ IP 哈希路由
         ┌───────┼───────┬───────┬───────┐
         ↓       ↓       ↓       ↓       ↓
      api-1   api-2   api-3   api-4   api-5
      :13004  :13005  :13006  :13007  :13008
                 ↓
            外部 MySQL
```

## 环境配置

创建 `.env` 文件：

```env
# 负载均衡端口
BALANCER_PORT=13003

# MySQL 数据库配置
MYSQL_HOST=43.228.76.217
MYSQL_PORT=13306
MYSQL_USER=root
MYSQL_PASSWORD=4561230wW?
MYSQL_DATABASE=kiro_api
```

## 启动方式

### 方式一：固定 5 实例 (推荐生产环境)

```bash
# 启动
docker-compose -f docker-compose.cluster.yml up -d

# 查看状态
docker-compose -f docker-compose.cluster.yml ps

# 查看日志
docker-compose -f docker-compose.cluster.yml logs -f

# 停止
docker-compose -f docker-compose.cluster.yml down
```

### 方式二：动态扩展 (支持弹性伸缩)

```bash
# 启动 5 个实例
docker-compose -f docker-compose.scale.yml up -d --scale api=5

# 扩容到 10 个 (不重启已有实例)
docker-compose -f docker-compose.scale.yml up -d --scale api=10 --no-recreate

# 缩容到 3 个
docker-compose -f docker-compose.scale.yml up -d --scale api=3 --no-recreate

# 停止
docker-compose -f docker-compose.scale.yml down
```

### 方式三：本地开发 (不使用 Docker)

```bash
# 终端 1: 启动负载均衡
npm run balancer

# 终端 2: 启动集群 (5个实例)
npm run cluster

# 或一键启动
npm run prod
```

## 状态监控

### Web 页面

- 负载均衡状态页: http://localhost:13003/lb
- 公开状态页: http://localhost:13003/status.html (或单节点 http://localhost:13004/status.html)

### API 接口

```bash
# JSON 状态
curl http://localhost:13003/lb/status

# 健康检查
curl http://localhost:13003/health

# 获取客户端 IP
curl http://localhost:13003/api/client-ip
```

## 负载均衡特性

| 特性 | 说明 |
|------|------|
| IP 一致性哈希 | 同一客户端 IP 始终路由到同一后端 |
| 健康检查 | 每 30 秒检查后端状态 |
| 故障转移 | 后端不可用时自动切换 |
| DNS 发现 | 动态扩展时自动发现新实例 (每 60 秒) |
| 实时监控 | Web 页面每 5 秒刷新状态 |

## 配置文件说明

| 文件 | 说明 |
|------|------|
| `docker-compose.cluster.yml` | 固定 5 实例配置 |
| `docker-compose.scale.yml` | 动态扩展配置 |
| `src/balancer.js` | 负载均衡服务 |
| `src/cluster.js` | 集群启动脚本 |
| `src/public/status.html` | 状态监控页面 |
| `.env` | 环境变量配置 |

## 环境变量

### 负载均衡 (balancer.js)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BALANCER_PORT` | 13003 | 负载均衡端口 |
| `BACKEND_HOSTS` | - | Docker 模式: 后端地址列表 |
| `BACKEND_DNS` | - | DNS 发现模式: 服务名称 |
| `BACKEND_PORT` | 13004 | DNS 发现模式: 后端端口 |
| `BACKEND_START_PORT` | 13004 | 本地模式: 起始端口 |
| `BACKEND_COUNT` | 5 | 本地模式: 实例数量 |

### 集群 (cluster.js)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `INSTANCE_COUNT` | 5 | 实例数量 |
| `START_PORT` | 13004 | 起始端口 |

### 数据库

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MYSQL_HOST` | host.docker.internal | 数据库地址 |
| `MYSQL_PORT` | 13306 | 数据库端口 |
| `MYSQL_USER` | root | 数据库用户 |
| `MYSQL_PASSWORD` | - | 数据库密码 |
| `MYSQL_DATABASE` | kiro_api | 数据库名 |
