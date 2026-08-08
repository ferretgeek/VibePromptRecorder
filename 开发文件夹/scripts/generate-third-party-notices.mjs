import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(
  process.argv[2] ?? join(workspace, '.build-cache', 'third-party-licenses.txt'),
)
const target = 'x86_64-pc-windows-msvc'
const documentNamePattern = /^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:$|[._-])/i
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const fileSha256 = (path) => sha256(readFileSync(path))

function runJson(command, args, cwd, maxBuffer = 128 * 1024 * 1024) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(' ')} failed`)
  }
  return JSON.parse(result.stdout)
}

function pnpmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'pnpm', args }
  const cliCandidates = [
    process.env.npm_execpath,
    process.env.APPDATA
      ? join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
      : '',
  ].filter((candidate) => candidate && existsSync(candidate))
  const cli = cliCandidates[0]
  if (!cli) {
    throw new Error('找不到 pnpm CLI；请通过 packageManager 指定的 pnpm 运行发布流程')
  }
  return { command: process.execPath, args: [cli, ...args] }
}

function repositoryUrl(metadata) {
  if (typeof metadata.repository === 'string') return metadata.repository
  if (typeof metadata.repository?.url === 'string') return metadata.repository.url
  return typeof metadata.homepage === 'string' ? metadata.homepage : ''
}

function authorText(value, fallback) {
  const entries = Array.isArray(value) ? value : value ? [value] : []
  const names = entries
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (typeof entry?.name === 'string') return entry.name
      return ''
    })
    .filter(Boolean)
  return names.join(', ') || `${fallback} contributors`
}

function normalizeDocument(path) {
  const bytes = readFileSync(path)
  if (bytes.includes(0)) throw new Error(`许可文件不是可发布的文本格式：${path}`)
  const content = bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trimEnd()
  if (!content) throw new Error(`许可文件为空：${path}`)
  return `${content}\n`
}

function collectDocuments(packageDirectory, explicitFiles = []) {
  const paths = new Set()
  for (const explicit of explicitFiles) {
    if (!explicit) continue
    paths.add(isAbsolute(explicit) ? explicit : resolve(packageDirectory, explicit))
  }
  for (const entry of readdirSync(packageDirectory, { withFileTypes: true })) {
    if (entry.isFile() && documentNamePattern.test(entry.name)) {
      paths.add(join(packageDirectory, entry.name))
    }
  }
  return [...paths]
    .sort(compareText)
    .map((path) => ({ name: basename(path), content: normalizeDocument(path) }))
}

function collectJavaScriptPackages() {
  const invocation = pnpmInvocation(['licenses', 'list', '--prod', '--json', '--long'])
  const grouped = runJson(invocation.command, invocation.args, workspace)
  const packages = new Map()
  for (const entries of Object.values(grouped)) {
    for (const entry of entries) {
      for (const packageDirectory of entry.paths ?? []) {
        const metadata = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
        const key = `${metadata.name}@${metadata.version}`
        if (packages.has(key)) continue
        packages.set(key, {
          ecosystem: 'JavaScript',
          name: metadata.name,
          version: metadata.version,
          license:
            typeof metadata.license === 'string'
              ? metadata.license
              : typeof entry.license === 'string'
                ? entry.license
                : 'SEE PACKAGE',
          repository: repositoryUrl(metadata),
          authors: authorText(metadata.author ?? metadata.contributors, metadata.name),
          documents: collectDocuments(packageDirectory),
        })
      }
    }
  }
  return [...packages.values()]
}

function collectRustPackages() {
  const metadata = runJson(
    'cargo',
    [
      'metadata',
      '--locked',
      '--format-version',
      '1',
      '--filter-platform',
      target,
      '--manifest-path',
      join(workspace, 'src-tauri', 'Cargo.toml'),
    ],
    workspace,
  )
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
  const workspaceMembers = new Set(metadata.workspace_members)
  const included = new Set()
  const pending = [metadata.resolve.root]

  while (pending.length) {
    const id = pending.pop()
    if (!id || included.has(id)) continue
    included.add(id)
    const node = nodes.get(id)
    for (const dependency of node?.deps ?? []) {
      if (dependency.dep_kinds.some((kind) => kind.kind !== 'dev')) pending.push(dependency.pkg)
    }
  }

  return [...included]
    .filter((id) => !workspaceMembers.has(id))
    .map((id) => {
      const pkg = packages.get(id)
      if (!pkg) throw new Error(`cargo metadata 缺少依赖包：${id}`)
      const packageDirectory = dirname(pkg.manifest_path)
      return {
        ecosystem: 'Rust',
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? 'SEE PACKAGE',
        repository: pkg.repository ?? pkg.homepage ?? '',
        authors: authorText(pkg.authors, pkg.name),
        documents: collectDocuments(packageDirectory, [pkg.license_file]),
      }
    })
}

const packages = [...collectJavaScriptPackages(), ...collectRustPackages()].sort((left, right) =>
  compareText(
    `${left.ecosystem}\0${left.name}\0${left.version}`,
    `${right.ecosystem}\0${right.name}\0${right.version}`,
  ),
)

const bundledDocuments = packages.flatMap((pkg) => pkg.documents)
const standardApache = bundledDocuments.find((document) =>
  /Apache License\s+Version 2\.0/i.test(document.content),
)?.content
const standardMpl = bundledDocuments.find((document) =>
  /Mozilla Public License Version 2\.0/i.test(document.content),
)?.content

function mitText(pkg) {
  return `MIT License

Copyright (c) ${pkg.authors}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
}

function bsdThreeClauseText(pkg) {
  return `BSD 3-Clause License

Copyright (c) ${pkg.authors}
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
`
}

function zlibText(pkg) {
  return `zlib License

Copyright (c) ${pkg.authors}

This software is provided 'as-is', without any express or implied warranty.
In no event will the authors be held liable for any damages arising from the
use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a
   product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
`
}

const boostText = `Boost Software License - Version 1.0 - August 17th, 2003

Permission is hereby granted, free of charge, to any person or organization
obtaining a copy of the software and accompanying documentation covered by
this license (the "Software") to use, reproduce, display, distribute,
execute, and transmit the Software, and to prepare derivative works of the
Software, and to permit third-parties to whom the Software is furnished to do
so, all subject to the following:

The copyright notices in the Software and this entire statement, including
the above license grant, this restriction and the following disclaimer, must
be included in all copies of the Software, in whole or in part, and all
derivative works of the Software, unless such copies or derivative works are
solely in the form of machine-executable object code generated by a source
language processor.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO EVENT
SHALL THE COPYRIGHT HOLDERS OR ANYONE DISTRIBUTING THE SOFTWARE BE LIABLE FOR
ANY DAMAGES OR OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
`

function fallbackDocuments(pkg) {
  const expression = pkg.license
  const documents = []
  if (/\bMIT\b/i.test(expression)) {
    documents.push({ name: 'SPDX-MIT.txt', content: mitText(pkg) })
  }
  if (/\bApache-2\.0\b/i.test(expression)) {
    if (!standardApache) throw new Error('依赖图中找不到 Apache-2.0 标准正文')
    documents.push({ name: 'SPDX-Apache-2.0.txt', content: standardApache })
  }
  if (/\bMPL-2\.0\b/i.test(expression)) {
    if (!standardMpl) throw new Error('依赖图中找不到 MPL-2.0 标准正文')
    documents.push({ name: 'SPDX-MPL-2.0.txt', content: standardMpl })
  }
  if (/\bBSD-3-Clause\b/i.test(expression)) {
    documents.push({ name: 'SPDX-BSD-3-Clause.txt', content: bsdThreeClauseText(pkg) })
  }
  if (/\bBSL-1\.0\b/i.test(expression)) {
    documents.push({ name: 'SPDX-BSL-1.0.txt', content: boostText })
  }
  if (/\bZlib\b/i.test(expression)) {
    documents.push({ name: 'SPDX-Zlib.txt', content: zlibText(pkg) })
  }
  if (!documents.length) {
    throw new Error(
      `${pkg.ecosystem} 依赖 ${pkg.name}@${pkg.version} 缺少许可原文，且无法从声明补全：${expression}`,
    )
  }
  return documents
}

for (const pkg of packages) {
  if (pkg.documents.length === 0) pkg.documents = fallbackDocuments(pkg)
}

const documents = new Map()
for (const pkg of packages) {
  pkg.documentHashes = pkg.documents.map((document) => {
    const hash = sha256(document.content)
    if (!documents.has(hash)) documents.set(hash, document.content)
    return `${document.name}=${hash}`
  })
}

const packageRows = packages.map(
  (pkg) =>
    `${pkg.name}@${pkg.version} | ${pkg.license} | ${pkg.repository} | ${pkg.documentHashes.join(', ')}`,
)
const documentSections = [...documents.entries()]
  .sort(([left], [right]) => compareText(left, right))
  .map(
    ([hash, content]) =>
      `--------------------------------------------------------------------------------
许可正文 SHA-256：${hash}
--------------------------------------------------------------------------------
${content}`,
  )

const text = `提示词记录工具第三方依赖许可与通知

本文件由锁定的 pnpm 生产依赖图和 Windows x64 Cargo 非开发依赖图自动生成。
相同许可正文按 SHA-256 去重；每个依赖行末列出其随附正文文件名与正文哈希。
优先收录依赖归档中的 LICENSE/COPYING/NOTICE；若上游归档未附正文，则根据包的
SPDX 声明补入完整标准正文，并使用 SPDX- 前缀标明来源。
本文件不包含生成时间，因此相同源码、锁文件和依赖缓存会生成相同字节内容。
内置字体许可另见 LICENSES/fonts/。

生成依据
========
目标平台：${target}
pnpm-lock.yaml SHA-256：${fileSha256(join(workspace, 'pnpm-lock.yaml'))}
Cargo.lock SHA-256：${fileSha256(join(workspace, 'src-tauri', 'Cargo.lock'))}
JavaScript 发布依赖：${packages.filter((pkg) => pkg.ecosystem === 'JavaScript').length}
Rust 发布依赖：${packages.filter((pkg) => pkg.ecosystem === 'Rust').length}
去重后许可/通知正文：${documents.size}

依赖与正文映射
==============
格式：包名@版本 | SPDX/上游许可声明 | 上游地址 | 文件名=正文 SHA-256

${packageRows.join('\n')}

许可与通知正文
==============

${documentSections.join('\n')}
`

mkdirSync(dirname(output), { recursive: true })
const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.${randomUUID()}.tmp`)
try {
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, output)
} finally {
  rmSync(temporary, { force: true })
}
console.log(`第三方许可材料已生成：${packages.length} 个发布依赖，${documents.size} 份去重正文`)
