#requires -Version 7.0

param(
  [string]$PackageDirectory = "",
  [string]$ZipPath = "",
  [ValidateSet("Auto", "Release", "PersonalUse")]
  [string]$ArtifactKind = "Auto"
)

$ErrorActionPreference = "Stop"
$effectiveArtifactKind = $ArtifactKind
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$projectRoot = (Resolve-Path (Join-Path $workspace "..")).Path
$productRoot = Join-Path $projectRoot "成品文件夹"
$releaseRoot = Join-Path $productRoot "发布包"
$cleanupRoot = $null

if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
  if ([string]::IsNullOrWhiteSpace($ZipPath)) {
    $releaseManifestPath = Join-Path $releaseRoot "release-manifest.json"
    if (Test-Path -LiteralPath $releaseManifestPath) {
      $releaseManifest = Get-Content -Raw -LiteralPath $releaseManifestPath | ConvertFrom-Json
      $ZipPath = Join-Path $releaseRoot ([string]$releaseManifest.zip)
    } else {
      $latestZip = Get-ChildItem -File -LiteralPath $releaseRoot -Filter "*-portable.zip" |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
      if (-not $latestZip) { throw "发布目录中没有可验证的 portable ZIP" }
      $ZipPath = $latestZip.FullName
    }
  }
  $ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $entryPaths = @($archive.Entries | Where-Object { $_.FullName } | ForEach-Object { $_.FullName.Replace('\', '/') })
    if ($entryPaths.Count -eq 0) { throw "portable ZIP 为空" }
    $topLevelNames = @($entryPaths | ForEach-Object { $_.Split('/')[0] } | Sort-Object -Unique)
    if ($topLevelNames.Count -ne 1 -or -not $topLevelNames[0].EndsWith("-portable")) {
      throw "ZIP 必须只包含一个 *-portable 顶层目录，不得夹带兄弟文件：$($topLevelNames -join ', ')"
    }
    $topLevelPrefix = "$($topLevelNames[0])/"
    if ($entryPaths | Where-Object { $_ -ne $topLevelPrefix -and -not $_.StartsWith($topLevelPrefix, [StringComparison]::Ordinal) }) {
      throw "ZIP 中存在顶层目录以外的条目"
    }
    if ($effectiveArtifactKind -eq "Auto") {
      $effectiveArtifactKind = if ($entryPaths -contains "${topLevelPrefix}BUILD-STATUS.md") { "PersonalUse" } else { "Release" }
    }
  } finally {
    $archive.Dispose()
  }
  $verifyRoot = Join-Path $workspace ".build-cache\portable-verify-$PID-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $verifyRoot | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $verifyRoot
  $executables = @(Get-ChildItem -Recurse -File -LiteralPath $verifyRoot -Filter "提示词记录工具.exe")
  if ($executables.Count -ne 1) { throw "ZIP 中必须恰好包含一个提示词记录工具.exe" }
  $PackageDirectory = $executables[0].DirectoryName
  $cleanupRoot = $verifyRoot
}

$packageRoot = (Resolve-Path -LiteralPath $PackageDirectory).Path
if ($effectiveArtifactKind -eq "Auto") {
  $effectiveArtifactKind = if (Test-Path -LiteralPath (Join-Path $packageRoot "BUILD-STATUS.md") -PathType Leaf) { "PersonalUse" } else { "Release" }
}
$allowedRoots = @($productRoot, (Join-Path $workspace ".build-cache"))
$insideAllowedRoot = $false
foreach ($allowedRoot in $allowedRoots) {
  $absoluteAllowedRoot = [IO.Path]::GetFullPath($allowedRoot)
  if ($packageRoot.StartsWith($absoluteAllowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    $insideAllowedRoot = $true
    break
  }
}
if (-not $insideAllowedRoot) { throw "便携包不在允许的成品或验证临时目录内：$packageRoot" }

try {
  $expectedTop = @("提示词记录工具.exe", "resources", "README-使用说明.md", "LICENSES", "checksums.sha256")
  if ($effectiveArtifactKind -eq "PersonalUse") { $expectedTop += "BUILD-STATUS.md" }
  $actualTop = @(Get-ChildItem -Force -LiteralPath $packageRoot | ForEach-Object Name | Sort-Object)
  if ((Compare-Object ($expectedTop | Sort-Object) $actualTop).Count -ne 0) {
    throw "便携包顶层结构不符合冻结规范：$($actualTop -join ', ')"
  }
  if (Test-Path -LiteralPath (Join-Path $packageRoot "data")) { throw "发布 ZIP 不得预建 data 目录" }

  $manifestPath = Join-Path $packageRoot "resources\font-manifest.json"
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $version = [string]$manifest.generatedForVersion
  if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "字体 manifest 中的版本格式无效：$version"
  }
  $fontRoot = Join-Path $packageRoot "resources\fonts\core"
  $expectedFonts = @($manifest.families.files.file | Sort-Object)
  $actualFonts = @(Get-ChildItem -File -LiteralPath $fontRoot | ForEach-Object Name | Sort-Object)
  if ((Compare-Object $expectedFonts $actualFonts).Count -ne 0) { throw "实际打包字体不等于白名单" }
  foreach ($family in $manifest.families) {
    $declaredLicense = [string]$family.licenseFile
    $licensePath = [IO.Path]::GetFullPath((Join-Path $packageRoot $declaredLicense))
    if (-not (Test-Path -LiteralPath $licensePath)) {
      # portable 包把字体许可集中在 LICENSES/fonts；旧包与当前打包脚本均采用该布局。
      $licensePath = [IO.Path]::GetFullPath((Join-Path $packageRoot (Join-Path "LICENSES\fonts" ([IO.Path]::GetFileName($declaredLicense)))))
    }
    if (-not $licensePath.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "字体许可路径越出便携包：$declaredLicense"
    }
    if (-not (Test-Path -LiteralPath $licensePath) -or (Get-Item -LiteralPath $licensePath).Length -le 0) {
      throw "字体许可文件缺失或为空：$declaredLicense"
    }
    foreach ($font in $family.files) {
      $path = Join-Path $fontRoot $font.file
      if ((Get-Item -LiteralPath $path).Length -ne [int64]$font.bytes) { throw "字体大小不符：$($font.file)" }
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
      if ($hash -ne $font.sha256) { throw "字体哈希不符：$($font.file)" }
    }
  }

  $checksumPath = Join-Path $packageRoot "checksums.sha256"
  $declared = @{}
  foreach ($line in Get-Content -LiteralPath $checksumPath) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { throw "checksums.sha256 行格式错误：$line" }
    $declared[$Matches[2]] = $Matches[1]
  }
  $immutableFiles = @(Get-ChildItem -Recurse -File -LiteralPath $packageRoot | Where-Object Name -ne "checksums.sha256")
  if ($declared.Count -ne $immutableFiles.Count) { throw "校验文件没有一一覆盖全部不可变文件" }
  foreach ($file in $immutableFiles) {
    $relative = [IO.Path]::GetRelativePath($packageRoot, $file.FullName).Replace('\', '/')
    if (-not $declared.ContainsKey($relative)) { throw "校验清单缺少：$relative" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    if ($actual -ne $declared[$relative]) { throw "文件校验失败：$relative" }
  }

  $totalBytes = ($immutableFiles | Measure-Object Length -Sum).Sum
  if ($totalBytes -gt 150MB) { throw "解压后不可变内容超过 150 MiB：$totalBytes" }
  $exe = Join-Path $packageRoot "提示词记录工具.exe"
  if ((Get-Item -LiteralPath $exe).Length -le 0) { throw "主程序为空" }
  $exeBytes = [IO.File]::ReadAllBytes($exe)
  if ($exeBytes.Length -lt 256 -or $exeBytes[0] -ne 0x4d -or $exeBytes[1] -ne 0x5a) {
    throw "主程序不是有效的 Windows PE 文件"
  }
  $peOffset = [BitConverter]::ToInt32($exeBytes, 0x3c)
  if ($peOffset -lt 0 -or $peOffset + 6 -ge $exeBytes.Length -or
      $exeBytes[$peOffset] -ne 0x50 -or $exeBytes[$peOffset + 1] -ne 0x45 -or
      $exeBytes[$peOffset + 2] -ne 0 -or $exeBytes[$peOffset + 3] -ne 0) {
    throw "主程序 PE 头损坏"
  }
  $machine = [BitConverter]::ToUInt16($exeBytes, $peOffset + 4)
  if ($machine -ne 0x8664) { throw "主程序并非 Windows x64（machine=0x$($machine.ToString('x4'))）" }
  $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
  $reportedVersions = @($versionInfo.ProductVersion, $versionInfo.FileVersion) | Where-Object { $_ }
  $versionPattern = '^' + [Regex]::Escape($version) + '(?:[.+-]|$)'
  if (-not ($reportedVersions | Where-Object { $_ -match $versionPattern })) {
    throw "主程序版本资源与发布版本不一致：expected=$version actual=$($reportedVersions -join ',')"
  }
  Write-Output "便携包验证通过：$packageRoot"
  Write-Output "不可变内容：$totalBytes 字节；字体：$($actualFonts.Count) 个"
} finally {
  if ($cleanupRoot -and (Test-Path -LiteralPath $cleanupRoot)) {
    $resolvedWorkspace = (Resolve-Path -LiteralPath $workspace).Path
    $resolvedCleanup = (Resolve-Path -LiteralPath $cleanupRoot).Path
    if (-not $resolvedCleanup.StartsWith($resolvedWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝清理开发目录以外的验证临时路径"
    }
    Remove-Item -Recurse -Force -LiteralPath $resolvedCleanup
  }
}
