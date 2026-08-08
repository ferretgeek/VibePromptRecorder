import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { roundContentForCopy } from '../../lib/roundCopy'
import { useAppStore } from '../../stores/appStore'
import type { RoundDetail } from '../../types'

const activeRound: RoundDetail = {
  id: 'active-round',
  projectId: 'project',
  position: 2_147_483_647,
  status: 'draft',
  contentMd: '数据库中的旧正文',
  createdAt: 1,
  finalizedAt: null,
  updatedAt: 1,
  revision: 3,
  note: '',
}

beforeEach(() => {
  useAppStore.setState({
    activeRound,
    selectedRoundId: activeRound.id,
    editorContent: '用户眼前、尚在自动保存防抖中的正文',
  })
})

describe('轮次卡片复制', () => {
  it('当前选中轮次复制编辑缓冲区而不是 SQLite 旧值', async () => {
    const getRound = vi.spyOn(api, 'getRound')

    await expect(roundContentForCopy(activeRound.id, true)).resolves.toBe(
      '用户眼前、尚在自动保存防抖中的正文',
    )
    expect(getRound).not.toHaveBeenCalled()
  })

  it('非当前轮次仍从持久化事实来源读取完整正文', async () => {
    const getRound = vi
      .spyOn(api, 'getRound')
      .mockResolvedValue({ ...activeRound, id: 'other-round', contentMd: '其它轮次完整正文' })

    await expect(roundContentForCopy('other-round', false)).resolves.toBe('其它轮次完整正文')
    expect(getRound).toHaveBeenCalledWith('other-round')
  })
})
