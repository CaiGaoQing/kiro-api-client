#!/usr/bin/env node
/**
 * 负载均衡服务 - 基于 IP 的一致性哈希轮询
 * 端口: 13003
 *
 * 环境变量:
 *   BALANCER_PORT - 负载均衡端口 (默认 13003)
 *   BACKEND_HOSTS - Docker 模式: 逗号分隔的后端地址
 *   BACKEND_DNS - DNS 发现模式: 服务名称
 *   BACKEND_PORT - DNS 发现模式: 后端端口 (默认 13004)
 *   BACKEND_START_PORT - 本地模式: 起始端口 (默认 13004)
 *   BACKEND_COUNT - 本地模式: 实例数量 (默认 5)
 */

import http from 'http';
import { createHash } from 'crypto';
import dns from 'dns';
import { promisify } from 'util';

const dnsResolve = promisify(dns.resolve4);
const BALANCER_PORT = parseInt(process.env.BALANCER_PORT || '13003');

let backends = [];

function getTimestamp() {
    return new Date().toLocaleString('zh-CN', { hour12: false });
}

async function initBackends() {
    backends = [];
    if (process.env.BACKEND_DNS) {
        const serviceName = process.env.BACKEND_DNS;
        const port = parseInt(process.env.BACKEND_PORT || '13004');
        try {
            const ips = await dnsResolve(serviceName);
            for (const ip of ips) {
                backends.push({ host: ip, port, healthy: true, lastCheck: Date.now() });
            }
            console.log(`[${getTimestamp()}] DNS 发现: ${serviceName} -> ${ips.length} 个实例`);
        } catch (err) {
            console.error(`[${getTimestamp()}] DNS 发现失败: ${err.message}`);
            backends.push({ host: serviceName, port, healthy: true, lastCheck: Date.now() });
        }
    } else if (process.env.BACKEND_HOSTS) {
        for (const hostPort of process.env.BACKEND_HOSTS.split(',')) {
            const [host, port] = hostPort.trim().split(':');
            backends.push({ host, port: parseInt(port), healthy: true, lastCheck: Date.now() });
        }
    } else {
        const startPort = parseInt(process.env.BACKEND_START_PORT || '13004');
        const count = parseInt(process.env.BACKEND_COUNT || '5');
        for (let i = 0; i < count; i++) {
            backends.push({ host: '127.0.0.1', port: startPort + i, healthy: true, lastCheck: Date.now() });
        }
    }
    return backends;
}

await initBackends();

const ipMapping = new Map();

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.socket.remoteAddress || '127.0.0.1';
}

function selectBackend(clientIP) {
    if (ipMapping.has(clientIP)) {
        const cached = ipMapping.get(clientIP);
        const backend = backends[cached.index];
        if (backend && backend.healthy) return backend;
    }
    const healthyBackends = backends.filter(b => b.healthy);
    if (healthyBackends.length === 0) return backends[0];

    const hash = createHash('md5').update(clientIP).digest('hex');
    const index = parseInt(hash.substring(0, 8), 16) % healthyBackends.length;
    const backend = healthyBackends[index];
    ipMapping.set(clientIP, { index: backends.indexOf(backend), timestamp: Date.now() });
    return backend;
}

function proxyRequest(req, res, backend) {
    const clientIP = getClientIP(req);
    const startTime = Date.now();
    const options = {
        hostname: backend.host,
        port: backend.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, 'x-forwarded-for': clientIP, 'x-real-ip': clientIP }
    };
    delete options.headers.host;

    const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on('end', () => {
            console.log(`[${getTimestamp()}] ${clientIP} -> ${backend.host}:${backend.port} | ${req.method} ${req.url} | ${proxyRes.statusCode} | ${Date.now() - startTime}ms`);
        });
    });

    proxyReq.on('error', (err) => {
        console.error(`[${getTimestamp()}] 后端错误: ${err.message}`);
        backend.healthy = false;
        const other = backends.find(b => b.healthy && b !== backend);
        if (other) proxyRequest(req, res, other);
        else {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Gateway' }));
        }
    });
    req.pipe(proxyReq);
}

async function healthCheck() {
    for (const b of backends) {
        try {
            const res = await fetch(`http://${b.host}:${b.port}/health`, { signal: AbortSignal.timeout(3000) });
            b.healthy = res.ok;
        } catch { b.healthy = false; }
        b.lastCheck = Date.now();
    }
    console.log(`[${getTimestamp()}] 健康检查: ${backends.filter(b => b.healthy).length}/${backends.length} 可用`);
}

function getStatusPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>负载均衡状态</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0f0f1a,#1a1a2e,#16213e);min-height:100vh;color:#fff;padding:20px}
.container{max-width:1400px;margin:0 auto}
.header{text-align:center;padding:40px 0 30px}
.header h1{font-size:36px;background:linear-gradient(90deg,#00d9ff,#00ff88);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header p{color:#888;font-size:16px}
.your-route{background:linear-gradient(135deg,rgba(0,217,255,0.1),rgba(0,255,136,0.1));border:2px solid rgba(0,217,255,0.3);border-radius:20px;padding:30px;margin-bottom:30px;position:relative;overflow:hidden}
.your-route-content{display:flex;align-items:center;justify-content:center;gap:20px;flex-wrap:wrap;position:relative;z-index:1}
.route-box{background:rgba(0,0,0,0.3);border-radius:12px;padding:20px 30px;text-align:center;min-width:150px}
.route-box .label{color:#888;font-size:12px;margin-bottom:8px}
.route-box .value{font-size:24px;font-weight:bold;color:#00d9ff}
.route-box.target .value{color:#00ff88}
.route-arrow{font-size:40px;color:#00d9ff;animation:arrow-flow 1.5s ease-in-out infinite}
@keyframes arrow-flow{0%,100%{transform:translateX(0);opacity:1}50%{transform:translateX(10px);opacity:0.5}}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:30px}
.stat-card{background:rgba(255,255,255,0.05);border-radius:12px;padding:25px;text-align:center}
.stat-card .number{font-size:42px;font-weight:bold;margin-bottom:5px}
.stat-card .label{color:#888;font-size:14px}
.stat-card.total .number{color:#00d9ff}
.stat-card.healthy .number{color:#00ff88}
.stat-card.unhealthy .number{color:#ff4757}
.nodes-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}
.node-card{background:rgba(255,255,255,0.05);border-radius:12px;padding:20px;border:2px solid transparent;transition:all 0.3s}
.node-card.online{border-color:rgba(0,255,136,0.3)}
.node-card.offline{border-color:rgba(255,71,87,0.3)}
.node-card.current{border-color:#00ff88;box-shadow:0 0 30px rgba(0,255,136,0.2);background:rgba(0,255,136,0.05)}
.node-card .node-header{display:flex;align-items:center;margin-bottom:15px}
.node-card .status-indicator{width:12px;height:12px;border-radius:50%;margin-right:10px;animation:blink 2s infinite}
.node-card.online .status-indicator{background:#00ff88}
.node-card.offline .status-indicator{background:#ff4757}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.4}}
.node-card .node-name{font-size:16px;font-weight:bold;flex:1}
.node-card .current-badge{background:#00ff88;color:#000;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:bold}
.node-card .node-info{display:flex;justify-content:space-between;margin:8px 0;font-size:14px}
.node-card .node-info .label{color:#888}
.node-card .latency.good{color:#00ff88}
.node-card .latency.medium{color:#ffa502}
.node-card .latency.slow{color:#ff4757}
.node-card .error-msg{color:#ff4757;font-size:12px;margin-top:10px;padding:8px;background:rgba(255,71,87,0.1);border-radius:6px}
.footer{text-align:center;padding:30px;color:#666;font-size:14px}
.footer a{color:#00d9ff;text-decoration:none}
</style>
</head>
<body>
<div class="container">
<div class="header"><h1>Kiro API Gateway</h1><p>负载均衡状态监控</p></div>
<div class="your-route"><div class="your-route-content">
<div class="route-box"><div class="label">你的 IP</div><div class="value" id="clientIP">检测中...</div></div>
<div class="route-arrow">→</div>
<div class="route-box"><div class="label">负载均衡</div><div class="value">:13003</div></div>
<div class="route-arrow">→</div>
<div class="route-box target"><div class="label">路由到节点</div><div class="value" id="targetNode">计算中...</div></div>
</div></div>
<div class="stats">
<div class="stat-card total"><div class="number" id="totalNodes">-</div><div class="label">总节点数</div></div>
<div class="stat-card healthy"><div class="number" id="healthyNodes">-</div><div class="label">健康节点</div></div>
<div class="stat-card unhealthy"><div class="number" id="unhealthyNodes">-</div><div class="label">异常节点</div></div>
</div>
<div class="nodes-grid" id="nodesGrid"><div style="text-align:center;padding:50px;color:#666">加载中...</div></div>
<div class="footer">每 5 秒自动刷新 | 最后更新: <span id="lastUpdate">-</span><br><br><a href="/login.html">管理后台</a></div>
</div>
<script>
let clientIP = null;
function hashIP(ip, n) { let h = 0; for (let i = 0; i < ip.length; i++) { h = ((h << 5) - h) + ip.charCodeAt(i); h = h & h; } return Math.abs(h) % n; }
async function fetchStatus() {
    try {
        if (!clientIP) { const r = await fetch('/api/client-ip'); clientIP = (await r.json()).ip || '未知'; document.getElementById('clientIP').textContent = clientIP; }
        const res = await fetch('/lb/status'); const data = await res.json();
        const backends = data.backends, healthy = backends.filter(b => b.reachable);
        let targetIdx = 0;
        if (healthy.length > 0 && clientIP !== '未知') { const hi = hashIP(clientIP, healthy.length); const tb = healthy[hi]; targetIdx = backends.findIndex(b => b.host === tb.host && b.port === tb.port); }
        document.getElementById('targetNode').textContent = backends[targetIdx] ? ':' + backends[targetIdx].port : '-';
        document.getElementById('totalNodes').textContent = data.summary.total;
        document.getElementById('healthyNodes').textContent = data.summary.healthy;
        document.getElementById('unhealthyNodes').textContent = data.summary.unhealthy;
        document.getElementById('nodesGrid').innerHTML = backends.map((b, i) => {
            const online = b.reachable, current = i === targetIdx;
            const lat = b.latency ? parseInt(b.latency) : null;
            const lc = lat !== null ? (lat < 50 ? 'good' : lat < 200 ? 'medium' : 'slow') : '';
            return '<div class="node-card ' + (online ? 'online' : 'offline') + (current ? ' current' : '') + '">' +
                '<div class="node-header"><div class="status-indicator"></div><div class="node-name">' + b.host + ':' + b.port + '</div>' +
                (current ? '<span class="current-badge">当前节点</span>' : '') + '</div>' +
                '<div class="node-info"><span class="label">状态</span><span>' + (online ? '✅ 在线' : '❌ 离线') + '</span></div>' +
                '<div class="node-info"><span class="label">延迟</span><span class="latency ' + lc + '">' + (b.latency || '-') + '</span></div>' +
                '<div class="node-info"><span class="label">健康检查</span><span>' + (b.healthy ? '通过' : '失败') + '</span></div>' +
                (b.error ? '<div class="error-msg">错误: ' + b.error + '</div>' : '') + '</div>';
        }).join('');
        document.getElementById('lastUpdate').textContent = new Date().toLocaleString('zh-CN', { hour12: false });
    } catch (e) { console.error('获取状态失败:', e); }
}
fetchStatus(); setInterval(fetchStatus, 5000);
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
    if ((req.url === '/lb' || req.url === '/lb/') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getStatusPage());
        return;
    }
    if (req.url === '/lb/status' && req.method === 'GET') {
        const status = await Promise.all(backends.map(async (b) => {
            const start = Date.now();
            let reachable = false, latency = null, error = null;
            try {
                const r = await fetch(`http://${b.host}:${b.port}/health`, { signal: AbortSignal.timeout(3000) });
                reachable = r.ok; latency = Date.now() - start;
            } catch (e) { error = e.message; }
         return { host: b.host, port: b.port, healthy: b.healthy, reachable, latency: latency ? latency + 'ms' : null, error, lastCheck: new Date(b.lastCheck).toISOString() };
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            balancer: { port: BALANCER_PORT, mode: process.env.BACKEND_DNS ? 'dns' : process.env.BACKEND_HOSTS ? 'hosts' : 'local' },
            summary: { total: backends.length, healthy: status.filter(b => b.reachable).length, unhealthy: status.filter(b => !b.reachable).length },
            backends: status, cache: { size: ipMapping.size }, timestamp: new Date().toISOString()
        }, null, 2));
        return;
    }
    if (req.url === '/health' && req.method === 'GET') {
        const h = backends.filter(b => b.healthy).length;
        res.writeHead(h > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: h > 0 ? 'ok' : 'error', healthy_backends: h }));
        return;
    }
    const backend = selectBackend(getClientIP(req));
    proxyRequest(req, res, backend);
});

server.listen(BALANCER_PORT, () => {
    console.log(`[${getTimestamp()}] 负载均衡服务已启动 | http://localhost:${BALANCER_PORT}`);
    console.log(`[${getTimestamp()}] 后端实例: ${backends.map(b => b.host + ':' + b.port).join(', ')}`);
    console.log(`[${getTimestamp()}] 状态页面: http://localhost:${BALANCER_PORT}/lb`);
});

setInterval(healthCheck, 30000);
setInterval(() => { const exp = Date.now() - 3600000; for (const [k, v] of ipMapping) if (v.timestamp < exp) ipMapping.delete(k); }, 600000);
if (process.env.BACKEND_DNS) setInterval(async () => { const old = backends.length; await initBackends(); if (backends.length !== old) { console.log(`[${getTimestamp()}] 后端数量变化: ${old} -> ${backends.length}`); ipMapping.clear(); } }, 60000);
setTimeout(healthCheck, 5000);
process.on('SIGINT', () => { console.log(`\n[${getTimestamp()}] 负载均衡服务关闭`); server.close(); process.exit(0); });
