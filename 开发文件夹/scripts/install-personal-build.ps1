#requires -Version 7.0

param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath,
  [Parameter(Mandatory = $true)]
  [string]$CurrentPackageDirectory
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$projectRoot = (Resolve-Path (Join-Path $workspace "..")).Path
$productRoot = (Resolve-Path (Join-Path $projectRoot "成品文件夹")).Path
$currentRoot = (Resolve-Path (Join-Path $productRoot "正在使用")).Path
$ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
$CurrentPackageDirectory = (Resolve-Path -LiteralPath $CurrentPackageDirectory).Path
if (-not $CurrentPackageDirectory.StartsWith($currentRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "当前使用目录不在 成品文件夹/正在使用 内，拒绝升级"
}
if (Get-Process -Name "提示词记录工具", "vibe-prompt-recorder" -ErrorAction SilentlyContinue) {
  throw "提示词记录工具仍在运行；请先安全关闭再升级"
}

& (Join-Path $PSScriptRoot "verify-portable.ps1") -ZipPath $ZipPath -ArtifactKind PersonalUse

$manifestPath = Join-Path $productRoot "发布包\release-manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.artifactKind -ne "personal-use" -or $manifest.externalAcceptanceClaimed -ne $false) {
  throw "release manifest 不是明确标记的个人自用成品"
}
$version = [string]$manifest.version
$actualZipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ZipPath).Hash.ToLowerInvariant()
if ($actualZipHash -ne [string]$manifest.zipSha256) { throw "ZIP 与 release manifest 哈希不一致" }

$oldData = Join-Path $CurrentPackageDirectory "data"
if (-not (Test-Path -LiteralPath (Join-Path $oldData ".vpr-data-root.json") -PathType Leaf)) {
  throw "当前使用目录缺少有效 data marker，拒绝自动升级"
}

function Get-TreeManifest([string]$Root) {
  return @(
    Get-ChildItem -LiteralPath $Root -Recurse -Force -File | ForEach-Object {
      [pscustomobject]@{
        relative = [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/')
        bytes = $_.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
      }
    } | Sort-Object relative
  )
}

$stamp = [DateTime]::Now.ToString("yyyyMMdd-HHmmss")
$runId = [Guid]::NewGuid().ToString("N")
$backupRoot = Join-Path $productRoot "用户数据备份\upgrade-to-$version-$stamp"
$historyRoot = Join-Path $productRoot "历史版本"
$historyPackage = Join-Path $historyRoot "$([IO.Path]::GetFileName($CurrentPackageDirectory))-before-$version-$stamp"
$stagingRoot = Join-Path $productRoot ".upgrade-staging-$runId"
$extractRoot = Join-Path $stagingRoot "package"
$targetPackage = Join-Path $currentRoot "提示词记录工具-$version-portable"
if (Test-Path -LiteralPath $targetPackage) { throw "目标使用目录已存在，拒绝覆盖：$targetPackage" }
if (Test-Path -LiteralPath $historyPackage) { throw "历史版本目标已存在，拒绝覆盖：$historyPackage" }

New-Item -ItemType Directory -Path $backupRoot | Out-Null
$backupData = Join-Path $backupRoot "data"
Copy-Item -LiteralPath $oldData -Destination $backupData -Recurse
$sourceManifest = Get-TreeManifest $oldData
$backupManifest = Get-TreeManifest $backupData
$differences = @(Compare-Object $sourceManifest $backupManifest -Property relative, bytes, sha256)
if ($differences.Count -ne 0) { throw "升级前数据备份与源目录不一致，已停止升级" }

$record = [ordered]@{
  schemaVersion = 1
  createdAt = [DateTime]::UtcNow.ToString("o")
  status = "backup-verified"
  fromDirectory = $CurrentPackageDirectory
  toVersion = $version
  sourceDataFileCount = $sourceManifest.Count
  sourceDataBytes = ($sourceManifest | Measure-Object bytes -Sum).Sum
  sourceDatabaseSha256 = if (Test-Path -LiteralPath (Join-Path $oldData "database\app.sqlite3")) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $oldData "database\app.sqlite3")).Hash.ToLowerInvariant()
  } else { $null }
  zipSha256 = $actualZipHash
}
$recordPath = Join-Path $backupRoot "upgrade-record.json"
[IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))

New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractRoot
$packages = @(Get-ChildItem -LiteralPath $extractRoot -Directory)
if ($packages.Count -ne 1) { throw "解压后必须恰好包含一个 portable 目录" }
$newPackage = $packages[0].FullName
& (Join-Path $PSScriptRoot "verify-portable.ps1") -PackageDirectory $newPackage -ArtifactKind PersonalUse

New-Item -ItemType Directory -Path $historyRoot -Force | Out-Null
$oldMoved = $false
$dataMoved = $false
$newInstalled = $false
try {
  Move-Item -LiteralPath $CurrentPackageDirectory -Destination $historyPackage
  $oldMoved = $true
  Move-Item -LiteralPath (Join-Path $historyPackage "data") -Destination (Join-Path $newPackage "data")
  $dataMoved = $true
  Move-Item -LiteralPath $newPackage -Destination $targetPackage
  $newInstalled = $true

  $installedDataManifest = Get-TreeManifest (Join-Path $targetPackage "data")
  $installedDifferences = @(Compare-Object $sourceManifest $installedDataManifest -Property relative, bytes, sha256)
  if ($installedDifferences.Count -ne 0) { throw "升级后 data 与升级前源数据不一致，已停止并回滚" }

  $record.status = "installed"
  $record.completedAt = [DateTime]::UtcNow.ToString("o")
  $record.installedDirectory = $targetPackage
  $record.previousImmutableRetained = $false
  [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
} catch {
  $failure = $_
  try {
    if ($newInstalled -and (Test-Path -LiteralPath $targetPackage)) {
      if ((Test-Path -LiteralPath (Join-Path $targetPackage "data")) -and -not (Test-Path -LiteralPath (Join-Path $historyPackage "data"))) {
        Move-Item -LiteralPath (Join-Path $targetPackage "data") -Destination (Join-Path $historyPackage "data")
      }
      Move-Item -LiteralPath $targetPackage -Destination $newPackage
    } elseif ($dataMoved -and (Test-Path -LiteralPath (Join-Path $newPackage "data"))) {
      Move-Item -LiteralPath (Join-Path $newPackage "data") -Destination (Join-Path $historyPackage "data")
    }
    if ($oldMoved -and (Test-Path -LiteralPath $historyPackage) -and -not (Test-Path -LiteralPath $CurrentPackageDirectory)) {
      Move-Item -LiteralPath $historyPackage -Destination $CurrentPackageDirectory
    }
  } catch {
    throw "升级失败且自动回滚也失败。原始错误：$failure；回滚错误：$_；完整数据备份位于 $backupRoot"
  }
  throw $failure
} finally {
  if ($newInstalled -and (Test-Path -LiteralPath $stagingRoot)) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}

if ($newInstalled -and (Test-Path -LiteralPath $historyPackage)) {
  $resolvedHistoryRoot = (Resolve-Path -LiteralPath $historyRoot).Path
  $resolvedHistoryPackage = (Resolve-Path -LiteralPath $historyPackage).Path
  if (-not $resolvedHistoryPackage.StartsWith($resolvedHistoryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理历史版本目录以外的旧版文件"
  }
  Remove-Item -LiteralPath $resolvedHistoryPackage -Recurse -Force
  if (-not (Get-ChildItem -LiteralPath $resolvedHistoryRoot -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $resolvedHistoryRoot -Force
  }
  $record.oldVersionRemovedAt = [DateTime]::UtcNow.ToString("o")
  [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
}

Write-Output "个人自用成品升级完成：$targetPackage"
Write-Output "用户数据完整备份：$backupRoot"
Write-Output "旧版程序已删除，仅保留 $version 当前使用目录"
