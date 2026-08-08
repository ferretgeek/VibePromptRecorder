#requires -Version 7.0

param(
  [switch]$PersonalUse
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$projectRoot = (Resolve-Path (Join-Path $workspace "..")).Path
$documentationRoot = Join-Path $projectRoot "需求和方案文件夹"
$packageJson = Get-Content -Raw -LiteralPath (Join-Path $workspace "package.json") | ConvertFrom-Json
$version = [string]$packageJson.version
$artifactKind = if ($PersonalUse) { "PersonalUse" } else { "Release" }
$releaseRoot = Join-Path $projectRoot "成品文件夹\发布包"
$runId = "$PID-$([Guid]::NewGuid().ToString('N'))"
$stagingRoot = Join-Path $workspace ".build-cache\portable-package-$runId"
$packageRoot = Join-Path $stagingRoot "提示词记录工具-$version-portable"
$zipPath = "$packageRoot.zip"
$releaseZipPath = Join-Path $releaseRoot ([IO.Path]::GetFileName($zipPath))
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
$lockPath = Join-Path $releaseRoot ".package.lock"
try {
  $releaseLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  throw "已有发布包正在由另一进程生成；不同版本也不能并发覆写共享 manifest"
}

try {
$cargoVersion = if ((Get-Content -LiteralPath (Join-Path $workspace "src-tauri\Cargo.toml") | Select-String -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1) -match '"([^"]+)"') { $Matches[1] } else { "" }
$tauriVersion = [string]((Get-Content -Raw -LiteralPath (Join-Path $workspace "src-tauri\tauri.conf.json") | ConvertFrom-Json).version)
$fontManifestVersion = [string]((Get-Content -Raw -LiteralPath (Join-Path $workspace "src-tauri\resources\font-manifest.json") | ConvertFrom-Json).generatedForVersion)
if (@($cargoVersion, $tauriVersion, $fontManifestVersion) | Where-Object { $_ -ne $version }) {
  throw "发布版本不一致：package=$version cargo=$cargoVersion tauri=$tauriVersion fonts=$fontManifestVersion"
}

$gitCommit = $null
if (-not $PersonalUse) {
  $dirty = git -C $projectRoot status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "无法检查 Git 工作区" }
  if ($dirty) { throw "正式发布构建要求干净工作区；请提交或清理变更后重试" }
  $gitCommit = (git -C $projectRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $gitCommit) { throw "无法确定发布提交" }
}

Push-Location $workspace
$previousCargoBuildJobs = $env:CARGO_BUILD_JOBS
$env:CARGO_BUILD_JOBS = "2"
try {
  pnpm install --frozen-lockfile --network-concurrency=2 --child-concurrency=2
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败" }
  pnpm prepare:tauri
  if ($LASTEXITCODE -ne 0) { throw "Tauri 字体资源准备或 schema 审计失败" }
  if ($PersonalUse) {
    node scripts/requirements-traceability.mjs --check
  } else {
    node scripts/requirements-traceability.mjs --check --release
  }
  if ($LASTEXITCODE -ne 0) { throw "需求追踪门禁失败" }
  $traceRows = @(Import-Csv -LiteralPath (Join-Path $documentationRoot "需求追踪表.csv"))
  $externalPending = @($traceRows | Where-Object { $_.status -match "PENDING" })
  pnpm format:check
  if ($LASTEXITCODE -ne 0) { throw "Prettier 门禁失败" }
  pnpm lint
  if ($LASTEXITCODE -ne 0) { throw "ESLint 门禁失败" }
  pnpm typecheck
  if ($LASTEXITCODE -ne 0) { throw "TypeScript 门禁失败" }
  pnpm exec vitest run --maxWorkers=2
  if ($LASTEXITCODE -ne 0) { throw "前端测试失败" }
  pnpm exec playwright test --workers=1
  if ($LASTEXITCODE -ne 0) { throw "端到端测试失败" }
  cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
  if ($LASTEXITCODE -ne 0) { throw "Rust 格式门禁失败" }
  cargo clippy --manifest-path src-tauri/Cargo.toml --locked --workspace --all-targets --jobs 2 -- -D warnings
  if ($LASTEXITCODE -ne 0) { throw "Clippy 门禁失败" }
  cargo test --manifest-path src-tauri/Cargo.toml --locked --jobs 2
  if ($LASTEXITCODE -ne 0) { throw "Rust 测试失败" }
  node node_modules/@tauri-apps/cli/tauri.js build --target x86_64-pc-windows-msvc --no-bundle --ci -- --locked --jobs 2
  if ($LASTEXITCODE -ne 0) { throw "Tauri 发布构建失败" }
} finally {
  if ($null -eq $previousCargoBuildJobs) {
    Remove-Item Env:CARGO_BUILD_JOBS -ErrorAction SilentlyContinue
  } else {
    $env:CARGO_BUILD_JOBS = $previousCargoBuildJobs
  }
  Pop-Location
}

$exeSource = Join-Path $workspace "src-tauri\target\x86_64-pc-windows-msvc\release\vibe-prompt-recorder.exe"
if (-not (Test-Path -LiteralPath $exeSource)) { throw "未找到发布 EXE：$exeSource" }
New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
if (Test-Path -LiteralPath $packageRoot) {
  $resolvedStaging = (Resolve-Path -LiteralPath $stagingRoot).Path
  $resolvedPackage = (Resolve-Path -LiteralPath $packageRoot).Path
  if (-not $resolvedPackage.StartsWith($resolvedStaging + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理打包临时目录以外的路径"
  }
  Remove-Item -Recurse -Force -LiteralPath $resolvedPackage
}
New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot "resources\fonts\core") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot "LICENSES\fonts") | Out-Null
Copy-Item -LiteralPath $exeSource -Destination (Join-Path $packageRoot "提示词记录工具.exe")
Copy-Item -Path (Join-Path $workspace "src-tauri\resources\fonts\core\*") -Destination (Join-Path $packageRoot "resources\fonts\core")
Copy-Item -LiteralPath (Join-Path $workspace "src-tauri\resources\font-manifest.json") -Destination (Join-Path $packageRoot "resources")
Copy-Item -Path (Join-Path $workspace "src-tauri\resources\LICENSES\*") -Destination (Join-Path $packageRoot "LICENSES\fonts") -Recurse
Copy-Item -LiteralPath (Join-Path $documentationRoot "README-使用说明.md") -Destination $packageRoot
if ($PersonalUse) {
  $pendingLines = @($externalPending | ForEach-Object { "- ``$($_.id)``（$($_.status)）：$($_.notes)" })
  $buildStatus = @(
    "# $version 个人自用成品状态",
    "",
    "本目录由项目的 ``PersonalUse`` 受控打包通道生成，可供当前用户本机日常使用。它已通过本机自动化、Windows x64 Release 构建、包结构与哈希校验。",
    "",
    "本成品未做代码签名，也不宣称已完成公开分发所需的全部跨机器/物理环境验收。以下外部项保持原状态：",
    ""
  ) + $pendingLines + @(
    "",
    "这些项目不影响当前用户在已安装 WebView2 的本机使用；向第三方公开分发前仍须完成并更新验收报告。"
  )
  [IO.File]::WriteAllLines((Join-Path $packageRoot "BUILD-STATUS.md"), $buildStatus, [Text.UTF8Encoding]::new($false))
}
node (Join-Path $workspace "scripts\generate-third-party-notices.mjs") (Join-Path $packageRoot "LICENSES\third-party-licenses.txt")
if ($LASTEXITCODE -ne 0) { throw "第三方依赖许可清单生成失败" }

$lines = Get-ChildItem -Recurse -File -LiteralPath $packageRoot |
  Where-Object Name -ne "checksums.sha256" |
  Sort-Object FullName |
  ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($packageRoot, $_.FullName).Replace('\', '/')
    "$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant())  $relative"
  }
[IO.File]::WriteAllLines((Join-Path $packageRoot "checksums.sha256"), $lines, [Text.UTF8Encoding]::new($false))

& (Join-Path $PSScriptRoot "verify-portable.ps1") -PackageDirectory $packageRoot -ArtifactKind $artifactKind
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
& (Join-Path $PSScriptRoot "verify-portable.ps1") -ZipPath $zipPath -ArtifactKind $artifactKind
$zipBytes = (Get-Item -LiteralPath $zipPath).Length
if ($zipBytes -gt 100MB) { throw "便携 ZIP 超过 100 MiB：$zipBytes" }
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
[IO.File]::Move($zipPath, $releaseZipPath, $true)
$zipPath = $releaseZipPath
$shaPath = "$zipPath.sha256"
$shaTemporaryPath = "$shaPath.$runId.tmp"
[IO.File]::WriteAllText($shaTemporaryPath, "$zipHash  $([IO.Path]::GetFileName($zipPath))`n", [Text.UTF8Encoding]::new($false))
[IO.File]::Move($shaTemporaryPath, $shaPath, $true)

$dumpbinPath = (Get-Command dumpbin.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $dumpbinPath) {
  $vswhereCandidates = @(
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe" }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe" })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $vswhere = $vswhereCandidates | Select-Object -First 1
  if ($vswhere) {
    $dumpbinPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find "VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe" 2>$null | Select-Object -First 1)
  }
}
if ($dumpbinPath -and (Test-Path -LiteralPath $dumpbinPath)) {
  $packagedExe = Join-Path $packageRoot "提示词记录工具.exe"
  $dependencyLines = @(& $dumpbinPath /dependents $packagedExe) |
    ForEach-Object { ([string]$_).Replace($packagedExe, "提示词记录工具.exe", [StringComparison]::OrdinalIgnoreCase) }
  [IO.File]::WriteAllLines(
    (Join-Path $releaseRoot "dependencies-$version.txt"),
    $dependencyLines,
    [Text.UTF8Encoding]::new($false)
  )
} else {
  Write-Warning "未找到 dumpbin.exe；已跳过可选的 PE 依赖清单，便携包主体与校验不受影响"
}

$manifest = [ordered]@{
  schemaVersion = 2
  version = $version
  builtAt = [DateTime]::UtcNow.ToString("o")
  artifactKind = if ($PersonalUse) { "personal-use" } else { "formal-release" }
  artifactStatus = if ($PersonalUse -and $externalPending.Count -gt 0) { "LOCAL_PASS_EXTERNAL_PENDING" } elseif ($PersonalUse) { "LOCAL_PASS" } else { "FORMAL_RELEASE" }
  formalReleaseEligible = -not $PersonalUse
  externalAcceptanceClaimed = -not $PersonalUse
  distributionScope = if ($PersonalUse) { "current-user-personal-use" } else { "release" }
  sourceState = if ($PersonalUse) { "verified-working-tree" } else { "clean-git-commit" }
  target = "x86_64-pc-windows-msvc"
  codeSigning = "unsigned"
  executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot "提示词记录工具.exe")).Hash.ToLowerInvariant()
  pnpmLockSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $workspace "pnpm-lock.yaml")).Hash.ToLowerInvariant()
  cargoLockSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $workspace "src-tauri\Cargo.lock")).Hash.ToLowerInvariant()
  requirements = [ordered]@{
    total = $traceRows.Count
    unverified = @($traceRows | Where-Object { $_.status -eq "UNVERIFIED" }).Count
    externalPending = @($externalPending | ForEach-Object {
      [ordered]@{ id = $_.id; status = $_.status; notes = $_.notes }
    })
  }
  verification = [ordered]@{
    frozenInstall = "passed"
    formatLintTypecheck = "passed"
    unitAndRustTests = "passed"
    browserE2e = "passed"
    windowsX64ReleaseBuild = "passed"
    packageTreeAndReexpandedZip = "passed"
  }
  zip = [IO.Path]::GetFileName($zipPath)
  zipBytes = $zipBytes
  zipSha256 = $zipHash
}
if ($gitCommit) { $manifest.gitCommit = $gitCommit }
$manifestPath = Join-Path $releaseRoot "release-manifest.json"
$manifestTemporaryPath = "$manifestPath.$runId.tmp"
[IO.File]::WriteAllText($manifestTemporaryPath, ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
[IO.File]::Move($manifestTemporaryPath, $manifestPath, $true)

$currentReleaseFiles = @(
  [IO.Path]::GetFullPath($releaseZipPath),
  [IO.Path]::GetFullPath("$releaseZipPath.sha256"),
  [IO.Path]::GetFullPath((Join-Path $releaseRoot "dependencies-$version.txt")),
  [IO.Path]::GetFullPath($manifestPath)
)
$resolvedReleaseRoot = (Resolve-Path -LiteralPath $releaseRoot).Path
$obsoleteReleaseFiles = Get-ChildItem -LiteralPath $resolvedReleaseRoot -File | Where-Object {
  ($_.Name -like "提示词记录工具-*-portable.zip" -or
   $_.Name -like "提示词记录工具-*-portable.zip.sha256" -or
   $_.Name -like "dependencies-*.txt" -or
   $_.Name -like "release-manifest-*.json") -and
  $currentReleaseFiles -notcontains [IO.Path]::GetFullPath($_.FullName)
}
foreach ($file in $obsoleteReleaseFiles) {
  $resolvedFile = (Resolve-Path -LiteralPath $file.FullName).Path
  if (-not $resolvedFile.StartsWith($resolvedReleaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理发布目录以外的旧版文件"
  }
  Remove-Item -Force -LiteralPath $resolvedFile
}
$label = if ($PersonalUse) { "个人自用便携成品" } else { "正式便携发布" }
Write-Output "$label ZIP 已生成：$zipPath"
Write-Output "SHA-256：$zipHash"
} finally {
  if ($releaseLock) { $releaseLock.Dispose() }
  if (Test-Path -LiteralPath $lockPath) { Remove-Item -Force -LiteralPath $lockPath }
  if (Test-Path -LiteralPath $stagingRoot) {
    $resolvedWorkspace = (Resolve-Path -LiteralPath $workspace).Path
    $resolvedStaging = (Resolve-Path -LiteralPath $stagingRoot).Path
    if (-not $resolvedStaging.StartsWith($resolvedWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝清理开发目录以外的打包临时路径"
    }
    Remove-Item -Recurse -Force -LiteralPath $resolvedStaging
  }
}
