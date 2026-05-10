# clash_pool

将 Clash 订阅/配置 转换为独立端口的 SOCKS5/HTTP 代理池，并提供常驻管理 API。

## ✨ 特性

- **一键代理池**：每个 Clash 节点自动映射一个独立本地端口 (从 `52000` 起)
- **常驻进程**：内置定时心跳检测，实时掌握节点延迟与可用性
- **动态热更新**：支持空载启动，通过 API 动态提交/切换配置，自动重启代理池
- **多格式输入**：支持 URL、本地文件、原始 YAML/JSON 文本
- **节点搜索**：支持按名称模糊搜索代理，快速定位节点端口

## 🚀 快速开始

确保已安装 Docker 及 Docker Compose，然后运行：

> 没有预先打包，启动包含打包过程可能略慢

```bash
# 空载启动（等待通过 API 提交配置）
docker compose up -d
```

提交 / 刷新代理池 (支持 JSON/YAML)

```bash
# 提交 YAML 文本
curl -X POST http://localhost:3000/config --data-binary @./my-clash.yaml

# 提交 JSON
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"proxies": [{"name": "test", "type": "http", "server": "1.1.1.1", "port": 80}]}'
```

## 📡 管理 API

服务默认在 `3000` 端口提供管理接口。

### 1. 查看系统状态

获取代理池总数、可用节点数及端口范围。

```bash
curl http://localhost:3000/status
```

返回示例：

```json
{
  "total": 15,
  "alive": 12,
  "port_range": "52000-52014"
}
```

### 2. 搜索代理节点

支持多字段模糊搜索与正则匹配，并自动分页。搜索范围包含：节点名、类型、国家、城市、ISP、IP 地址等。

**参数说明：**

- `search`: 搜索关键字 (可选)
- `match`: 匹配模式 `fuzzy`(默认) 或 `regex`(正则) (可选)
- `page`: 页码，默认 1 (可选)
- `limit`: 每页数量，默认 20 (可选)
  增加 `alive=true` 参数，仅返回 Mihomo 测速延迟大于 0 的节点。

**请求示例：**

```bash
# 模糊搜索包含 "Japan" 的节点，第1页
curl "http://localhost:3000/proxies?search=Japan"

# 正则匹配以 HK- 开头的节点
curl "http://localhost:3000/proxies?search=^HK-&match=regex"

# 获取第2页，每页10条
curl "http://localhost:3000/proxies?page=2&limit=10"

# 搜索名称包含 HK 且当前可用的节点
curl "http://localhost:3000/proxies?search=HK&alive=true"
```

**返回示例：**

```json
{
  "total": 15,
  "page": 1,
  "limit": 20,
  "data": [
    {
      "name": "JP-Tokyo-01",
      "port": 52005,
      "type": "ss",
      "delay": 120,
      "alive": true,
      "ipInfo": {
        "status": "success",
        "country": "Japan",
        "city": "Tokyo",
        "isp": "Oracle Cloud",
        "query": "138.2.xx.xx"
      }
    }
  ]
}
```

### 3. 查看运行日志

直接返回 Mihomo 内核的原始纯文本日志（缓存最近 1000 行）。

```bash
curl http://localhost:3000/logs
```

### 4. IP 详情自动探测

当提交新配置或系统启动时，服务会在后台自动通过各代理节点请求 `http://ip-api.com/json` 获取出口 IP 详细信息。

- 信息仅探测一次并缓存，不会反复消耗请求。
- 探测采用并发控制，防止触发公共 API 限流。
- 探测结果会在 `/proxies` 接口的 `ipInfo` 字段中展示。

## 💾 数据持久化

服务支持配置持久化，避免每次重启都需要重新提交配置：

- 提交的配置会自动保存在容器内的 `/app/data/runtime_config.yaml`
- 只要 Docker 挂载了 `./data:/app/data`，重启容器时会自动加载历史配置
- 加载优先级：`命令行参数` > `本地持久化文件` > `空载等待API提交`

## 🧪 测试代理

启动成功后，每个代理节点对应一个独立端口：

```bash
# 使用 SOCKS5 代理测试
curl --socks5 127.0.0.1:52000 https://ipinfo.io/ip

# 使用 HTTP 代理测试
curl --proxy http://127.0.0.1:52001 https://ipinfo.io/ip
```

## ⚙️ 工作原理

底层使用 `metacubex/mihomo` 作为内核。Node.js 进程作为常驻守护进程管理 Mihomo 生命周期：

1. 解析传入的 Clash 配置，为每个 Proxy 生成独立的 `mixed-port` 监听器
2. 注入 `external-controller`，每 5 秒轮询节点延迟状态
3. 接收到新配置时，安全终止旧进程并生成新配置启动，实现热更新

## SDK Usage

本项目提供 SDK 实现 [./client.ts](./client.ts) ，用法如下

```typescript
import { ClashPoolClient } from "./client";

// 1. 初始化客户端
// 远程部署场景：API 在 3000 端口，代理池在 52000+ 端口，都在 1.2.3.4 这台服务器上
const client = new ClashPoolClient("http://1.2.3.4:3000", "1.2.3.4");

// 本地开发场景：不传第二个参数，默认从 API 地址中提取，或回退到 127.0.0.1
// const localClient = new ClashPoolClient('http://localhost:3000');

async function main() {
  // 2. 快捷获取一个可用的 HTTP 代理
  const httpProxy = await client.getFirstAliveProxy("http");
  console.log(`自动选取 HTTP 代理: ${httpProxy}`);
  // 输出: 自动选取 HTTP 代理: http://1.2.3.4:52001

  // 3. 快捷获取一个可用的 SOCKS5 代理
  const socks5Proxy = await client.getFirstAliveProxy("socks5");
  console.log(`自动选取 SOCKS5 代理: ${socks5Proxy}`);
  // 输出: 自动选取 SOCKS5 代理: socks5://1.2.3.4:52001

  // 4. 在 axios 或 node-fetch 等库中使用
  if (httpProxy) {
    /*
    // axios 示例
    const axios = require('axios');
    const res = await axios.get('https://ipinfo.io/ip', {
      proxy: {
        host: client.proxyHost, // 1.2.3.4
        port: 52001
      }
    });
    */
  }

  // 5. 搜索指定地区的节点，并获取其代理地址
  const jpNodes = await client.getProxies({ search: "Japan", alive: true });
  if (jpNodes.data.length > 0) {
    const jpNode = jpNodes.data[0];
    console.log(`日本节点代理地址: ${client.getProxyUrl(jpNode.port, "http")}`);
    // 输出: 日本节点代理地址: http://1.2.3.4:52005
  }
}

main().catch(console.error);
```
