# 参与贡献 / Contributing

提交改动前请阅读 [`AGENTS.md`](./AGENTS.md)、[`SECURITY.md`](./SECURITY.md) 与 [`需求和方案文件夹/README.md`](./需求和方案文件夹/README.md)。安全问题使用 GitHub 私密漏洞报告入口，不要创建公开 Issue。

Before contributing, read [`AGENTS.md`](./AGENTS.md), [`SECURITY.md`](./SECURITY.md), and [`需求和方案文件夹/README.md`](./需求和方案文件夹/README.md). Report vulnerabilities privately through GitHub rather than opening a public issue.

## 约束 / Contract

- 保持 Windows 本地离线定位；不得擅自增加模型 API、账号、遥测、云同步、共享活动数据库或后台常驻服务。
- 不得提交 `成品文件夹/`、真实提示词、数据库、备份、本机路径、日志、Token、用户字体或私人截图。测试、预览和夹具必须从零生成。
- 数据库 schema、项目包与备份格式保持向后兼容；迁移必须同步版本、恢复说明、需求追踪和回归测试。
- UI 改动需覆盖六套主题、普通桌面和窄窗口、键盘焦点、长文本与减少动态效果。
- 新依赖需要说明必要性、固定版本并检查许可与通告；字体必须通过白名单、哈希和许可审计。

- Keep the product offline and Windows-local. Do not add model APIs, accounts, telemetry, cloud sync, a shared live database, or a resident background service without explicit product authorization.
- Never commit `成品文件夹/`, real prompts, databases, backups, machine paths, logs, tokens, user fonts, or private screenshots. Generate tests, previews, and fixtures from scratch.
- Keep database schemas, project archives, and backup formats backward-compatible. Any migration must update versions, recovery guidance, requirement traceability, and regression tests.
- UI changes must cover all six themes, normal and narrow windows, keyboard focus, long text, and reduced motion.
- Explain and pin new dependencies, then check licenses and advisories. Fonts must pass allowlist, hash, and license audits.

## 验证 / Verification

```powershell
cd 开发文件夹
pnpm install --frozen-lockfile
pnpm verify
```

只改前端时至少运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build:web`。涉及界面时还需运行 `pnpm test:e2e` 并检查代表性桌面与窄屏；涉及 Rust、数据、恢复、字体或打包时运行完整 `pnpm verify` 和对应便携包门禁。Pull Request 请列出用户影响、验证环境、命令、结果与未覆盖项。

For front-end-only changes, run at least `format:check`, lint, type checking, tests, and the web build. UI work also requires the E2E suite and representative desktop/narrow-window review. Rust, data, recovery, fonts, or packaging changes require the complete verification and relevant portable-package gates. Pull requests should state user impact, environment, commands, results, and uncovered areas.
