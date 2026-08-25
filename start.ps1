$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Stop-WithMessage([string]$Message) {
  Write-Host "[Token Lens] $Message" -ForegroundColor Red
  Read-Host "按 Enter 退出"
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Stop-WithMessage "找不到 Node.js。请安装 Node.js 18 或更高版本：https://nodejs.org/"
}

$nodeMajor = [int](& node -p "parseInt(process.versions.node, 10)")
if ($nodeMajor -lt 18) {
  Stop-WithMessage "Node.js 版本过低：v$nodeMajor。需要 Node.js 18 或更高版本。"
}

try {
  $port = if ($env:TOKEN_LENS_PORT) { [int]$env:TOKEN_LENS_PORT } else { 4173 }
} catch {
  Stop-WithMessage "TOKEN_LENS_PORT 必须是 0 到 65535 之间的整数。"
}
if ($port -lt 0 -or $port -gt 65535) {
  Stop-WithMessage "TOKEN_LENS_PORT 必须是 0 到 65535 之间的整数。"
}
if ($port -ne 0) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    Stop-WithMessage "端口 $port 已被占用。请关闭占用程序，或先设置 TOKEN_LENS_PORT=0。"
  }
}

$logPath = Join-Path $env:TEMP "codex-token-lens-startup.log"
$errorPath = Join-Path $env:TEMP "codex-token-lens-startup.err.log"
Remove-Item -LiteralPath $logPath, $errorPath -Force -ErrorAction SilentlyContinue
$process = Start-Process -FilePath $node.Source -ArgumentList "server.js" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorPath -PassThru

$url = $null
for ($attempt = 0; $attempt -lt 50 -and -not $url; $attempt++) {
  Start-Sleep -Milliseconds 200
  if ($process.HasExited) { break }
  if (Test-Path -LiteralPath $logPath) {
    $match = Select-String -LiteralPath $logPath -Pattern "http://127\.0\.0\.1:\d+" | Select-Object -First 1
    if ($match) { $url = $match.Matches[0].Value }
  }
}

if (-not $url) {
  $details = @()
  if (Test-Path -LiteralPath $errorPath) { $details += Get-Content -LiteralPath $errorPath -Raw }
  if (Test-Path -LiteralPath $logPath) { $details += Get-Content -LiteralPath $logPath -Raw }
  Stop-WithMessage ("服务启动失败或超时。`n" + ($details -join "`n"))
}

Write-Host "[Token Lens] 已启动：$url" -ForegroundColor Green
if ($env:TOKEN_LENS_NO_BROWSER -ne "1") { Start-Process $url }
