# 变更记录 / Changelog

完整版本历史以 [`需求和方案文件夹/CHANGELOG.md`](./需求和方案文件夹/CHANGELOG.md) 为事实源；本文件提供常规仓库入口。

The complete release history is maintained in [`需求和方案文件夹/CHANGELOG.md`](./需求和方案文件夹/CHANGELOG.md); this file is the conventional repository entry point.

## Unreleased

- 延迟加载代码高亮核心以及搜索/设置界面；生产入口 JavaScript 从 907.13 kB（gzip 287.37 kB）降至 302.29 kB（gzip 98.13 kB）。
- 收紧构建块大小门禁，并补齐贡献、运维和 Windows/服务器边界文档。
- Lazy-loaded the syntax-highlighting core and search/settings UI. The production entry JavaScript fell from 907.13 kB (287.37 kB gzip) to 302.29 kB (98.13 kB gzip).
- Tightened the chunk-size gate and added contribution, operations, and Windows/server-boundary documentation.

## 0.1.4 — 2026-07-31

审查闭环与安全加固版：修复编辑/关闭竞态、恢复语义、文件读取权限和字体完整性问题，并保持 SQLite schema v2、项目包和完整备份格式 v1 兼容。完整逐项记录见上方历史文件。

Audit and security-hardening release: fixed editing/close races, restore semantics, file-read permissions, and font integrity while retaining SQLite schema v2 and v1 project/full-backup compatibility. See the complete history linked above.
