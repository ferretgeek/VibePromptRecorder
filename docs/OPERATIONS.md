# Vibe Prompt Recorder 运维指南 / Operations Guide

## 架构与服务器边界 / Architecture and server boundary

应用由 Tauri 2 原生宿主、Windows WebView2 前端与本地 SQLite WAL 数据库组成。活动数据使用单实例锁、原子文件替换、Windows 文件权限和本机路径语义；应用不调用模型 API，也不提供账号、遥测、云同步或入站网络服务。

当前没有服务器版，这是明确的安全和一致性边界：把同一 SQLite/WAL 目录放在 SMB、UNC、映射盘或实时同步目录会破坏单机锁与崩溃恢复假设，程序会拒绝或警告这些位置。多设备使用应在程序完全退出后迁移完整便携目录，或导出/恢复经校验的 `.vcpbackup`，不能并发共享活动数据库。若未来实现服务器形态，需要独立的认证、授权、并发事务、传输加密、限流与迁移设计，不能把本地 Web 构建直接暴露为服务。

The app combines a Tauri 2 native host, a Windows WebView2 front end, and a local SQLite WAL database. Active data relies on a single-instance lock, atomic file replacement, Windows permissions, and local-path semantics. It calls no model API and exposes no account, telemetry, cloud-sync, or inbound network service.

There is intentionally no server edition today. Sharing one SQLite/WAL directory over SMB, UNC, a mapped drive, or real-time sync would violate locking and crash-recovery assumptions; such locations are rejected or warned about. Move between devices only after complete exit by copying the whole portable directory, or use a validated `.vcpbackup`. Never concurrently share the live database. A future server form would require its own authentication, authorization, concurrent transactions, transport security, rate limiting, and migration design—not a publicly exposed local web build.

## 安装与首次运行 / Install and first run

- 源码构建需要 Node.js 22、pnpm 10、Rust 1.95+、Windows WebView2 与 Tauri 2 前置环境；在 `开发文件夹/` 执行 `pnpm install --frozen-lockfile` 和 `pnpm verify`。
- 便携包必须整体解压到本机可写位置，不能直接在 ZIP 中运行。首次公开版本只提供源码；不要把来源不明的便携 EXE 当作官方分发。
- 初次启动会在便携目录创建 `data/`。若目录不可写，可通过受支持的数据目录选择流程迁移，但不要选择网络盘或实时同步目录。

- Source builds require Node.js 22, pnpm 10, Rust 1.95+, Windows WebView2, and Tauri 2 prerequisites. Run `pnpm install --frozen-lockfile` and `pnpm verify` in `开发文件夹/`.
- Extract the complete portable package to a writable local directory; never run inside the ZIP. The first public release ships source only, so do not treat an unverified portable EXE as an official binary.
- First launch creates `data/` beside the portable app. If the location is not writable, use the supported data-root migration flow but never select a network or live-sync directory.

## 升级、备份与恢复 / Upgrade, backup, and restore

1. 完全退出应用并在任务管理器确认没有残留进程。
2. 在“设置 → 数据与备份”创建手动完整 `.vcpbackup`，再复制整个旧 `data/` 到独立位置。
3. 只替换 EXE、资源、许可和说明文件；不要删除或覆盖 `data/`，也不要混用新旧资源。新旧包的签名/哈希和发布清单应能对应。
4. 启动后检查项目、当前草稿、正式轮次、设置、字体和搜索，再执行一次测试备份。
5. 恢复 `.vcpbackup` 时，程序会先验证格式版本、路径、大小、SHA-256、SQLite 完整性、外键、业务语义和 FTS 原文，并创建恢复前快照；实际切换在下次启动、业务窗口创建前完成。失败时保留整个现场，不要手工删除恢复状态或工作目录。

1. Exit completely and confirm no process remains.
2. Create a manual full `.vcpbackup` under Settings, then copy the entire old `data/` directory to a separate location.
3. Replace only immutable executable, resource, license, and documentation files. Never delete or overwrite `data/` or mix old and new resources. Verify package hashes/manifests when available.
4. After launch, check projects, the active draft, completed rounds, settings, fonts, and search, then create one test backup.
5. Restore validates format, paths, sizes, SHA-256, SQLite integrity, foreign keys, business semantics, and FTS content and creates a pre-restore snapshot. The switch happens before the business window on the next launch. Preserve the whole recovery scene on failure; do not manually delete state or work directories.

## 健康检查 / Health checks

- 启动无恢复错误，项目和当前轮次正常加载；编辑后等待保存，再关闭重开确认内容一致。
- 搜索、Markdown/所见即所得切换、项目导入导出、手动完整备份与测试恢复均成功。
- `pnpm verify` 全部通过；界面改动额外执行 `pnpm test:e2e`。字体清单、哈希和许可审计必须为零未解释差异。
- 数据目录位于本机磁盘且剩余空间充足；活动时只有一个应用实例；备份另存于访问受控的位置。

- Launch without recovery errors; load a project/round, edit and wait for save, then reopen and confirm exact content.
- Verify search, Markdown/WYSIWYG switching, project import/export, a manual full backup, and a test restore.
- `pnpm verify` must pass; UI changes also require `pnpm test:e2e`. Font manifest, hashes, and licenses must have no unexplained differences.
- Keep the data root on a local disk with sufficient free space, run one app instance, and store backups in a separately controlled location.

## 故障排查 / Troubleshooting

- **启动失败：** 不要创建空目录覆盖现场。复制完整 `data/`、错误文本和发布清单到私有位置，再核对磁盘、权限、WebView2、schema 与待恢复状态。
- **保存失败或冲突：** 保持应用运行，先复制缓冲或导出恢复 Markdown；重试保存。revision 冲突优先“保留两份”。
- **数据目录被拒绝：** 移到本机 NTFS 可写目录；不要绕过 UNC、映射盘或同步目录检查。
- **界面或字体异常：** 检查 WebView2 和字体文件完整性；缺失用户字体时选择内置字体，不要编辑字体 manifest 规避哈希。
- **恢复中断：** 原样保留 `data/`、`recovery/` 和备份，重新启动让状态机继续或回滚；详情见 [`需求和方案文件夹/恢复与迁移说明.md`](../需求和方案文件夹/恢复与迁移说明.md)。

- **Startup failure:** Never create an empty directory over the scene. Privately copy the complete `data/`, error text, and release manifest, then check storage, permissions, WebView2, schema, and pending-restore state.
- **Save failure/conflict:** Keep the app open and copy the buffer or export recovery Markdown before retrying. Prefer “keep both” for revision conflicts.
- **Rejected data root:** Move to a writable local NTFS directory. Do not bypass UNC, mapped-drive, or sync-folder checks.
- **UI/font issue:** Check WebView2 and font integrity. Select a bundled font if a user font is missing; never edit the font manifest to bypass its hash.
- **Interrupted restore:** Preserve `data/`, `recovery/`, and backups unchanged and restart so the state machine can continue or roll back. See the detailed recovery guide linked above.

## 卸载 / Uninstall

先创建并在独立位置验证完整备份，完全退出应用，然后删除整个便携程序目录。若数据目录已迁移到其他本机位置，需要单独删除；`%LOCALAPPDATA%\VibePromptRecorder\` 只保存不含提示词正文的数据定位与初始化侧锁，也可在确认不再使用后删除。删除活动 `data/` 会永久失去提示词、设置、字体和本地备份，仓库无法恢复。

Create and verify a full backup in a separate location, exit completely, and delete the portable app directory. Remove a separately migrated local data root explicitly. `%LOCALAPPDATA%\VibePromptRecorder\` contains locators and initialization side-locks rather than prompt bodies and may be removed after confirming the app is no longer used. Deleting active `data/` permanently removes prompts, settings, fonts, and local backups; the repository cannot restore them.
