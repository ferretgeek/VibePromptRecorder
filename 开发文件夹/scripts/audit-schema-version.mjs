import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dbSource = readFileSync(join(workspace, 'src-tauri', 'src', 'db.rs'), 'utf8')
const auditSource = readFileSync(
  join(workspace, 'src-tauri', 'migrations', '0001_initial.sql'),
  'utf8',
)

const runtimeVersion = dbSource.match(/pub const SCHEMA_VERSION:\s*i64\s*=\s*(\d+);/)?.[1]
const auditVersion = auditSource.match(/--\s*schema_version\s*=\s*(\d+)/)?.[1]

if (!runtimeVersion) throw new Error('无法从 db.rs 读取 SCHEMA_VERSION')
if (!auditVersion) throw new Error('迁移审计文件缺少 schema_version 标记')
if (runtimeVersion !== auditVersion) {
  throw new Error(`数据库 schema 版本漂移：runtime=${runtimeVersion}, audit=${auditVersion}`)
}

for (let version = 1; version <= Number(runtimeVersion); version += 1) {
  if (
    !new RegExp(`INSERT OR IGNORE INTO schema_migrations[\\s\\S]*?VALUES \\(${version},`).test(
      dbSource,
    )
  ) {
    throw new Error(`db.rs 缺少 schema v${version} 的迁移完成标记`)
  }
  if (!new RegExp(`^-- v${version}:`, 'm').test(auditSource)) {
    throw new Error(`迁移审计文件缺少 v${version} 的说明`)
  }
}

console.log(`数据库 schema 审计通过：v${runtimeVersion}`)
