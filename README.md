<p align="center">
  <img src="./docs/images/social-preview.png" alt="提示词手账 — 本地离线的提示词时间线" width="100%" />
</p>

# 提示词手账

中文 · [English](./README_EN.md)

[![CI](https://github.com/ferretgeek/prompt-journal/actions/workflows/ci.yml/badge.svg)](https://github.com/ferretgeek/prompt-journal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-2563eb.svg)](./LICENSE)
[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?logo=windows)](#开发与验证)

> 把你和 AI 一轮一轮改出来的提示词留下来。

## 为什么会需要它

用 AI 写代码时，真正值钱的东西往往不是最后那份代码，而是中间那几轮：你第三次改了措辞它才做对，你补上那句"不要动现有接口"之后它才收手。

但这些东西通常留不下来。对话窗口一关就散了，翻历史记录像考古，换个项目又得从零试。

所以做了这个：一个纯本地的提示词记事本。按项目分开，每一轮草稿自动保存，写完一键"完成本轮"再继续下一轮，全部可搜索、可导出、可备份。

它**不调用任何模型 API、不生成回答、不要求账号、不上传任何东西**。它只负责把过程留住。

## 界面

截图来自一个临时空数据目录，里面只有为开源展示专门写的合成示例——没有使用或复制任何真实提示词。

<p align="center">
  <img src="./docs/images/app-preview.png" alt="桌面应用预览" width="100%" />
</p>

## 它能做什么

- **项目与轮次** — 按项目分开管理，草稿自动保存，一键结束当前轮并开始下一轮。
- **两种编辑方式** — 所见即所得，或者直接写 Markdown 源码；代码高亮、安全预览，随时切换。
- **全局搜索** — 一次搜遍项目名、备注、草稿、已完成的历史轮次和代码内容。
- **不会丢** — SQLite WAL、原子写入、关闭保护、冲突处理和崩溃恢复。
- **带得走** — 项目导入导出、完整备份、恢复，以及数据目录迁移。
- **看得顺眼** — 六套主题，界面字体 / 正文字体 / 代码字体可以分别设，支持窗口置顶和键盘工作流。

## 开发与验证

需要 Node.js 22、pnpm 10、Rust 1.95+、Windows WebView2 与 Tauri 2 构建环境。

```powershell
cd 开发文件夹
pnpm install --frozen-lockfile
pnpm verify
```

只跑 Web 端的测试和构建：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build:web
```

## 技术上值得一提的地方

**"不会丢"是认真做的。** SQLite 开 WAL，所有写入走原子替换；关闭窗口时如果有未保存内容会拦下来；两处同时修改会走冲突处理流程而不是静默覆盖；异常退出后重启能恢复到崩溃前状态。这一整条链路是这个项目花时间最多的地方。

**Markdown 预览是清洗过的。** 本地预览会对用户内容做净化，远程图片只在用户内容明确引用时才按安全策略加载——一个离线工具不应该因为你粘了一段 Markdown 就悄悄发出网络请求。

**双编辑器是按需加载的。** 所见即所得内核和源码内核不会同时驻留，切换时才载入，避免为了一个偶尔用的模式一直吃内存。

**刻意不做"服务器版"。** 产品数据与 SQLite 事务依赖单机文件锁、Windows 权限和本地 WebView2。所以这里**没有**共享数据目录或 Web 管理台——那样做只会得到一个看起来能多设备协作、实际会静默损坏数据的东西。多设备迁移的正确做法是退出应用后整目录复制，或用经过校验的备份。

**活动数据目录不要放在网络位置。** UNC 路径、映射网络驱动器和实时同步目录（OneDrive 之类）都会破坏文件锁语义。这一点写进了文档，也在应用里做了提示。

完整使用说明见 [`需求和方案文件夹/README-使用说明.md`](./需求和方案文件夹/README-使用说明.md)；架构、恢复语义和验收事实见 [`需求和方案文件夹/README.md`](./需求和方案文件夹/README.md)。

## 目录

```text
开发文件夹/              React、TypeScript、Tauri 与 Rust 源码
需求和方案文件夹/        使用说明、架构决策、需求追踪表与验收报告
docs/images/             脱敏后的真实预览与分享封面
成品文件夹/              本机成品与用户数据；始终被 Git 忽略
```

## 它不做什么

- 不接入任何 AI 模型，不生成回答，不帮你调用 API。
- 没有账号系统、云同步或遥测。
- 不提供服务器版或共享数据目录（原因见上）。
- 首个公开版本只发布源码；本机便携包、用户数据库和历史备份不会上传。

## 更多文档

[安装、升级、备份、恢复、排错](./docs/OPERATIONS.md) · [版本变更](./CHANGELOG.md) · [参与开发](./CONTRIBUTING.md) · [安全策略](./SECURITY.md)

## 许可

MIT License，见 [LICENSE](./LICENSE)。
