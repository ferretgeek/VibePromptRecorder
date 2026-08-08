#requires -Version 7.0

param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath,
  [string]$ExistingDataDirectory = ""
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
if (Get-Process -Name "提示词记录工具", "vibe-prompt-recorder" -ErrorAction SilentlyContinue) {
  throw "检测到提示词记录工具正在运行；为避免单实例转发，不能执行隔离冒烟"
}

& (Join-Path $PSScriptRoot "verify-portable.ps1") -ZipPath $ZipPath -ArtifactKind PersonalUse

$runRoot = Join-Path $workspace ".build-cache\portable-smoke-$PID-$([Guid]::NewGuid().ToString('N'))"
$extractRoot = Join-Path $runRoot "package"
$dataRoot = Join-Path $runRoot "data"
$process = $null
try {
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractRoot
  $executables = @(Get-ChildItem -Recurse -File -LiteralPath $extractRoot -Filter "提示词记录工具.exe")
  if ($executables.Count -ne 1) { throw "最终 ZIP 中必须恰好包含一个主 EXE" }

  if ([string]::IsNullOrWhiteSpace($ExistingDataDirectory)) {
    New-Item -ItemType Directory -Path $dataRoot | Out-Null
    $mode = "fresh-data"
  } else {
    $sourceData = (Resolve-Path -LiteralPath $ExistingDataDirectory).Path
    if (-not (Test-Path -LiteralPath (Join-Path $sourceData ".vpr-data-root.json") -PathType Leaf)) {
      throw "现有数据副本缺少 .vpr-data-root.json"
    }
    Copy-Item -LiteralPath $sourceData -Destination $dataRoot -Recurse
    $mode = "existing-data-copy"
  }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $executables[0].FullName
  $startInfo.UseShellExecute = $false
  [void]$startInfo.ArgumentList.Add("--data-dir")
  [void]$startInfo.ArgumentList.Add($dataRoot)
  $process = [Diagnostics.Process]::Start($startInfo)

  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $handle = [IntPtr]::Zero
  while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    $handle = $process.MainWindowHandle
    if ($handle -ne [IntPtr]::Zero) { break }
  }
  if ($process.HasExited) { throw "原生应用提前退出：$($process.ExitCode)" }
  if ($handle -eq [IntPtr]::Zero) { throw "60 秒内未出现原生主窗口" }

  Start-Sleep -Seconds 6
  $process.Refresh()
  if ($process.HasExited) { throw "初始化期间原生应用退出：$($process.ExitCode)" }
  if (-not $process.CloseMainWindow()) { throw "无法请求主窗口安全关闭" }
  if (-not $process.WaitForExit(20000)) { throw "安全关闭超时" }
  if ($process.ExitCode -ne 0) { throw "原生应用退出码异常：$($process.ExitCode)" }
  if (-not (Test-Path -LiteralPath (Join-Path $dataRoot ".vpr-clean-shutdown") -PathType Leaf)) {
    throw "安全退出后缺少 .vpr-clean-shutdown"
  }

  Write-Output "portable 原生隔离冒烟通过：mode=$mode；exit=0；clean-marker=yes"
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    [void]$process.WaitForExit(5000)
  }
  $removed = $false
  for ($attempt = 0; $attempt -lt 30 -and -not $removed; $attempt += 1) {
    try {
      if (Test-Path -LiteralPath $runRoot) {
        Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction Stop
      }
      $removed = $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $removed) { throw "隔离冒烟目录仍被 WebView2 占用：$runRoot" }
}

& (Join-Path $PSScriptRoot "verify-portable.ps1") -ZipPath $ZipPath -ArtifactKind PersonalUse
