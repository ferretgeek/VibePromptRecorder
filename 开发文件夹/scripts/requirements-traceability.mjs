import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const documentationRoot = resolve(workspace, '..', '需求和方案文件夹')
const requirementPath = resolve(documentationRoot, '完整需求.txt')
const outputPath = resolve(documentationRoot, '需求追踪表.csv')
const checkOnly = process.argv.includes('--check')
const releaseMode = process.argv.includes('--release')

const chineseSection = new Map([
  ['一', '1'],
  ['二', '2'],
  ['三', '3'],
  ['四', '4'],
  ['五', '5'],
  ['六', '6'],
  ['七', '7'],
  ['八', '8'],
  ['九', '9'],
  ['十', '10'],
  ['十一', '11'],
  ['十二', '12'],
  ['十三', '13'],
  ['十四', '14'],
  ['十五', '15'],
  ['十六', '16'],
  ['十七', '17'],
])

const groupMappings = [
  {
    prefix: '1',
    implementation: 'Tauri 2 + React 本地离线桌面应用；项目/轮次/Markdown 为唯一业务边界',
    evidence: '人工：验收报告-0.1.4 中的隔离 EXE 冒烟；自动化：README、APP/PRJ/RND 浏览器测试',
  },
  {
    prefix: '2',
    implementation: '主题令牌、三类字体设置、系统/内置/导入字体注册、真实字重、回退链与实时预览',
    evidence: 'theme/markdown 组件测试；字体哈希审计；设置 E2E；font-manifest.json',
  },
  {
    prefix: '3',
    implementation: '按需编辑器、虚拟时间线、延迟高亮、防抖保存与发布尺寸优化',
    evidence: '自动化：D2 1000×100 Playwright 浏览器压力用例、发布构建；人工：PERF 附件',
  },
  {
    prefix: '4',
    implementation: '项目 CRUD、单调默认名、置顶、最近使用排序、软删除与隔离查询',
    evidence: 'db::tests；项目管理 E2E；ProjectSidebar/appStore',
  },
  {
    prefix: '5',
    implementation: '单草稿原子转正式轮、独立 revision、重排、复制、FULL 同步自动保存',
    evidence: '自动化：db::tests、浏览器主流程 E2E；人工：验收报告-0.1.4 中的隔离 EXE 启停冒烟',
  },
  {
    prefix: '6',
    implementation:
      'Milkdown/CodeMirror 双模式、源码安全门、ReactMarkdown 消毒、Shiki、本地虚拟时间线与固定详情',
    evidence: 'Markdown/Vitest；20 次字节保真 E2E；组合事件 E2E；千轮 E2E',
  },
  {
    prefix: '7',
    implementation:
      '无安装 Tauri EXE、EXE 相邻 data、可写探测/定位器/锁、离线资源与 WebView2 前置检查',
    evidence: '自动化：paths.rs 测试、便携包验证；人工：验收报告-0.1.4 中的隔离 EXE 首启/关闭冒烟',
  },
  {
    prefix: '8',
    implementation: '编辑器撤销栈、结构操作 Toast 撤销、持续保留的回收站与项目隔离恢复',
    evidence: 'appStore；db 回收站测试；设置最近删除界面',
  },
  {
    prefix: '9',
    implementation: 'SQLite FTS5 trigram + 短词 LIKE；请求序号防旧结果覆盖；直接定位',
    evidence: '自动化：db 搜索测试、浏览器主流程 E2E；原生边界：验收报告-0.1.4 的隔离 EXE 冒烟',
  },
  {
    prefix: '10',
    implementation:
      'SQLite settings/project_view_state/window_state 持久化；锚点、源码光标与模式恢复',
    evidence: '源码光标重启 E2E；千轮锚点重载 E2E；真实 EXE 重启冒烟',
  },
  {
    prefix: '11',
    implementation: '原生窗口置顶/最小化/最大化/关闭；显示器可见区域钳制；响应式抽屉',
    evidence:
      '自动化：浏览器窄屏 E2E、窗口状态测试；人工：验收报告-0.1.4 中的隔离 EXE 安全关闭冒烟',
  },
  {
    prefix: '12',
    implementation:
      'UTF-8 Markdown、无损项目包、SQLite Online Backup、哈希归档校验与启动前原子恢复',
    evidence: 'archive/markdown_io 故障注入与往返测试；包结构验收',
  },
  {
    prefix: '13',
    implementation: '无账号/网络 API/遥测；本地明文 SQLite；最小 Tauri 权限与 CSP',
    evidence: 'CSP/权限单测；源码与依赖审计；README 隐私边界',
  },
  {
    prefix: '14',
    implementation: '应用层快捷键路由、编辑目标保护、IME 组合期屏蔽与时间线焦点导航',
    evidence: '自动化：shortcuts Vitest、浏览器 E2E；原生边界：验收报告-0.1.4 的隔离 EXE 冒烟',
  },
  {
    prefix: '15',
    implementation: '状态/错误 Toast、持续保存失败栏、可撤销删除及不可逆操作确认',
    evidence: 'Dialog/Toast 组件测试；E2E 焦点；错误恢复 UI 代码审计',
  },
  {
    prefix: '16',
    implementation: '明确排除；代码与 UI 均未引入对应业务能力',
    evidence: '依赖/命令/UI 范围审计；README 产品边界',
  },
  {
    prefix: '17',
    implementation: '项目→草稿→复制/完成→时间线→详情→搜索→本地持久化的完整闭环',
    evidence: '自动化：桌面/窄屏 Playwright 浏览器壳；人工：验收报告-0.1.4 中的隔离 EXE 冒烟',
  },
]

const manualRows = [
  ['1.1', '面向 Windows 的轻量项目化多轮提示词记录工具'],
  ['1.2', '只记录用户提示词，不记录 AI 回答或绑定特定工具'],
  ['1.3', '首版个人使用；未来分发前复核字体、签名和发布方式'],
  ['1.4', '启动迅速、操作流畅并保持轻量'],
  ['1.5', '界面美观且使用简单'],
  ['1.6', '数据安全且长期记录不混乱'],
]

const sourceLines = readFileSync(requirementPath, 'utf8').split(/\r?\n/)
let section = ''
let subsection = ''
const parsedRows = []
for (let index = 0; index < sourceLines.length; index += 1) {
  const line = sourceLines[index]
  const sectionMatch = /^##\s+([^、]+)、/.exec(line)
  if (sectionMatch) {
    section = chineseSection.get(sectionMatch[1]) ?? ''
    subsection = ''
    continue
  }
  const subsectionMatch = /^###\s+(\d+\.\d+)/.exec(line)
  if (subsectionMatch) {
    subsection = subsectionMatch[1]
    continue
  }
  const itemMatch = /^(\d+)\.\s+(.+)/.exec(line)
  if (!itemMatch || !section) continue
  const base = subsection || section
  parsedRows.push({
    id: `${base}.${itemMatch[1]}`,
    requirement: itemMatch[2].trim(),
    sourceLine: index + 1,
  })
}

const rows = [
  ...manualRows.map(([id, requirement]) => ({ id, requirement, sourceLine: 3 })),
  ...parsedRows,
]

const externalStatus = new Map([
  [
    '2.6.9',
    ['EXTERNAL_PENDING', '代码与浏览器缩放代理已通过；仍需在五档真实 Windows DPI 上人工验收'],
  ],
  [
    '3.1',
    [
      'LOCAL_PASS_EXTERNAL_PENDING',
      '本机浏览器壳和真实 EXE 已启动；20 次双系统冷/热启动需外部机补测',
    ],
  ],
  [
    '6.2.7',
    [
      'LOCAL_PASS_EXTERNAL_PENDING',
      '组合事件与中文文本已自动化通过；微软拼音候选窗仍需真人输入验收',
    ],
  ],
  [
    '7.2',
    ['LOCAL_PASS_EXTERNAL_PENDING', '本机 Win11 发布 EXE 已通过；Win10 22H2 干净机需外部验收'],
  ],
  [
    '7.8',
    [
      'IMPLEMENTED_EXTERNAL_PENDING',
      '原生缺失分支已实现；当前机器已安装 WebView2，无法物理移除验证',
    ],
  ],
])

function parseCsvLine(line) {
  const fields = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      fields.push(field)
      field = ''
    } else {
      field += character
    }
  }
  if (quoted) throw new Error('现有需求追踪表含未闭合引号')
  fields.push(field)
  return fields
}

// 生成时沿用同一 ID、同一需求文本已经人工确认过的状态；新需求或文本变更
// 必须先落为 UNVERIFIED，不能因属于某个章节就自动获得 LOCAL_PASS。
const approvedRows = new Map()
if (existsSync(outputPath)) {
  const currentLines = readFileSync(outputPath, 'utf8').trimEnd().split(/\r?\n/)
  for (const line of currentLines.slice(1)) {
    const fields = parseCsvLine(line)
    if (fields.length !== 7) throw new Error('现有需求追踪表列数无效')
    approvedRows.set(fields[0], {
      requirement: fields[2],
      status: fields[5],
      notes: fields[6],
    })
  }
}

function mappingFor(id) {
  const sectionId = id.split('.')[0]
  return groupMappings.find((mapping) => mapping.prefix === sectionId)
}

function statusFor(id, requirement) {
  if (id.startsWith('16.')) return ['OUT_OF_SCOPE_BY_REQUIREMENT', '需求明确排除']
  const external = externalStatus.get(id)
  if (external) return external
  const approved = approvedRows.get(id)
  if (approved?.requirement === requirement) return [approved.status, approved.notes]
  return ['UNVERIFIED', '新增或变更需求，必须补充实现证据与验收结论']
}

const header = ['id', 'source_line', 'requirement', 'implementation', 'evidence', 'status', 'notes']
const traced = rows.map((row) => {
  const mapping = mappingFor(row.id)
  const [status, notes] = statusFor(row.id, row.requirement)
  if (!mapping || !status || !notes) throw new Error(`追踪映射不完整：${row.id}`)
  return [
    row.id,
    String(row.sourceLine),
    row.requirement,
    mapping.implementation,
    mapping.evidence,
    status,
    notes,
  ]
})

const ids = new Set(traced.map(([id]) => id))
if (ids.size !== traced.length) throw new Error('需求追踪 ID 重复')
if (parsedRows.length === 0 || traced.length !== manualRows.length + parsedRows.length) {
  throw new Error(`需求追踪解析数量异常：${traced.length}`)
}
if (traced.some((row) => row.some((value) => !value))) throw new Error('需求追踪存在空字段')

const csvEscape = (value) => `"${String(value).replaceAll('"', '""')}"`
const output = [header, ...traced].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n'

if (checkOnly) {
  const current = readFileSync(outputPath, 'utf8')
  if (current !== output) throw new Error('需求追踪表.csv 已过期，请重新生成')
  if (releaseMode) {
    const pending = traced.filter((row) => /PENDING|UNVERIFIED/.test(row[5]))
    if (pending.length > 0) {
      throw new Error(
        `正式发布仍有 ${pending.length} 条未完成验收：${pending
          .slice(0, 12)
          .map((row) => `${row[0]}=${row[5]}`)
          .join(', ')}`,
      )
    }
  }
  console.log(`需求追踪门禁通过：${traced.length} 条，无空状态`)
} else {
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, output, 'utf8')
    const handle = openSync(temporaryPath, 'r+')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporaryPath, outputPath)
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  console.log(`已生成需求追踪：${traced.length} 条 -> ${outputPath}`)
}
