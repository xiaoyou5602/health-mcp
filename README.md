# health-mcp · 自托管健康数据服务端

把手环的步数、心率、睡眠与可选的运动摘要落到你自己的服务器，并通过 MCP 暴露给 AI 助手读取。

配合手机端的 Gadgetbridge fork 使用：

```text
手环 ──蓝牙──> 手机 App ──HTTPS 上传──> 本服务 ──MCP──> ChatGPT / Claude / Codex / 其他客户端
```

Express + MCP SDK，需 Node 20+。手机端 App 与完整图文教程见文末链接。

## 安装

```bash
git clone https://github.com/xiaoyou5602/health-mcp.git && cd health-mcp
npm install
cp .env.example .env
```

## 配置

编辑 `.env`。两个 token 用随机值，且**必须不一样**——一个在手机 App 里、一个在 AI 客户端里，泄露一个不至于连带另一个：

```bash
openssl rand -hex 24   # → HEALTH_INGEST_TOKEN（上传）
openssl rand -hex 24   # → HEALTH_MCP_ACCESS_TOKEN（读取）
```

| 变量 | 说明 |
| --- | --- |
| `HEALTH_INGEST_TOKEN` | 上传门锁，手机 App 用，至少 16 字符，服务端强制 |
| `HEALTH_MCP_ACCESS_TOKEN` | 读取门锁，AI 客户端用；**留空则任何人可读** |
| `HEALTH_DATA_DIR` | 数据落盘目录，默认 `/var/lib/health-mcp` |
| `HEALTH_MCP_PUBLIC_URLS` | 对外域名，用于 Host 头校验，多个逗号分隔 |
| `HEALTH_MCP_PORT` | 监听端口，默认 `3100` |
| `HEALTH_MCP_HOST` | 监听地址，默认 `127.0.0.1`（只回环，公网由反代 / Tunnel 转入）|
| `HEALTH_TZ` | 睡眠按「醒来日期」归属时用的时区，默认 `Asia/Shanghai` |

## 运行

```bash
npm start        # 等价于 node health-server.js
```

自测服务是否活着：

```bash
curl http://127.0.0.1:3100/healthz   # 返回 {"ok":true,...}
```

生产环境建议配成 systemd 服务（模板见 [`deploy/health-mcp.service`](deploy/health-mcp.service)），别用 `nohup` 裸跑。公网入口用 Caddy / Nginx 反代，或 Cloudflare Tunnel。**必须走 HTTPS**——token 和健康数据都在明文 body 里。

## MCP 工具

服务只暴露一个 `health_read` 工具：

- `data_type`：`current_status`、`steps`、`heart_rate`、`sleep`、`daily_summary`、`all`
- `time_range`：`today` 或 `three_days`
- `days`：除 `current_status` 外可自定义读取 1～62 天；传入后优先于 `time_range`
- `heart_rate_detail`：仅用于 `heart_rate`，可选 `daily` 或 `hourly`；小时模式只返回每小时统计，不返回原始样本

不传参数时返回紧凑的当前状态。`daily_summary` 每天包含步数、卡路里、心率、血氧、压力和睡眠摘要；
`all` 还会附带睡眠明细。读取结果可能附带 `cycle` 经期上下文。

经期配置使用上传门锁调用 `POST /cycle`，请求体包含 `enabled`、`last_start`、
`cycle_length_days`、`cycle_period_days`，以及可选的 `last_confirmed`。关闭时发送 `{ "enabled": false }`，
服务会删除独立的 `cycle.json`，不会写入每日健康记录。

MCP 入口 `https://你的域名/mcp`（Streamable HTTP）。若设了读取 token，客户端请求头需加 `Authorization: Bearer <读取token>`。

## 数据

按天落盘为 `<HEALTH_DATA_DIR>/YYYY-MM-DD.json`。同一天重复上传自动合并：步数取较大值、心率按时间戳去重、睡眠 session 按时间跨度合并，运动摘要按稳定 `id` 更新。所以重复上传或手动补传历史都不会把数据搞乱。

运动摘要由配套 App 独立选择是否上传，默认关闭。服务端只保存约定的摘要字段，不保存路线、位置、设备地址或自由文本；单条异常记录会被跳过，不影响同批其他运动或原有健康数据。原始 HTTP 读取接口的 `type=all` 会返回已经保存的 `workouts`，当前 MCP 分类工具仍保持原有读取契约。

## 许可

MIT（本服务端为独立代码）。手机端 Gadgetbridge fork 是 AGPLv3、单独的仓库。

---

完整端到端图文教程（含手机端安装、连手环、接入 AI）：
<https://github.com/xiaoyou5602/band-health-sync/blob/master/docs/GUIDE.md>
