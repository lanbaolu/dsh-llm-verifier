/**
 * @lanbaolu/dsh-llm-verifier — Web 设置面板。
 *
 * 渲染在 settings.section 槽位（设置页），用于选择 verifier 后端/model，
 * 并展示 ProgressTracker 分数曲线。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { LlmVerifierPanel } from './Panel.js'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: '@lanbaolu/dsh-llm-verifier-panel',
      order: 60,
      label: () => 'LLM Verifier',
    }, LlmVerifierPanel),
  ), '@lanbaolu/dsh-llm-verifier: panel')
}
