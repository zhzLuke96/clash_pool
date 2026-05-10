import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import { ProxyAgent, fetch } from "undici";
import lodash from "lodash-es";

// fake-ip 配置
import DNS_CONFIG from "./dns.config.json";

const BASE_PORT = 52000;
const API_PORT = 9090;
const SERVER_PORT = 3000;
const PERSIST_DIR = "data";
const PERSIST_FILE = `${PERSIST_DIR}/runtime_config.yaml`;
const IP_CACHE_FILE = `${PERSIST_DIR}/ip_info.json`;
const CONFIG_PATH = path.join(
  process.env.HOME || "/root",
  `.config/mihomo/config.yaml`
);

fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

// 支持环境变量配置测速 URL，默认使用 generate_204
const TEST_URL = process.env.TEST_URL || "http://www.gstatic.com/generate_204";

// 固定的策略组名称（由程序自动生成）
const AUTO_TEST_GROUP = "auto_test_all";

let mihomoProcess: ChildProcess | null = null;
let currentProxies: any[] = [];
let liveStatus: Record<string, any> = {};
let ipDetails: Record<string, any> = {};
let mihomoLogs: string[] = [];
const MAX_LOGS = 1000;

const pingingIps = new Set<string>(); // 防止重复并发请求同一个 IP

// 启动时加载 IP 缓存
if (fs.existsSync(IP_CACHE_FILE)) {
  try {
    ipDetails = JSON.parse(fs.readFileSync(IP_CACHE_FILE, "utf-8"));
  } catch {}
}

function saveIpCache() {
  fs.mkdirSync(PERSIST_DIR, { recursive: true });
  fs.writeFileSync(IP_CACHE_FILE, JSON.stringify(ipDetails, null, 2));
}

// 等待 Mihomo API 就绪
async function waitForMihomoAPI(
  retries = 30,
  delayMs = 1000
): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/version`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// 主动触发策略组延迟测试
async function triggerGroupDelayTest() {
  if (!mihomoProcess) {
    console.warn("⚠️ Mihomo 未运行，无法触发策略组测速");
    return;
  }
  const url = encodeURIComponent(TEST_URL);
  const timeout = 5000;
  const groupUrl = `http://127.0.0.1:${API_PORT}/group/${AUTO_TEST_GROUP}/delay?url=${url}&timeout=${timeout}`;
  try {
    const res = await fetch(groupUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const result = await res.json();
      // console.log(result);
      console.log(
        `✅ 已触发策略组 ${AUTO_TEST_GROUP} 延迟测试，内核将更新所有节点延迟`
      );
      mihomoLogs.push(
        `[Trigger] Group delay test invoked at ${new Date().toISOString()}\n`
      );
    } else {
      const errText = await res.text();
      console.warn(`⚠️ 触发策略组测速失败 (${res.status}): ${errText}`);
      mihomoLogs.push(`[Warn] Group delay test failed: ${errText}\n`);
    }
  } catch (e: any) {
    console.error(`❌ 调用策略组测速接口异常: ${e.message}`);
    mihomoLogs.push(`[Error] Group delay test exception: ${e.message}\n`);
  }
}

function startMihomo() {
  mihomoLogs.push(`\n--- [${new Date().toISOString()}] Mihomo Started ---\n`);
  mihomoProcess = spawn("mihomo", ["-f", CONFIG_PATH]);
  const logHandler = (data: Buffer) => {
    const str = data.toString();
    process.stdout.write(str);
    mihomoLogs.push(str);
    if (mihomoLogs.length > MAX_LOGS) mihomoLogs.shift();
  };
  mihomoProcess.stdout?.on("data", logHandler);
  mihomoProcess.stderr?.on("data", logHandler);
  mihomoProcess.on("exit", () => {
    mihomoProcess = null;
    mihomoLogs.push(
      `\n--- [${new Date().toISOString()}] Mihomo Process Exited ---\n`
    );
  });
}

async function reloadConfig(clashData: any) {
  if (!clashData?.proxies?.length) throw new Error("配置中未找到 proxies 节点");

  fs.mkdirSync(PERSIST_DIR, { recursive: true });
  fs.writeFileSync(PERSIST_FILE, yaml.dump(clashData, { lineWidth: -1 }));

  const proxyNames = clashData.proxies.map((p: any) => p.name);

  const config = {
    "allow-lan": true,
    "external-controller": `0.0.0.0:${API_PORT}`,
    dns: DNS_CONFIG.dns,
    // 增加 url-test 策略组，强制内核自动测速
    "proxy-groups": [
      {
        name: AUTO_TEST_GROUP,
        type: "url-test",
        proxies: proxyNames,
        url: TEST_URL,
        interval: 600 * 3, // 这个自动测速好像有问题，我们手动发起测速
      },
    ],
    listeners: clashData.proxies.map((p: any, i: number) => ({
      name: `mixed${i}`,
      type: "mixed",
      port: BASE_PORT + i,
      proxy: p.name,
    })),
    proxies: clashData.proxies,
  };

  fs.writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: -1 }));
  currentProxies = clashData.proxies;
  liveStatus = {}; // 重置状态

  // 记录是否是新启动的进程（用于决定是否需要等待AP就绪）
  let isNewProcess = false;

  if (mihomoProcess) {
    mihomoLogs.push(
      `\n--- [${new Date().toISOString()}] Reloading Config via API ---\n`
    );
    try {
      const res = await fetch(
        `http://127.0.0.1:${API_PORT}/configs?force=true`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: CONFIG_PATH }),
        }
      );
      if (!res.ok) throw new Error(await res.text());
      console.log("✓ Mihomo 配置已热更新");
      // 热更新成功后立即触发策略组测速（API已就绪）
      await triggerGroupDelayTest();
    } catch (e) {
      console.error("热更新失败，尝试强制重启:", e);
      mihomoProcess.kill();
      await new Promise((r) => setTimeout(r, 1000));
      startMihomo();
      isNewProcess = true;
    }
  } else {
    startMihomo();
    isNewProcess = true;
  }

  // 如果是新启动的进程，需要等待API就绪后再触发测速
  if (isNewProcess) {
    console.log("⏳ 等待 Mihomo API 就绪...");
    const ready = await waitForMihomoAPI();
    if (ready) {
      console.log("✓ Mihomo API 已就绪，触发策略组测速");
      await triggerGroupDelayTest();
    } else {
      console.warn("⚠️ 等待 Mihomo API 超时，跳过主动测速");
      mihomoLogs.push(
        "[Warn] Timeout waiting for Mihomo API, skip group delay test\n"
      );
    }
  }
}

// 异步获取代理 IP 详情 (仅对有延迟的节点查一次)
async function fetchIpDetails(proxiesToPing: any[]) {
  const chunkSize = 5;
  for (let i = 0; i < proxiesToPing.length; i += chunkSize) {
    const chunk = proxiesToPing.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (p) => {
        pingingIps.add(p.name);
        const port = BASE_PORT + currentProxies.indexOf(p);
        try {
          const dispatcher = new ProxyAgent(`http://127.0.0.1:${port}`);
          const res = await fetch("http://ip-api.com/json", {
            dispatcher,
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            ipDetails[p.name] = await res.json();
            saveIpCache(); // 每次成功都持久化
          }
        } catch {
        } finally {
          pingingIps.delete(p.name);
        }
      })
    );
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// 定时拉取状态并触发 IP 探测
setInterval(async () => {
  if (!mihomoProcess) return;
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/proxies`);
    const data = (await res.json()) as any;
    liveStatus = data.proxies || {};

    // 找出延迟大于 0 且尚未获取 IP 信息的节点
    const needPing = currentProxies.filter((p) => {
      const delay = liveStatus[p.name]?.history?.[0]?.delay || 0;
      return delay > 0 && !ipDetails[p.name] && !pingingIps.has(p.name);
    });

    if (needPing.length > 0) {
      fetchIpDetails(needPing); // 异步后台执行，不阻塞定时器
    }
  } catch {}
}, 5000);

// HTTP 服务与路由
const server = http.createServer(async (req, res) => {
  const sendJson = (data: any, status = 200) =>
    res
      .writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify(data));
  const sendText = (data: string, status = 200) =>
    res
      .writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
      .end(data);

  try {
    if (req.url === "/status" && req.method === "GET") {
      let alive = 0;
      currentProxies.forEach((p) => {
        if (liveStatus[p.name]?.history?.[0]?.delay > 0) alive++;
      });
      return sendJson({
        total: currentProxies.length,
        alive,
        port_range: currentProxies.length
          ? `${BASE_PORT}-${BASE_PORT + currentProxies.length - 1}`
          : null,
      });
    }

    if (req.url === "/logs" && req.method === "GET") {
      return sendText(mihomoLogs.join(""));
    }

    if (req.url?.startsWith("/proxies") && req.method === "GET") {
      const urlObj = new URL(req.url, `http://localhost`);
      const search = urlObj.searchParams.get("search") || "";
      const matchType = urlObj.searchParams.get("match") || "fuzzy";
      const page = parseInt(urlObj.searchParams.get("page") || "1");
      const limit = parseInt(urlObj.searchParams.get("limit") || "20");
      const aliveOnly = urlObj.searchParams.get("alive") === "true"; // 过滤仅可用
      const keyPath = urlObj.searchParams.get("key_path"); // 使用哪个值来搜索

      let filtered = currentProxies;
      if (search) {
        filtered = filtered.filter((p) => {
          const ip = ipDetails[p.name] || {};
          const obj = {
            ...p,
            ip,
          };
          let searchTarget = [
            p.name,
            p.type,
            ip.country,
            ip.city,
            ip.isp,
            ip.org,
            ip.query,
            ip.as,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (keyPath) {
            searchTarget = lodash.get(obj, keyPath) || p.name;
          }
          if (matchType === "regex") {
            try {
              return new RegExp(search, "i").test(searchTarget);
            } catch {
              return false;
            }
          }
          return searchTarget.includes(search.toLowerCase());
        });
      }

      if (aliveOnly) {
        filtered = filtered.filter(
          (p) => (liveStatus[p.name]?.history?.[0]?.delay || 0) > 0
        );
      }

      const total = filtered.length;
      const start = (page - 1) * limit;
      const data = filtered.slice(start, start + limit).map((p) => {
        const status = liveStatus[p.name];
        const delay = status?.history?.[0]?.delay || 0;
        return {
          name: p.name,
          port: BASE_PORT + currentProxies.indexOf(p),
          type: p.type,
          delay,
          alive: delay > 0,
          ipInfo: ipDetails[p.name] || null,
        };
      });
      return sendJson({ total, page, limit, data });
    }

    if (req.url === "/config" && req.method === "POST") {
      const body = await new Promise<string>((r) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => r(d));
      });
      const clashData = body.trim().startsWith("{")
        ? JSON.parse(body)
        : yaml.load(body);
      await reloadConfig(clashData);
      return sendJson({
        message: "配置已热更新，Mihomo 正在测速，可用节点将自动探测 IP",
        count: currentProxies.length,
      });
    }

    res.writeHead(404).end("Not Found");
  } catch (e: any) {
    sendJson({ error: e.message }, 500);
  }
});

// 启动入口
(async () => {
  server.listen(SERVER_PORT, () =>
    console.log(`✓ 管理 API 运行在: http://localhost:${SERVER_PORT}`)
  );

  const arg = process.argv[2];
  if (arg) {
    try {
      let rawData;
      if (arg.startsWith("http")) rawData = await (await fetch(arg)).text();
      else if (arg.startsWith("file:") || fs.existsSync(arg))
        rawData = fs.readFileSync(arg.replace("file:", ""), "utf-8");
      else throw new Error("无效参数");
      await reloadConfig(yaml.load(rawData) as any);
    } catch (e: any) {
      console.error("初始化配置失败:", e.message);
    }
  } else if (fs.existsSync(PERSIST_FILE)) {
    console.log("✓ 发现已持久化的配置，正在自动加载...");
    try {
      await reloadConfig(
        yaml.load(fs.readFileSync(PERSIST_FILE, "utf-8")) as any
      );
    } catch (e: any) {
      console.error("加载持久化配置失败:", e.message);
    }
  } else {
    console.log("✓ 空载启动，请通过 POST /config 提交配置");
  }
  // 5分钟一次测速
  // 内核不知道为什么好像不会自动测...我直接把内核测速改成一小时，然后我们手动触发
  setInterval(async () => {
    await triggerGroupDelayTest();
  }, 5 * 60 * 1000);
})();
