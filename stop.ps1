$ErrorActionPreference = "Stop"

$serverPath = Join-Path $PSScriptRoot "server.js"
$commandPattern = '^(?:"[^"]+"|\S+)\s+"' + [regex]::Escape($serverPath) + '"\s*$'
$services = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match $commandPattern })

if ($services.Count -eq 0) {
  Write-Host "[Token Lens] No background server started by this directory's start.cmd was found."
  Write-Host "[Token Lens] For npm start, press Ctrl+C in the original terminal."
  exit 0
}

foreach ($service in $services) {
  $process = Get-Process -Id $service.ProcessId -ErrorAction Stop
  Stop-Process -InputObject $process -ErrorAction Stop
  if (-not $process.WaitForExit(5000)) {
    throw "Timed out waiting for server PID $($service.ProcessId) to exit."
  }
  Write-Host "[Token Lens] Stopped server PID $($service.ProcessId)." -ForegroundColor Green
}
