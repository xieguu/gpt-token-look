# Codex Token Lens

一个本地优先的 Codex Token 用量可视化面板。它读取当前电脑上的 Codex 会话归档，展示输入、缓存输入、输出、推理输出、会话趋势和最近一次限额窗口。

![Codex Token Lens 预览](./token-lens-preview.png)

> 这是社区项目，并非 OpenAI 官方产品。本项目读取的是 Codex 客户端本地状态格式；该格式不是公开承诺的稳定 API，Codex 更新后解析器可能需要同步调整。

## 特性

- 真实读取本机 Codex Token 汇总，不使用示例数据
- 展示 7 天、30 天和全部历史趋势
- 展示输入、缓存输入、输出和推理输出
- 读取最近一次 Codex 限额窗口、使用比例和重置时间
- 每 30 秒自动刷新，并使用增量缓存加速后续扫描
- 服务仅监听 `127.0.0.1`
- 不向浏览器返回提示词正文、工具输出或认证文件
- 无第三方运行时依赖，无外部字体或分析脚本
- 支持 Windows、macOS 和 Linux

## 环境要求

- Node.js 18 或更高版本
- 已在当前系统用户下使用过 Codex，并存在本地会话归档

默认数据目录：

- Windows：`%USERPROFILE%\.codex\sessions`
- macOS/Linux：`~/.codex/sessions`

## 启动

克隆或下载项目后：

```bash
npm start
```

然后访问：

```text
http://127.0.0.1:4173
```

Windows 用户也可以双击 `start.cmd`，它会启动服务并打开默认浏览器。

macOS/Linux 用户可以运行：

```bash
./start.sh
```

如果脚本尚无执行权限：

```bash
chmod +x start.sh
```

## 自定义配置

可通过环境变量指定其他数据目录或端口：

```bash
CODEX_HOME=/path/to/.codex TOKEN_LENS_PORT=8080 npm start
```

PowerShell 示例：

```powershell
$env:CODEX_HOME = "D:\codex-profile"
$env:TOKEN_LENS_PORT = "8080"
npm start
```

当不同账号需要严格隔离时，建议为每个账号使用独立的 `CODEX_HOME`。本项目不会读取 `auth.json`，因此无法可靠判断同一数据目录中的会话分别属于哪个账号。

## 数据与隐私

服务端只解析以下汇总信息：

- 会话 ID、标题、日期和模型名称
- 输入与缓存输入 Token
- 输出与推理输出 Token
- Token 总量
- 最近一次限额窗口

不会解析或返回：

- 用户提示词正文
- 助手回复正文
- 工具调用参数与输出
- API Key、访问令牌或 `auth.json`

增量缓存保存在系统临时目录的 `codex-token-lens` 子目录中，不会写入项目仓库。API 只绑定本机回环地址，并设置了同源内容安全策略。

## 账号与跨设备

这个面板按“本机 Codex 数据目录”统计，而不是通过 ChatGPT 账号联网查询：

- 换电脑后只会显示新电脑本地已有的会话
- 仅复制本项目不会同步旧电脑的历史数据
- 同一 `CODEX_HOME` 曾使用多个账号时，统计可能合并
- 它不统计 ChatGPT 网页、桌面聊天或手机 App 的 Token

## 开发与测试

```bash
npm run check
npm test
```

测试使用临时的匿名 Codex 会话夹具，不读取真实用户会话。

## 已知限制

- 本地会话格式可能随 Codex 版本变化
- 会话归属无法在不读取账号认证信息的前提下可靠区分
- 首次扫描耗时取决于本地会话归档大小；后续扫描会使用增量缓存
- 当前只提供本机使用，不应把服务绑定到公网地址

## License

[MIT](./LICENSE)
