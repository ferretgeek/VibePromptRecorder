# 第三方字体许可与打包政策

发布包只允许包含 `resources/font-manifest.json` 白名单列出的字体文件；该 manifest 是字体家族、文件名、字重、大小、SHA-256 和许可路径的唯一真源。构建前使用 `pnpm audit:fonts` 校验，任何白名单外字体、哈希变化、缺失许可或极端字重都会阻断打包。

## 当前核心字体与许可

| 字体家族                       | 随包许可文件                    | 使用说明                                                              |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------- |
| MiSans                         | `MiSans-License-zh.pdf`         | 本软件使用 MiSans；不得修改字体，也不得把字体文件脱离本软件单独分发。 |
| HarmonyOS Sans SC              | `HarmonyOS-Sans-SC-LICENSE.txt` | 仅按许可随软件嵌入和再分发；不得修改或脱离软件单独分发。              |
| Mona Sans                      | `Mona-Sans-OFL-1.1.txt`         | 按 SIL Open Font License 1.1 使用。                                   |
| Sarasa Mono SC / Sarasa Gothic | `Sarasa-Gothic-OFL-1.1.txt`     | 按 SIL Open Font License 1.1 使用。                                   |

核心包当前使用 4 个家族、10 个字体文件；实际文件和哈希以同版本 `font-manifest.json` 为准，不在本说明中重复维护易漂移的清单。

用户通过应用导入的字体位于其私人 `data/fonts/imported/`，不属于随包核心字体，也不由应用替用户声明授权。用户应自行确认其拥有本机使用和备份该字体的权利；未来公开分发应用或私人字体前必须重新审查授权。
