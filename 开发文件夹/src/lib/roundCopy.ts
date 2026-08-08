import { useAppStore } from '../stores/appStore'
import { api } from './api'

export async function roundContentForCopy(roundId: string, selected: boolean): Promise<string> {
  const state = useAppStore.getState()
  if (selected && state.activeRound?.id === roundId) {
    // 当前卡片可能仍有尚未走完自动保存防抖的编辑；复制用户眼前的缓冲区，
    // 其它卡片仍从 SQLite 读取，避免把摘要 previewMd 当作完整正文。
    return state.editorContent
  }
  return (await api.getRound(roundId)).contentMd
}
