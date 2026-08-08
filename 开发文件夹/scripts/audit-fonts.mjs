import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(workspace, 'src-tauri', 'resources', 'font-manifest.json')
const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'))
const sourceLicenseDirectory = join(workspace, 'src-tauri', 'resources', 'LICENSES')
const sourceDirectory = join(workspace, 'public', 'fonts')
const targetDirectory = join(workspace, 'src-tauri', 'resources', 'fonts', 'core')
const distFonts = join(workspace, 'dist', 'fonts')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.generatedForVersion !== packageJson.version) {
  throw new Error(
    `字体 manifest 版本 ${manifest.generatedForVersion} 与应用版本 ${packageJson.version} 不一致`,
  )
}
for (const family of manifest.families) {
  if (!family.redistributionStatus?.trim()) {
    throw new Error(`字体缺少再分发状态：${family.family}`)
  }
  const prefix = 'LICENSES/fonts/'
  if (!family.licenseFile?.startsWith(prefix)) {
    throw new Error(`字体许可路径必须位于 ${prefix}：${family.family}`)
  }
  const licenseName = family.licenseFile.slice(prefix.length)
  if (!licenseName || basename(licenseName) !== licenseName) {
    throw new Error(`字体许可文件名不安全：${family.licenseFile}`)
  }
  const sourceLicense = join(sourceLicenseDirectory, licenseName)
  if (!existsSync(sourceLicense) || statSync(sourceLicense).size === 0) {
    throw new Error(`字体许可文件缺失或为空：${family.licenseFile}`)
  }
  if (licenseName.toLowerCase().endsWith('.txt') && readFileSync(sourceLicense).includes(0)) {
    throw new Error(`字体许可文件含 NUL 填充或损坏内容：${family.licenseFile}`)
  }
}
const files = manifest.families.flatMap((family) => family.files)
const expectedNames = files.map((file) => file.file).sort()
const actualNames = readdirSync(sourceDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort()

if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
  throw new Error(
    `核心字体白名单与 public/fonts 不一致\nexpected=${expectedNames.join(',')}\nactual=${actualNames.join(',')}`,
  )
}

let totalBytes = 0
for (const file of files) {
  const source = join(sourceDirectory, file.file)
  const size = statSync(source).size
  const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex')
  if (size !== file.bytes || sha256 !== file.sha256) {
    throw new Error(`字体完整性校验失败：${file.file}`)
  }
  totalBytes += size
}
if (totalBytes !== manifest.policy.totalBytes) {
  throw new Error(`字体总大小与 manifest 不一致：${totalBytes}`)
}

if (process.argv.includes('--prepare-tauri')) {
  const normalizedRelative = (path) => relative(workspace, path).split(sep).join('/')
  if (normalizedRelative(targetDirectory) !== 'src-tauri/resources/fonts/core') {
    throw new Error('拒绝清理未验证的字体目标目录')
  }
  const targetNames = existsSync(targetDirectory)
    ? readdirSync(targetDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : []
  const targetIsCurrent =
    JSON.stringify(targetNames) === JSON.stringify(expectedNames) &&
    files.every((file) => {
      const target = join(targetDirectory, file.file)
      return (
        statSync(target).size === file.bytes &&
        createHash('sha256').update(readFileSync(target)).digest('hex') === file.sha256
      )
    })
  if (!targetIsCurrent) {
    const nonce = `${process.pid}-${Date.now()}`
    const stagingDirectory = `${targetDirectory}.staging-${nonce}`
    const backupDirectory = `${targetDirectory}.previous-${nonce}`
    mkdirSync(stagingDirectory, { recursive: true })
    for (const file of files)
      copyFileSync(join(sourceDirectory, file.file), join(stagingDirectory, file.file))
    let previousMoved = false
    try {
      if (existsSync(targetDirectory)) {
        renameSync(targetDirectory, backupDirectory)
        previousMoved = true
      }
      renameSync(stagingDirectory, targetDirectory)
      if (previousMoved) rmSync(backupDirectory, { recursive: true, force: true })
    } catch (error) {
      if (!existsSync(targetDirectory) && previousMoved && existsSync(backupDirectory)) {
        renameSync(backupDirectory, targetDirectory)
      }
      throw error
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true })
    }
  }
  if (existsSync(distFonts)) {
    if (normalizedRelative(distFonts) !== 'dist/fonts') throw new Error('拒绝清理未验证的构建目录')
    rmSync(distFonts, { recursive: true, force: true })
  }
}

console.log(`核心字体审计通过：${files.length} 个文件，${totalBytes} 字节`)
