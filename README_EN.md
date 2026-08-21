<p align="center">
  <img src="./docs/images/social-preview.png" alt="Prompt journal — an offline, local-first prompt timeline" width="100%" />
</p>

# Prompt journal

[中文](./README.md) · English

[![CI](https://github.com/ferretgeek/prompt-journal/actions/workflows/ci.yml/badge.svg)](https://github.com/ferretgeek/prompt-journal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-2563eb.svg)](./LICENSE)
[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?logo=windows)](#development-and-verification)

> Keep the prompts you and the model actually worked through, iteration by iteration.

## Why this exists

When you build with AI, the valuable artifact often isn't the final code. It's the middle: the third rewording that finally landed, the "don't touch the existing interface" line that made it stop overreaching.

That work usually evaporates. Close the chat window and it's gone; scrolling back through history is archaeology; start a new project and you're guessing again.

So: a local prompt notebook. Organized by project, drafts autosaved, one action to finish the current iteration and begin the next, everything searchable, exportable, and backed up.

It **calls no model API, generates no answers, requires no account, and uploads nothing.** Its only job is to keep the process.

## Interface

The screenshot comes from a temporary empty data directory containing only synthetic examples written for this public preview — no real prompts were used or copied.

<p align="center">
  <img src="./docs/images/app-preview.png" alt="Desktop app preview" width="100%" />
</p>

## What it does

- **Projects and iterations** — separate workspaces per project, autosaved drafts, and one action to close the current iteration and start the next.
- **Two ways to edit** — WYSIWYG or raw Markdown, with syntax highlighting and sanitized previews, switchable at any time.
- **Global search** — one query across project names, notes, drafts, completed iterations, and code.
- **Doesn't lose your work** — SQLite WAL, atomic writes, close protection, conflict handling, and crash recovery.
- **Portable** — project import/export, full backups, restore, and data-directory migration.
- **Comfortable** — six themes, with separate UI / body / code fonts, always-on-top, and a keyboard-driven workflow.

## Development and verification

Requires Node.js 22, pnpm 10, Rust 1.95+, Windows WebView2, and a Tauri 2 build environment.

```powershell
cd 开发文件夹
pnpm install --frozen-lockfile
pnpm verify
```

Web-only tests and build:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build:web
```

## Worth noting technically

**"Doesn't lose your work" is where the effort went.** SQLite runs in WAL mode and every write is an atomic replacement. Closing the window with unsaved content is intercepted. Concurrent edits go through conflict handling rather than silently overwriting. After an abnormal exit, restarting recovers the pre-crash state. This chain got more attention than any feature in the app.

**Markdown previews are sanitized.** Local previews clean user content, and remote images load under an explicit policy only when user content references them — an offline tool shouldn't quietly make a network request because you pasted some Markdown.

**The two editors are lazy-loaded.** The WYSIWYG core and the source core are never resident at the same time; each loads on switch, so an occasionally used mode doesn't hold memory forever.

**There is deliberately no "server edition."** Product data and SQLite transactions depend on single-machine file locking, Windows permissions, and a local WebView2. So there is **no** shared data directory and no web console — building one would produce something that looks multi-device but silently corrupts data. The correct way to move between machines is a full directory copy after quitting, or a verified backup.

**Don't put the active data directory on a network location.** UNC paths, mapped network drives, and live-sync folders (OneDrive and friends) break file-locking semantics. This is documented, and the app warns about it.

Full usage instructions are in [`需求和方案文件夹/README-使用说明.md`](./需求和方案文件夹/README-使用说明.md); architecture, recovery semantics, and acceptance facts are in [`需求和方案文件夹/README.md`](./需求和方案文件夹/README.md).

## Layout

```text
开发文件夹/              React, TypeScript, Tauri, and Rust sources
需求和方案文件夹/        Usage guide, architecture decisions, traceability, acceptance reports
docs/images/             Redacted previews and the social preview
成品文件夹/              Local builds and user data; always git-ignored
```

## What it doesn't do

- No AI model integration, no answer generation, no API calls on your behalf.
- No account system, cloud sync, or telemetry.
- No server edition or shared data directory (see above for why).
- The first public version ships source only; local portable builds, user databases, and historical backups are never uploaded.

## More documentation

[Install, upgrade, backup, restore, troubleshooting](./docs/OPERATIONS.md) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Security policy](./SECURITY.md)

## License

MIT License — see [LICENSE](./LICENSE).
