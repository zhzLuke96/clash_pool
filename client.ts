/**
 * Clash Pool Client SDK
 * 独立的客户端，用于与 clash_pool 服务端交互
 */

// ==================== 类型定义 ====================

export interface IpInfo {
  status: string;
  country: string;
  countryCode: string;
  region: string;
  regionName: string;
  city: string;
  zip: string;
  lat: number;
  lon: number;
  timezone: string;
  isp: string;
  org: string;
  as: string;
  query: string;
}

export interface ProxyNode {
  name: string;
  port: number;
  type: string;
  delay: number;
  alive: boolean;
  ipInfo: IpInfo | null;
}

export interface SystemStatus {
  total: number;
  alive: number;
  port_range: string | null;
}

export interface ProxySearchParams {
  /** 搜索关键字 (匹配节点名、国家、城市、ISP等) */
  search?: string;
  /** 匹配模式: 'fuzzy' (默认) 或 'regex' */
  match?: "fuzzy" | "regex";
  /** 是否只返回可用(延迟>0)的节点 */
  alive?: boolean;
  /** 页码，默认 1 */
  page?: number;
  /** 每页数量，默认 20 */
  limit?: number;
}

export interface ProxyListResponse {
  total: number;
  page: number;
  limit: number;
  data: ProxyNode[];
}

export interface ConfigUpdateResponse {
  message: string;
  count: number;
}

// ==================== 客户端类 ====================

export class ClashPoolClient {
  private apiUrl: string;
  private proxyHost: string;

  /**
   * 初始化客户端
   * @param apiUrl clash_pool 管理 API 地址，例如 http://your-server-ip:3000
   * @param proxyHost 代理服务的宿主机 IP/域名，用于生成代理地址。如果不传，将尝试从 apiUrl 中提取 hostname
   */
  constructor(apiUrl: string = "http://localhost:3000", proxyHost?: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, ""); // 移除末尾斜杠

    if (proxyHost) {
      this.proxyHost = proxyHost;
    } else {
      // 尝试从 apiUrl 中提取主机地址
      try {
        this.proxyHost = new URL(this.apiUrl).hostname;
      } catch {
        this.proxyHost = "127.0.0.1"; // 兜底
      }
    }
  }

  /**
   * 获取系统状态汇总
   */
  async getStatus(): Promise<SystemStatus> {
    return this.request("/status");
  }

  /**
   * 获取 Mihomo 原始运行日志
   * @returns 纯文本日志内容
   */
  async getLogs(): Promise<string> {
    const res = await fetch(`${this.apiUrl}/logs`);
    if (!res.ok) throw new Error(`请求失败: ${res.status} ${res.statusText}`);
    return res.text();
  }

  /**
   * 搜索/查询代理节点列表
   * @param params 搜索、分页及过滤参数
   */
  async getProxies(params?: ProxySearchParams): Promise<ProxyListResponse> {
    const query = new URLSearchParams();
    if (params?.search) query.set("search", params.search);
    if (params?.match) query.set("match", params.match);
    if (params?.alive !== undefined) query.set("alive", String(params.alive));
    if (params?.page !== undefined) query.set("page", String(params.page));
    if (params?.limit !== undefined) query.set("limit", String(params.limit));

    const qs = query.toString();
    return this.request(`/proxies${qs ? `?${qs}` : ""}`);
  }

  /**
   * 提交/更新 Clash 配置
   * @param config 支持 JSON 对象、JSON 字符串 或 YAML 字符串
   */
  async updateConfig(config: object | string): Promise<ConfigUpdateResponse> {
    const body = typeof config === "object" ? JSON.stringify(config) : config;
    const isJson = body.trim().startsWith("{");

    return this.request("/config", {
      method: "POST",
      headers: { "Content-Type": isJson ? "application/json" : "text/yaml" },
      body,
    });
  }

  /**
   * 根据节点端口生成代理地址
   * @param port 节点端口
   * @param protocol 协议类型: 'http' 或 'socks5'，默认 'http'
   */
  getProxyUrl(port: number, protocol: "http" | "socks5" = "http"): string {
    return `${protocol}://${this.proxyHost}:${port}`;
  }

  /**
   * 获取第一个可用节点的代理地址 (快捷方法)
   * @param protocol 协议类型: 'http' 或 'socks5'，默认 'http'
   * @returns 代理地址，例如 http://1.2.3.4:52001，无可用节点时返回 null
   */
  async getFirstAliveProxy(
    protocol: "http" | "socks5" = "http"
  ): Promise<string | null> {
    const res = await this.getProxies({ alive: true, limit: 1 });
    if (res.data.length > 0) {
      const node = res.data[0];
      return this.getProxyUrl(node.port, protocol);
    }
    return null;
  }

  // 内部请求封装
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, options);
    if (!res.ok) {
      let errorMsg = `请求失败: ${res.status} ${res.statusText}`;
      try {
        const errBody = await res.json();
        if (errBody.error) errorMsg = errBody.error;
      } catch {}
      throw new Error(errorMsg);
    }
    return res.json();
  }
}
