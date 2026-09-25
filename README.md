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
- 导出单个会话的完整对话记录为 Markdown 文件（包含消息、工具调用、输出等完整事件）
- GitHub Gist 备份与跨设备同步：导出所有会话到本地 JSON，上传到 GitHub Gist，其他设备可导入恢复
- 自动刷新，前台每 30 秒同步一次；页面隐藏时暂停，返回前台立即同步
- 支持会话名称/模型搜索、Today 的小时粒度、与上一周期的 token/成本对比和单会话明细复制
- 会话列表每页 50 条，可通过 Previous / Next 浏览全部筛选结果；筛选后回到第一页，自动刷新保留并校正当前页码
- 可选本地费用/额度告警和浏览器通知
- Chrome / Edge 浏览器扩展：工具栏用量概览、连接设置，以及复用完整功能的仪表盘标签页
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

`start.cmd` 会在后台启动 Node.js 服务。**关闭最后一个仪表盘页面或扩展弹窗后，默认 15 秒自动退出并释放端口，无需再手动停止。** 启动后 60 秒没有页面连接也会自动退出。

页面使用持续连接标记使用状态，不依赖前台定时刷新；切换到后台标签页不会触发退出。刷新页面或重新打开页面会取消退出倒计时，尚未完成的请求也不会被中断。只停止本项目服务，不扫描或结束其他程序的端口。

需要立即停止时，仍可双击或运行：

```text
stop.cmd
```

停止脚本只匹配由本目录 `start.cmd` / `start.ps1` 启动的服务，不按端口或进程名批量结束其他程序；随机端口和自定义端口同样适用。启动失败或超时时，启动脚本会清理本次创建的后台进程。

通过 `npm start` 或 `./start.sh` 启动同样默认自动退出，也可以在原启动终端按 `Ctrl+C` 立即停止。需要长期运行（例如随时打开扩展弹窗）时，显式设置 `TOKEN_LENS_IDLE_TIMEOUT_MS=0`。Windows 删除或移动整个项目目录前，还需关闭以该目录为工作目录的终端、Codex 会话，或将它们切换到其他目录。

Linux/macOS 也可以运行：

```bash
./start.sh
```

## 浏览器扩展（Chrome / Edge）

提供 Manifest V3 扩展。工具栏弹窗展示今日 Token、API 等价费用、剩余额度和最近 3 个会话；点击「打开完整仪表盘」可在扩展标签页使用筛选、图表、分页、导出和 Gist 同步。

**扩展仍需要本地 Node.js 服务。** 浏览器不能直接读取 `~/.codex/sessions`；安装扩展不会自动启动服务，也不会修改浏览器或系统启动配置。

### 安装

**直接安装打包版：** 到 [GitHub Releases](https://github.com/xieguu/gpt-token-look/releases) 下载 `gpt-token-look-extension.zip`，解压后在浏览器中加载包含 `manifest.json` 的目录。安装包只有扩展前端；本地服务需使用本仓库源码，在项目目录运行 `npm ci`、`npm start`。无需自行构建扩展。

**从源码构建：** 在项目目录运行：

```bash
npm ci
npm run build:extension
npm start
```

保持服务运行，然后：

1. Chrome 打开 `chrome://extensions`，或 Edge 打开 `edge://extensions`。
2. 开启「开发者模式」，点击「加载已解压的扩展程序」。
3. 选择本项目生成的 **`dist/extension`** 目录，不是源码 `extension` 目录。
4. 将 Token Lens 固定到工具栏，点击图标查看用量。
5. 如修改过服务端口或配置了 `TOKEN_LENS_API_TOKEN`，点击扩展的「设置」，填写对应值并「保存并测试连接」。

构建同时生成 `dist/gpt-token-look-extension.zip`，可分发或用于商店提交。手动安装 ZIP 时先解压，再加载包含 `manifest.json` 的目录。ZIP 仅包含扩展资源，不包含 Node.js 服务；其他设备仍需启动自己的本地服务。此流程不涉及商店上架或 `.crx` 签名。

运行链路：`本机 Codex 会话 JSONL → Node.js 服务 /api/usage → 扩展弹窗或仪表盘`。因此关闭本地服务后，扩展会显示连接失败；它不是在任意网页里注入的悬浮窗，也不会读取网页中的 ChatGPT 对话。

### 连接与权限

- 地址固定为 `http://127.0.0.1`，默认端口 `4173`；自定义端口必须在 `1–65535` 范围内。
- 只申请 `storage` 和 `http://127.0.0.1/*` 权限，没有网页内容脚本，也不申请浏览历史或任意网站访问权限。
- 端口和可选 API Token 保存在此浏览器的 `chrome.storage.local`，不使用账号同步存储。Token 只通过 `x-token-lens-token` 请求头发送，不进入页面或 API 请求 URL。
- 请求禁止自动跟随重定向，不携带 Cookie；默认 15 秒超时。服务关闭、认证失败或数据错误时显示明确错误，不把旧统计显示为新结果。
- 弹窗打开时每 30 秒刷新；关闭弹窗后不在后台轮询。完整仪表盘沿用页面隐藏时暂停刷新的机制。
- 扩展仪表盘直接复用项目的前端文件和本地 API，既有网页入口 `http://127.0.0.1:4173` 不变。

### 更新

源码修改后重新执行 `npm run build:extension`，在浏览器扩展管理页点击 Token Lens 的「重新加载」，并重新打开仪表盘标签页。CI 会构建安装包，Node.js 24 作业会上传名为 `codex-token-lens-extension` 的构建产物。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 数据目录 |
| `TOKEN_LENS_PORT` | `4173` | 本地 HTTP 端口，设为 `0` 可随机分配 |
| `TOKEN_LENS_IDLE_TIMEOUT_MS` | `15000` | 最后一个页面断开且请求完成后的自动退出延迟（毫秒）；`0` 禁用自动退出 |
| `TOKEN_LENS_STARTUP_TIMEOUT_MS` | `60000` | 启动后没有页面使用时的退出延迟（毫秒） |
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

## 扫描与性能

- 会话统计、标题索引和完整导出使用 Node.js 内置流式逐行事件读取，减少逐行异步迭代开销；读取错误明确返回失败，不缓存或导出不完整结果。
- 文件元数据异步读取，最多并发 32 个查询；JSONL 内容解析仍由 `TOKEN_LENS_SCAN_CONCURRENCY` 控制，避免大量日志同时占用内存。
- 同一时刻的扫描请求共享一个进行中的任务，本地扫描与官方额度查询同时进行。
- 本地全量导出与 Gist 上传只依赖本地扫描和价格表，不启动或等待官方额度查询；`/api/usage` 仍并行读取账户信息。
- 缓存有效期内，文件大小、修改时间、状态变更时间和文件标识都未变化时复用解析结果；没有新增、变更或删除文件时不重写磁盘缓存。
- 会话文件与标题均未变更时，复用已规范化、排序的会话列表及额度、解析错误汇总，避免每次刷新重复分配对象和汇总。文件变化、标题变化或缓存过期时重新生成。
- 会话标题索引按文件签名复用，修改标题不需要重新解析会话。缓存到期或 TTL 为 `0` 时仍执行全量解析。
- 前端只在数据刷新时排序和更新模型选项；筛选与统计使用单次遍历，搜索输入采用 150ms 防抖。
- 翻页复用当前筛选结果，只渲染最多 50 行，不重新扫描数据或重绘图表。统计卡片、图表及 CSV / JSON 导出始终覆盖完整筛选结果，不受当前页限制。
- 切换图表粒度只重绘用量图表，保留表格页码和统计卡片；若搜索防抖尚未执行，先统一应用搜索结果，再绘图。重复选择当前粒度不会产生额外重绘。
- 复制明细包含 cache write input；剪贴板不可用或写入失败时显示 ✗，按钮提示中保留错误原因。

`GET /api/usage` 的 `diagnostics` 包含以下性能字段：

| 字段 | 含义 |
| --- | --- |
| `parsedFileCount` | 本次重新解析的 JSONL 文件数 |
| `cachedFileCount` | 本次复用缓存的文件数 |
| `cacheWritten` | 本次是否成功更新磁盘缓存 |
| `summaryReused` | 本次是否复用规范化、排序后的会话列表及额度和错误汇总 |
| `parseErrorCount` | 所有扫描文件中统计事件的解析错误总数，包括尚无 token 统计的会话 |

## API

```http
GET http://127.0.0.1:4173/api/usage
```

```http
POST http://127.0.0.1:4173/api/pricing/update
```

```http
GET http://127.0.0.1:4173/api/sessions/{sessionId}/full
```

返回指定会话 ID 的完整事件日志。会话 ID 可从 `/api/usage` 的 `sessions[].id` 字段获取。

响应结构：

```json
{
  "sessionId": "session-abc123",
  "title": "会话标题",
  "model": "gpt-5.6-luna",
  "events": [
    { "type": "session_meta", "payload": {...}, "timestamp": "..." },
    { "type": "message", "payload": { "role": "user", "content": "..." }, "timestamp": "..." },
    { "type": "message", "payload": { "role": "assistant", "content": "..." }, "timestamp": "..." },
    { "type": "tool_call", "payload": { "tool_name": "...", "tool_input": {...} }, "timestamp": "..." },
    { "type": "tool_result", "payload": { "tool_output": "..." }, "timestamp": "..." }
  ]
}
```

### 同步和备份

三个新的 Gist 同步端点用于跨设备备份：

**导出所有会话**：
```http
GET http://127.0.0.1:4173/api/export/all
```

**上传到 GitHub Gist**：
```http
POST http://127.0.0.1:4173/api/sync/upload-gist
```

请求体：
```json
{
  "githubToken": "ghp_xxxx",
  "deviceName": "MacBook-Pro"
}
```

响应：
```json
{
  "ok": true,
  "gistId": "xxxx",
  "gistUrl": "https://gist.github.com/user/xxxx",
  "fileUrl": "https://gist.githubusercontent.com/..."
}
```

**从 GitHub Gist 导入**：
```http
POST http://127.0.0.1:4173/api/sync/download-gist
```

请求体：
```json
{
  "gistId": "xxxx",
  "githubToken": "ghp_xxxx"
}
```

**使用流程**：
1. 设备 A：点击"📤 Upload Gist"，输入 GitHub Token，获得 Gist ID
2. 设备 B：点击"📲 Import Gist"，输入 Gist ID，导入所有会话

同步接口只接受 JSON 对象，请求体上限为 64 KiB；支持分块传输。非法 JSON 或参数返回 `400`，超过大小上限返回 `413`，Gist 请求失败返回 `502` 并提供错误详情。浏览器通过 `x-token-lens-token` 请求头传递本地 API Token，不将它附加到导出或同步请求 URL。

### 更新接口

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

### 统计数据导出

页面里的 `Export CSV` 和 `Export JSON` 会导出当前筛选结果。导出数据包含会话标题、日期、模型、Token 明细（包括 `cacheWriteInput`）、美元估算和是否成功匹配价格。

### 完整对话导出

表格中每行会话末尾的 📥 按钮可以导出该会话的完整聊天记录。点击后会自动下载一个 Markdown 文件（命名为 `会话名_sessionId_日期.md`），包含：

- 会话元数据（标题、ID、模型、开始时间、总 Token 数）
- 按时间顺序的完整消息序列
- 用户消息、助手回复
- 工具调用及其输入参数
- 工具执行结果
- 任何错误或异常

**API 端点**：

```http
GET http://127.0.0.1:4173/api/sessions/{sessionId}/full
```

返回完整的事件日志，包括所有 JSONL 事件（消息、工具调用、输出等）。服务启动后即可直接调用，无需先访问 `/api/usage`；返回的模型采用会话最后一次记录的模型。

## 截图

仓库展示截图为 `token-lens-preview.png`。当 UI 改动后，重新启动本地服务并用浏览器或 Playwright 截图覆盖这个文件。发布前确认截图里没有私人路径、真实会话标题或敏感项目名。

## 开发与测试

```bash
npm ci
npm run check
npm test
npm run build:extension
```

CI 会在 Node.js 18、20、22、24 上运行语法检查和测试。

扩展回归覆盖连接配置校验、仅本机访问、请求头认证、超时与错误传播、仪表盘接口适配、资源完整性、最小权限和 ZIP 可复现构建。ZIP 打包复用 `fflate`，仅为开发依赖，未增加服务端运行时依赖。

回归测试使用临时 JSONL 数据和模拟 Gist 服务，不读取真实 Codex 会话，也不向 GitHub 上传数据。覆盖缓存及汇总复用与失效、并发扫描、读取错误传播、UTF-8 跨块与末行处理、冷启动导出、官方慢查询与本地导出隔离、分块请求、请求体限制、静态文件访问边界、分页与导出范围、局部图表重绘、剪贴板失败反馈，以及搜索防抖和后台暂停刷新。

### 本地性能基准

```bash
npm run benchmark
```

基准脚本在系统临时目录生成 8 个 JSONL 文件，共 80,016 行、约 25.8 MB，完成后自动清理，不读取真实会话，也不调用官方额度或 Gist 接口。三种场景各运行 5 次，输出耗时中位数（毫秒）：

- `coldMedianMs`：禁用解析缓存后的全量扫描；不代表操作系统文件缓存已清空。
- `warmMedianMs`：文件未变更时的缓存扫描，同时断言没有重新解析、重写缓存或构建汇总，并复用同一个会话数组。
- `changedMedianMs`：只追加一个会话文件后的扫描，同时断言只重新解析该文件且统计已更新。

比较修改前后性能时使用相同 Node.js 版本和机器；基准不设置依赖机器性能的通过阈值。

HTTP 静态资源仅提供仪表盘页面、前端脚本、样式和预览图；服务端源码、价格文件、环境配置和 `.git` 不通过静态路由开放。

## 隐私边界

服务只监听 `127.0.0.1`，只读取本地 Codex 会话统计字段，不上传第三方服务，不读取：

- `auth.json`
- API key
- GitHub 凭据

### 完整对话导出

完整对话导出功能（`/api/sessions/{sessionId}/full`）会读取会话的完整事件数据，包括：

- 聊天消息内容
- 工具调用及其输入参数
- 工具执行结果和输出

这些数据完全保存在本地，不会自动上传。用户下载的 Markdown 文件由用户自己管理其安全性。建议：

- 不要将导出的 Markdown 文件上传到公开位置
- 注意文件中可能包含的敏感信息（API 参数、个人数据等）
- 使用文件访问权限限制导出文件的访问

## License

[MIT](./LICENSE)
