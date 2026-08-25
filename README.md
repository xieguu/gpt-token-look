# GPT Token Look / Codex Token Lens

本地优先的 Codex Token 用量仪表盘。它读取本机 `~/.codex/sessions` 里的 JSONL 会话统计，展示 Token、模型、会话、primary/secondary 限额和 API 等价美元估算。

![Codex Token Lens preview](./token-lens-preview.png)

## 功能

- 按最近 7 天、30 天、全部记录查看用量
- 默认只显示当天会话；可切换 Today / 7d / 30d / All，或使用自定义日期范围和模型筛选
- 汇总 input、cached input、cache write input、output、reasoning output 和 total tokens
- 显示最新 `primary` / `secondary` 使用限额与重置时间
- 额度圆环主数字显示剩余百分比，并同时标明已用百分比、窗口长度和重置时间
- 优先通过 Codex 官方 app-server `account/rateLimits/read` 查询账户级额度；不可用时回退到本地 JSONL 快照，并在面板标注来源
- 通过官方 app-server `account/usage/read` 读取账户级每日 token 汇总（如果当前 CLI 已登录）
- 按内置或自定义价格表估算 API 等价美元成本
- 默认价格表位于项目目录的 `pricing.json`；界面右上角 `Update prices` 会按需抓取官方 pricing 页面，解析成功后原子写回这个文件。不会自动定时联网。
- 导出当前筛选结果为 CSV 或 JSON
- 自动刷新，默认每 30 秒同步一次
- 支持会话名称/模型搜索、Today 的小时粒度、与上一周期的 token/成本对比和单会话明细复制
- 可选本地费用/额度告警和浏览器通知
- 只读取本地统计字段，不读取会话正文、工具输出、`auth.json` 或 API key

## 快速开始

要求：Node.js 18+

```bash
npm install
npm start
```

打开：

```text
http://127.0.0.1:4173
```

Windows 也可以运行：

```text
start.cmd
```

Linux/macOS 也可以运行：

```bash
./start.sh
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 数据目录 |
| `TOKEN_LENS_PORT` | `4173` | 本地 HTTP 端口，设为 `0` 可随机分配 |
| `TOKEN_LENS_CACHE_DIR` | 系统临时目录 | 增量扫描缓存目录 |
| `TOKEN_LENS_PRICES_JSON` | 空 | 自定义 API 价格 JSON |
| `TOKEN_LENS_PRICING_FILE` | 空 | 自定义 API 价格 JSON 文件路径 |
| `TOKEN_LENS_CACHE_TTL` | `15m` | 增量缓存 TTL；设为 `0` 每次请求全量扫描 |
| `TOKEN_LENS_SCAN_CONCURRENCY` | `3` | 并发解析 JSONL 文件数（1-32） |
| `TOKEN_LENS_API_TOKEN` | 空 | 可选 API 保护令牌；请求使用 `x-token-lens-token` header 或 `?token=` |
| `TOKEN_LENS_DAILY_COST_ALERT_USD` | 空 | 当当前筛选费用达到阈值时显示告警 |
| `TOKEN_LENS_RATE_LIMIT_ALERT_PERCENT` | `10` | 剩余额度低于该百分比时显示告警 |
| `TOKEN_LENS_OFFICIAL_USAGE` | `auto` | 官方额度查询：`auto` 自动尝试，`0` 或 `off` 禁用 |
| `TOKEN_LENS_OFFICIAL_TIMEOUT_MS` | `5000` | 官方 app-server 查询超时 |
| `TOKEN_LENS_CODEX_COMMAND` | 自动检测 | 自定义 Codex CLI 命令路径 |

PowerShell 示例：

```powershell
$env:CODEX_HOME = "$HOME\.codex"
$env:TOKEN_LENS_PORT = "4173"
npm.cmd start
```

## API

```http
GET http://127.0.0.1:4173/api/usage
```

```http
POST http://127.0.0.1:4173/api/pricing/update
```

更新接口抓取官方 pricing 页面、校验模型价格，并写回项目目录的 `pricing.json`。如果页面启用 Cloudflare、需要 JavaScript 或结构变化，旧价格会保留并返回失败原因。

返回字段包括：

- `sessions[]`：会话、模型、Token 和单会话美元估算
- `costSummary`：已估算会话数、未匹配价格会话数和总美元估算
- `rateLimits.primary` / `rateLimits.secondary`：最新限额窗口
- `pricing`：当前内置或自定义价格表及官方来源链接

PowerShell 调用：

```powershell
$data = Invoke-RestMethod http://127.0.0.1:4173/api/usage
$data.costSummary
$data.sessions
```

## 额度查询口径

Token Lens 按以下优先级显示额度：

1. **官方账户快照**：调用本机 Codex CLI app-server 的 `account/rateLimits/read`，读取官方返回的 `primary`、`secondary`、重置时间、套餐和 credits 字段。
2. **本地会话快照**：官方查询不可用时，从 `~/.codex/sessions/**/*.jsonl` 最近的 `event_msg.rate_limits` 回退。这是历史事件里的快照，不保证代表当前账户状态。
3. **不可用**：两者都没有数据时显示不可用，不用 token 数量推算额度百分比。

账户级每日 token 汇总来自官方 app-server 的 `account/usage/read`。它和本地会话逐条汇总是两个口径，页面会分别展示。

## 美元估算

价格单位为 USD / 1M tokens。更新按钮使用 OpenAI 官方 API pricing 页面：<https://platform.openai.com/pricing>

内置默认值：

| 模型 | Input | Cached input | Cache write input | Output |
| --- | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | 5.00 | 0.50 | 6.25 | 30.00 |
| GPT-5.6 Terra | 2.50 | 0.25 | 3.125 | 15.00 |
| GPT-5.6 Luna | 1.00 | 0.10 | 1.25 | 6.00 |

估算公式：

```text
billable_input = input_tokens - cached_input_tokens - cache_write_input_tokens
cost = billable_input / 1_000_000 * input_price
     + cached_input_tokens / 1_000_000 * cached_input_price
     + cache_write_input_tokens / 1_000_000 * cache_write_input_price
     + output_tokens / 1_000_000 * output_price
```

未匹配到价格的模型不会被虚构计费，会标记为 `Unpriced`。

自定义价格示例：

```powershell
$env:TOKEN_LENS_PRICES_JSON = '{"models":[{"pattern":"gpt-5.6-luna","label":"GPT-5.6 Luna","input":1,"cachedInput":0.1,"cacheWriteInput":1.25,"output":6}]}'
npm.cmd start
```

也可以放到文件里：

```json
{
  "models": [
    {
      "pattern": "gpt-5.6-luna",
      "label": "GPT-5.6 Luna",
      "input": 1,
      "cachedInput": 0.1,
      "cacheWriteInput": 1.25,
      "output": 6
    }
  ]
}
```

然后启动：

```powershell
$env:TOKEN_LENS_PRICING_FILE = "C:\path\to\pricing.json"
npm.cmd start
```

## 导出

页面里的 `Export CSV` 和 `Export JSON` 会导出当前筛选结果。导出数据包含会话标题、日期、模型、Token 明细、美元估算和是否成功匹配价格。

## 截图

仓库展示截图为 `token-lens-preview.png`。当 UI 改动后，重新启动本地服务并用浏览器或 Playwright 截图覆盖这个文件。发布前确认截图里没有私人路径、真实会话标题或敏感项目名。

## 开发与测试

```bash
npm run check
npm test
```

CI 会在 Node.js 18、20、22、24 上运行语法检查和测试。

## 隐私边界

服务只监听 `127.0.0.1`，只读取本地 Codex 会话统计字段，不上传第三方服务，不读取：

- 会话正文
- 工具输出正文
- `auth.json`
- API key
- GitHub 凭据

## License

[MIT](./LICENSE)
