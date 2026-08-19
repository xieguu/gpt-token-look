# Codex Token Lens

本地优先的 Codex Token 用量仪表盘。它读取本机 `~/.codex/sessions` 中的 JSONL 会话统计，展示 Token、模型、会话、限额和美元估算。

![Codex Token Lens preview](./token-lens-preview.png)

## 功能

- 按日期范围和模型筛选会话
- 汇总 input、cached input、output、reasoning 和 total tokens
- 显示最新 `primary` / `secondary` 使用限额与重置时间
- 按内置模型价格表估算 API 美元成本
- 自动刷新，默认每 30 秒同步一次
- 只读取本地统计字段，不读取会话正文、工具输出、`auth.json` 或 API key

## 快速开始

要求：Node.js 18+

```bash
npm install
npm start
```

打开：<http://127.0.0.1:4173>

Windows 也可以运行：

```text
start.cmd
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 数据目录 |
| `TOKEN_LENS_PORT` | `4173` | 本地 HTTP 端口，设为 `0` 可随机分配 |
| `TOKEN_LENS_CACHE_DIR` | 系统临时目录 | 增量扫描缓存目录 |

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

返回字段包括：

- `sessions[]`：会话、模型、Token 和单会话美元估算
- `costSummary`：已估算会话数、未匹配价格会话数和总美元估算
- `rateLimits.primary` / `rateLimits.secondary`：最新限额窗口
- `pricing`：当前内置价格表及官方来源链接

PowerShell 调用：

```powershell
$data = Invoke-RestMethod http://127.0.0.1:4173/api/usage
$data.costSummary
$data.sessions
```

## 美元估算

价格单位为 USD / 1M tokens。估算公式：

```text
billable_input = input_tokens - cached_input_tokens
cost = billable_input / 1_000_000 * input_price
     + cached_input_tokens / 1_000_000 * cached_input_price
     + output_tokens / 1_000_000 * output_price
```

未匹配到价格的模型不会被虚构计费，会标记为未估算。价格来源：<https://developers.openai.com/api/docs/models/compare>

## 开发与测试

```bash
npm.cmd run check
npm.cmd test
```

## 隐私边界

服务只监听 `127.0.0.1`，只读取本地 Codex 会话统计字段，不上传第三方服务，不读取：

- 会话正文
- 工具输出
- `auth.json`
- API key

## License

[MIT](./LICENSE)