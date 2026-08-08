# 版本化发布清单

本目录保存成品 manifest 的版本化只读副本，便于文档、需求追踪和历史审计引用。运行时应以 `成品文件夹/发布包/release-manifest.json` 和对应 ZIP 的实际哈希为准。

最近复核：2026-07-31。0.1.4 ZIP 已完成逐文件校验、现有数据原生启停和外层 SHA-256 对照，结果与本目录版本化副本一致。

- `release-manifest-0.1.4.json`：当前唯一版本化清单，schema v2，明确保留外部待验项。
- 发布目录中的 `release-manifest.json` 是同一成品的当前入口；旧版独立清单已清理，历史变化统一见 `CHANGELOG.md`。

正式公开发布与个人自用成品必须使用不同的 `artifactKind` / `artifactStatus`，不得通过修改本目录副本改变真实成品身份。
