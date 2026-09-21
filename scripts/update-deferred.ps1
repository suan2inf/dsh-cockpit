<#
  update-deferred.ps1 -- deferred DSH updater, launched by the dsh-cockpit panel.

  The panel cannot update DSH while DSH itself is running (that is exactly how
  half-written node_modules broke startups before). So the panel spawns THIS
  script in its own console window; the script:

    1. waits for port 3080 to free up (you closing the DSH Web console window),
       up to -WaitMinutes (default 10)
    2. runs update-dsh.ps1 -AutoReapplyFixes (local fixes are backed up and
       re-applied automatically; a cockpit gate runs after the build)
    3. on success, relaunches DSH Web via start-dsh-web.ps1

  Everything stays visible in this window; nothing here touches a running DSH.

  The harness checkout is passed via -Repo by the host plugin; standalone use
  falls back to $env:DSH_REPO, then to the common %USERPROFILE%\deepseek-harness.
#>

param(
    [string]$Repo,
    [int]$WaitMinutes = 10,
    [switch]$NoRelaunch
)

$ErrorActionPreference = 'Continue'
if (-not $Repo) { $Repo = $env:DSH_REPO }
if (-not $Repo) {
    $candidate = Join-Path $env:USERPROFILE 'deepseek-harness'
    if (Test-Path (Join-Path $candidate 'packages\core\tools\package.json')) { $Repo = $candidate }
}
if (-not $Repo -or -not (Test-Path (Join-Path $Repo 'update-dsh.ps1'))) {
    Write-Host 'Could not locate the deepseek-harness checkout.' -ForegroundColor Red
    Write-Host 'Re-run with:  update-deferred.ps1 -Repo C:\path\to\deepseek-harness' -ForegroundColor Yellow
    Read-Host 'Press Enter to close this window'
    exit 1
}
$repo = $Repo
Set-Location $repo
try { $host.UI.RawUI.WindowTitle = 'DSH 更新助手' } catch { }

function Test-PortBusy {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne(1000)
        if ($ok -and $client.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

Write-Host ''
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host '  DSH 更新助手' -ForegroundColor Cyan
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '请现在关闭运行 DSH Web 的那个控制台窗口（不是浏览器标签页）。' -ForegroundColor Yellow
Write-Host "我会在端口 3080 释放后自动开始更新，最长等待 $WaitMinutes 分钟。"
Write-Host ''

$deadline = (Get-Date).AddMinutes($WaitMinutes)
$dots = 0
while ((Get-Date) -lt $deadline) {
    if (-not (Test-PortBusy -Port 3080)) { break }
    $dots++
    if ($dots % 15 -eq 0) { Write-Host '  仍在等待 DSH Web 关闭...' -ForegroundColor DarkGray }
    Start-Sleep -Seconds 2
}

if (Test-PortBusy -Port 3080) {
    Write-Host ''
    Write-Host "等待超时（$WaitMinutes 分钟），DSH Web 仍在运行。" -ForegroundColor Red
    Write-Host '更新已取消。关闭 DSH Web 后可重新从体检中心发起更新。' -ForegroundColor Yellow
    Read-Host '按回车关闭本窗口'
    exit 1
}

Write-Host ''
Write-Host 'DSH Web 已关闭，开始更新。' -ForegroundColor Green
Write-Host ''

& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'update-dsh.ps1') -AutoReapplyFixes
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
    Write-Host '更新完成。' -ForegroundColor Green
    if (-not $NoRelaunch) {
        Write-Host '正在重新启动 DSH Web...' -ForegroundColor Green
        Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repo 'start-dsh-web.ps1'))
        Write-Host '已启动。浏览器会自动打开；本窗口可以关闭了。' -ForegroundColor DarkGray
        Start-Sleep -Seconds 3
        exit 0
    }
} else {
    Write-Host "更新失败（exit $code）。" -ForegroundColor Red
    Write-Host '往上翻有具体原因；也可以运行 node cli.js（在 dsh-cockpit 目录）跑完整体检。' -ForegroundColor Yellow
}
Read-Host '按回车关闭本窗口'
exit $code
