/**
 * dsh-llm-verifier — LLM-as-a-Verifier bridge for DSH.
 *
 * Exposes `select`, `compare`, `track` and a live `ProgressTracker` as DSH
 * agent tools through a long-lived Python stdio bridge. The Python side
 * delegates to the official `llm-verifier` package, so algorithm behavior
 * stays upstream; this plugin only owns process/JSON plumbing and tool
 * contracts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PythonBridge } from './bridge.ts'
import { registerVerifierTools } from './tools.ts'
import { VerifierEvaluatorService } from './service.ts'
import { clearProgressRecords, listProgressRecords } from './progress.ts'
import {
  registerVerifierWebRoutes,
  type AvailableBackend,
  type BackendId,
  type SaveConfigInput,
  type VerifierRuntimeConfig,
} from './web.ts'

export const name = '@lanbaolu/dsh-llm-verifier'
export const inject = ['tools', 'credentials', 'systemPrompt']

export interface Config {
  /** Python executable used to launch the bridge. Defaults to python3 (python on Windows). */
  pythonBin?: string
  /** Per-request timeout for bridge calls in milliseconds. */
  bridgeTimeoutMs?: number
  /** Default verifier model passed to llm-verifier when a tool omits `model`. */
  verifierModel?: string
  /** DeepSeek reasoning effort: 'off' | 'low' | 'high' | 'max'（空 = 官方默认 high）。
   *  high 精度最高但单次评分 60-120s；off/low 可降至 5-15s（精度略降）。 */
  deepseekEffort?: string
  /** Agent 开场/运行中如何接触 verifier_* 工具策略提示：
   *  'explicit'（默认，方案 A）：注入“仅用户显式请求或 /evaluate-team 等命令触发”提示；
   *  'prompted'（方案 B）：注入保留成本提示但允许按需评估的宽松提示；
   *  'off'（方案 C）：不注入策略提示，完全不干预 agent。 */
  agentStrategy?: 'explicit' | 'prompted' | 'off'
}

export const Config = z.object({
  pythonBin: z.string().default(''),
  bridgeTimeoutMs: z.number().default(600_000),
  verifierModel: z.string().default(''),
  deepseekEffort: z.string().default(''),
  agentStrategy: z.union([z.const('explicit'), z.const('prompted'), z.const('off')]).default('explicit'),
})

/** 未显式配置 pythonBin 时，优先使用插件自带 .venv，避免系统 Python PEP 668 限制。 */
function resolveDefaultPythonBin(): string {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const candidates = process.platform === 'win32'
    ? [join(root, '.venv', 'Scripts', 'python.exe'), 'python']
    : [join(root, '.venv', 'bin', 'python'), 'python3']
  for (const candidate of candidates) {
    if (!candidate.includes('/') && !candidate.includes('\\')) return candidate
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // ignore and fall through
    }
  }
  return candidates[candidates.length - 1] ?? (process.platform === 'win32' ? 'python' : 'python3')
}

/** DSH 用户配置目录（与微信桥等插件一致，存放在 DSH_HOME 下）。 */
function dshHomeDir(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function persistedConfigPath(): string {
  return join(dshHomeDir(), 'llm-verifier', 'config.json')
}

interface RuntimeConfigStore {
  backend: BackendId
  model: string
  /** 用户显式指定的 pythonBin；空字符串表示使用插件自动解析（.venv 优先）。 */
  pythonBin: string
  bridgeTimeoutMs: number
  /** DeepSeek reasoning effort；空字符串表示使用官方默认（high）。 */
  deepseekEffort: string
}

function defaultRuntimeStore(config: Config): RuntimeConfigStore {
  return {
    backend: 'auto',
    model: config.verifierModel ?? '',
    pythonBin: config.pythonBin ?? '',
    bridgeTimeoutMs: config.bridgeTimeoutMs ?? 600_000,
    deepseekEffort: config.deepseekEffort ?? '',
  }
}

function loadRuntimeStore(config: Config): RuntimeConfigStore {
  const defaults = defaultRuntimeStore(config)
  try {
    const raw = JSON.parse(readFileSync(persistedConfigPath(), 'utf8')) as Record<string, unknown>
    return {
      backend: (['auto', 'deepseek', 'vertex', 'openai'] as const).includes(raw.backend as BackendId)
        ? raw.backend as BackendId
        : defaults.backend,
      model: typeof raw.model === 'string' ? raw.model : defaults.model,
      pythonBin: typeof raw.pythonBin === 'string' ? raw.pythonBin : defaults.pythonBin,
      bridgeTimeoutMs: typeof raw.bridgeTimeoutMs === 'number' && raw.bridgeTimeoutMs > 0
        ? raw.bridgeTimeoutMs
        : defaults.bridgeTimeoutMs,
      deepseekEffort: typeof raw.deepseekEffort === 'string' ? raw.deepseekEffort : defaults.deepseekEffort,
    }
  } catch {
    return defaults
  }
}

function persistRuntimeStore(store: RuntimeConfigStore): void {
  const file = persistedConfigPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    backend: store.backend,
    model: store.model,
    pythonBin: store.pythonBin,
    bridgeTimeoutMs: store.bridgeTimeoutMs,
    deepseekEffort: store.deepseekEffort,
  }, null, 2) + '\n', 'utf8')
}

/** 注册 /bestofn 命令：手动触发 Best-of-N 选优。 */
function registerBestOfNCommand(ctx: Context, getBridge: () => Promise<PythonBridge>): void {
  const commands = (ctx as any).get?.('commands') ?? (ctx as any).commands
  if (!commands || typeof commands.register !== 'function') return
  const dispose = commands.register({
    name: 'bestofn',
    description: 'Run Best-of-N selection. Usage: /bestofn {"problem":"...","candidates":["...","..."],"criteria":"...","n_evaluations":1,"pivots":2,"model":"..."}. Prefer small n_evaluations/pivots to avoid long waits; for very long runs use verifier_task_start.',
    input: { hint: '{"problem":"...","candidates":["...","..."]}' },
    handler: async ({ rawInput }: any): Promise<any> => {
      const raw = String(rawInput ?? '')
        .trim()
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
      if (!raw) {
        return {
          kind: 'error',
          text: '/bestofn 需要 JSON 参数。\n示例：/bestofn {"problem":"实现反转字符串","candidates":["方案A","方案B"]}\n也可以直接在对话里说：请用 verifier_select 从候选中选最优。',
        }
      }
      let input: any
      try {
        input = JSON.parse(raw)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `JSON 解析失败（${detail}）。示例：/bestofn {"problem":"...","candidates":["...","..."]}` }
      }
      if (!input?.problem || !Array.isArray(input?.candidates) || input.candidates.length === 0) {
        return { kind: 'error', text: '需要提供 problem 和 candidates 数组' }
      }
      if (!input.candidates.every((c: unknown) => typeof c === 'string')) {
        return { kind: 'error', text: 'candidates 必须是字符串数组' }
      }
      let criteria = input.criteria
      if (criteria === undefined) {
        criteria = {
          Correctness: 'Does the candidate correctly solve the problem?',
          Completeness: 'Does it fully address the request?',
          Clarity: 'Is the solution clear and maintainable?',
        }
      } else if (typeof criteria === 'string' && /^[[{]/.test(criteria.trim())) {
        try {
          criteria = JSON.parse(criteria)
        } catch {
          return { kind: 'error', text: 'criteria 不是合法的 JSON 对象字符串' }
        }
      }
      try {
        const bridge = await getBridge()
        const result = await bridge.request<any>('select', {
          problem: input.problem,
          candidates: input.candidates,
          criteria,
          ...(input.n_evaluations !== undefined ? { n_evaluations: input.n_evaluations } : {}),
          ...(input.pivots !== undefined ? { pivots: input.pivots } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        })
        return {
          kind: 'success',
          text: `Best candidate index: ${result.index}\nScores: ${JSON.stringify(result.scores)}\nRanking: ${JSON.stringify(result.ranking)}`,
        }
      } catch (error) {
        return { kind: 'error', text: `Best-of-N 执行失败: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
  ctx.effect(() => dispose)
}

/** 从会话事件中提取用户问题与 assistant 步骤，供轨迹批量评分使用。 */
function extractSessionSteps(events: any[]): { problem: string; steps: string[] } {
  let problem = ''
  const steps: string[] = []
  for (const ev of events ?? []) {
    const data = ev?.data
    if (ev?.type === 'message' && ev?.role === 'user') {
      const content = ev?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((x: any) => (typeof x === 'string' ? x : x?.text ?? '')).filter(Boolean).join('\n')
          : ''
      if (text && !problem) problem = text.slice(0, 500)
    }
    if (ev?.type === 'assistant/message') {
      const blocks = data?.message?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block?.type === 'text' && block.text) steps.push(block.text)
        if (block?.type === 'tool-call' && block.name) {
          steps.push(`[工具] ${block.name}: ${JSON.stringify(block.arguments ?? {}).slice(0, 200)}`)
        }
      }
    }
  }
  return { problem: problem || 'Evaluate the current session trajectory', steps }
}

/** 注册 /evaluate-session 命令：对当前会话轨迹批量评分并导出 JSONL。 */
function registerEvaluateCommand(ctx: Context, getBridge: () => Promise<PythonBridge>): void {
  const commands = (ctx as any).get?.('commands') ?? (ctx as any).commands
  if (!commands || typeof commands.register !== 'function') return
  const dispose = commands.register({
    name: 'evaluate-session',
    description: 'Score the current session trajectory with verifier_track and export the result to scores/<sessionId>.jsonl',
    handler: async ({ agent }: any): Promise<any> => {
      try {
        const { problem, steps } = extractSessionSteps(agent?.session?.events)
        if (steps.length === 0) return { kind: 'error', text: '当前会话没有可评分的 assistant 步骤' }
        const bridge = await getBridge()
        const result = await bridge.request<any>('track', {
          problem,
          steps,
          n_evaluations: 1,
        })
        const root = fileURLToPath(new URL('..', import.meta.url))
        const scoresDir = join(root, 'scores')
        mkdirSync(scoresDir, { recursive: true })
        const file = join(scoresDir, `${agent?.session?.id ?? 'session'}.jsonl`)
        writeFileSync(file, JSON.stringify({ problem, steps, scores: result.scores, at: new Date().toISOString() }) + '\n', 'utf8')
        return {
          kind: 'success',
          text: `已对 ${steps.length} 个步骤评分并导出到 ${file}\nScores: ${JSON.stringify(result.scores)}`,
        }
      } catch (error) {
        return { kind: 'error', text: `会话评分失败: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
  ctx.effect(() => dispose)
}

/** 注册 /evaluate-team 命令：读取 dsh-agent-teams 团队已完成任务的产出，
 *  用 verifier_select 评审（team.description 为 problem、各 task.output 为候选），
 *  结果导出到 scores/<teamId>.jsonl。 */
function registerEvaluateTeamCommand(ctx: Context, getBridge: () => Promise<PythonBridge>): void {
  const commands = (ctx as any).get?.('commands') ?? (ctx as any).commands
  if (!commands || typeof commands.register !== 'function') return
  const dispose = commands.register({
    name: 'evaluate-team',
    description:
      'Evaluate a dsh-agent-teams team\'s completed task outputs with verifier_select and export to scores/<teamId>.jsonl. Usage: /evaluate-team [teamId] (defaults to the first team under .agent-teams).',
    input: { hint: '[teamId]' },
    handler: async ({ agent, rawInput }: any): Promise<any> => {
      try {
        // 1) 定位 .agent-teams 根目录（依次尝试当前目录与会话工作目录）
        const bases = [process.cwd(), agent?.session?.header?.cwd, agent?.session?.workspace, agent?.session?.cwd]
          .filter((v: unknown) => typeof v === 'string' && v.length > 0) as string[]
        let teamRoot: string | undefined
        for (const base of bases) {
          const root = join(base, '.agent-teams')
          if (existsSync(root)) {
            teamRoot = root
            break
          }
        }
        if (!teamRoot) return { kind: 'error', text: '未找到 .agent-teams 目录（当前工作区没有 agent-teams 团队数据）' }

        // 2) 定位团队目录
        const teamId = String(rawInput ?? '').trim() || undefined
        let teamDir: string | undefined
        if (teamId) {
          const dir = join(teamRoot, teamId)
          teamDir = existsSync(join(dir, 'team.json')) ? dir : undefined
          if (!teamDir) return { kind: 'error', text: `团队 ${teamId} 不存在（${dir}）` }
        } else {
          const dirs = readdirSync(teamRoot).filter((d) => existsSync(join(teamRoot, d, 'team.json')))
          if (dirs.length === 0) return { kind: 'error', text: '.agent-teams 下没有团队数据（可传 teamId）' }
          teamDir = join(teamRoot, dirs[0])
        }

        // 3) 收集已完成任务的产出
        const team = JSON.parse(readFileSync(join(teamDir, 'team.json'), 'utf8'))
        const done = (team.tasks ?? []).filter(
          (t: any) => t.status === 'completed' && typeof t.output === 'string' && t.output.trim().length > 0,
        )
        if (done.length === 0) {
          const statuses: string[] = Array.from(new Set((team.tasks ?? []).map((t: any) => t.status)))
          return { kind: 'error', text: `团队 ${team.name ?? team.id} 没有已完成且带产出（output）的任务。任务状态分布：${JSON.stringify(statuses)}` }
        }
        const candidates = done.map(
          (t: any) => `[${t.assignee ?? '?'}] ${t.subject}\n${t.output.slice(0, 4000)}`,
        )
        const problem = team.description || team.name || '团队任务产出评审'

        // 4) verifier_select 评审
        const bridge = await getBridge()
        const result = await bridge.request<any>('select', {
          problem,
          candidates,
          n_evaluations: 1,
          pivots: 2,
          criteria: {
            Correctness: 'Does the output correctly solve the assigned task?',
            Completeness: 'Does it fully address the task requirements?',
            Clarity: 'Is the output clear, well-structured and actionable?',
          },
        })

        // 5) 导出 JSONL
        const root = fileURLToPath(new URL('..', import.meta.url))
        const scoresDir = join(root, 'scores')
        mkdirSync(scoresDir, { recursive: true })
        const file = join(scoresDir, `${team.id ?? teamId ?? 'team'}.jsonl`)
        writeFileSync(
          file,
          JSON.stringify({
            team: team.name ?? team.id,
            problem,
            candidates,
            scores: result.scores,
            ranking: result.ranking,
            at: new Date().toISOString(),
          }) + '\n',
          'utf8',
        )
        const best = result.index !== undefined ? done[result.index] : undefined
        return {
          kind: 'success',
          text:
            `已评审 ${done.length} 个成员产出并导出到 ${file}\n` +
            `Scores: ${JSON.stringify(result.scores)}\n` +
            `Ranking: ${JSON.stringify(result.ranking)}\n` +
            `最优产出：${best ? `[${best.assignee}] ${best.subject}` : 'N/A'}`,
        }
      } catch (error) {
        return { kind: 'error', text: `团队评审失败: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
  ctx.effect(() => dispose)
}

/** 使用策略提示：verifier_* 每次调用都会触发额外的 LLM 评分请求（可能较慢），
 *  因此默认只应在用户显式要求时调用，避免 agent 开场/任意时刻主动触发慢调用。
 *  通过 config.agentStrategy 可选择 explicit / prompted / off：
 *  - explicit：默认，仅用户显式请求或 /evaluate-team 等命令触发；
 *  - prompted：保留成本提示，但允许 agent 按需评估；
 *  - off：完全不注入策略提示。 */
const VERIFIER_AGENT_STRATEGY = `## LLM Verifier 使用策略

\`verifier_*\` 工具用于 LLM 评估（选优/对比/进度/复盘），每次调用都会额外消耗 LLM 评分请求，可能耗时较长。**仅在用户显式要求时调用，不要主动触发**：

- 用户明确要求"用 verifier / LLM 评估 / 选优对比"时；
- 用户使用 \`/evaluate-team\`、\`/evaluate-session\`、\`/bestofn\` 等命令触发批量评审时；
- 你已给出候选答案，且用户明确要求用 verifier 评估这些候选时。
- 注意：\`verifier_select\` / \`verifier_compare\` 必须传 \`criteria\`（JSON 对象字符串，例如 {"Correctness":"..."}）。
- 评估量大时建议传 \`n_evaluations\`=1、\`pivots\`=2 控制耗时。
- 精度/耗时：DeepSeek 后端默认 high-effort 思维链，单次评分约 60-120s（精度最高）。如需提速，可在 LLM Verifier 设置面板把「DeepSeek 推理强度」调为 off/low（约 5-15s，精度略降），由用户自行权衡。调用前请向用户说明本次评估的预期耗时。`

/** 宽松策略（agentStrategy='prompted'）：保留成本/耗时提示，但不禁止 agent 主动评估。 */
const VERIFIER_AGENT_STRATEGY_PROMPTED = `## LLM Verifier 使用策略

\`verifier_*\` 工具用于 LLM 评估（选优/对比/进度/复盘），每次调用都会额外消耗 LLM 评分请求，可能耗时较长。调用前请先向用户说明本次评估的预期耗时：

- 注意：\`verifier_select\` / \`verifier_compare\` 必须传 \`criteria\`（JSON 对象字符串，例如 {"Correctness":"..."}）。
- 评估量大时建议传 \`n_evaluations\`=1、\`pivots\`=2 控制耗时。
- 精度/耗时：DeepSeek 后端默认 high-effort 思维链，单次评分约 60-120s（精度最高）。如需提速，可在 LLM Verifier 设置面板把「DeepSeek 推理强度」调为 off/low（约 5-15s，精度略降），由用户自行权衡。`

function agentStrategyText(strategy: Config['agentStrategy']): string | null {
  if (strategy === 'off') return null
  if (strategy === 'prompted') return VERIFIER_AGENT_STRATEGY_PROMPTED
  return VERIFIER_AGENT_STRATEGY
}

export function apply(ctx: Context, config: Config): void {
  let bridge: PythonBridge | undefined
  let bridgePromise: Promise<PythonBridge> | undefined
  const store: RuntimeConfigStore = loadRuntimeStore(config)

  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const sections = Array.isArray(assembled?.sections) ? assembled.sections : []
    if (sections.some((section: any) => section?.name === 'llm-verifier-agent-strategy')) return assembled
    const text = agentStrategyText(config.agentStrategy)
    if (!text) return assembled
    return {
      ...assembled,
      sections: [...sections, { name: 'llm-verifier-agent-strategy', text, order: 150 }],
    }
  })

  /** 复用 DSH/Harness 已配置的模型凭据（DeepSeek / Vertex / OpenAI 兼容），避免用户单独再配 key。 */
  const CREDENTIAL_REFS = [
    'DEEPSEEK_API_KEY',
    'VERTEX_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ] as const

  const loadAllCredentialEnv = async (): Promise<Record<string, string>> => {
    try {
      const credentials = (ctx as any).credentials
      if (!credentials || typeof credentials.resolve !== 'function') {
        ctx.logger.warn('[dsh-llm-verifier] ctx.credentials 不可用（插件未注入或服务未启动）')
        return {}
      }
      const env: Record<string, string> = {}
      for (const ref of CREDENTIAL_REFS) {
        const resolved = await credentials.resolve(ref)
        if (resolved?.value) env[ref] = resolved.value
      }
      if (Object.keys(env).length === 0) {
        ctx.logger.warn('[dsh-llm-verifier] Harness credentials 中未配置 verifier 后端凭据（DEEPSEEK/VERTEX/OPENAI）')
      }
      return env
    } catch (error) {
      ctx.logger.warn('[dsh-llm-verifier] 从 Harness credentials 读取模型凭据失败: %s', String(error))
      return {}
    }
  }

  /** 按 UI 选择的后端过滤凭据，避免 OPENAI_BASE_URL 优先级压过 DeepSeek。 */
  const filterEnvByBackend = (all: Record<string, string>, backend: BackendId): Record<string, string> => {
    switch (backend) {
      case 'deepseek':
        return all.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: all.DEEPSEEK_API_KEY } : {}
      case 'vertex':
        return all.VERTEX_API_KEY ? { VERTEX_API_KEY: all.VERTEX_API_KEY } : {}
      case 'openai': {
        const env: Record<string, string> = {}
        if (all.OPENAI_BASE_URL) env.OPENAI_BASE_URL = all.OPENAI_BASE_URL
        if (all.OPENAI_API_KEY) env.OPENAI_API_KEY = all.OPENAI_API_KEY
        return env
      }
      case 'auto':
      default:
        return all
    }
  }

  const getConfig = (): VerifierRuntimeConfig => ({
    backend: store.backend,
    model: store.model,
    pythonBin: store.pythonBin || resolveDefaultPythonBin(),
    bridgeTimeoutMs: store.bridgeTimeoutMs,
    deepseekEffort: store.deepseekEffort,
  })

  const detectBackends = async (): Promise<AvailableBackend[]> => {
    const all = await loadAllCredentialEnv()
    const hasDeepseek = Boolean(all.DEEPSEEK_API_KEY)
    const hasVertex = Boolean(all.VERTEX_API_KEY)
    const hasOpenai = Boolean(all.OPENAI_API_KEY)
    const anyConfigured = hasDeepseek || hasVertex || hasOpenai
    const backends: AvailableBackend[] = [
      {
        id: 'auto',
        label: '自动选择',
        configured: anyConfigured,
        detail: anyConfigured
          ? '按官方优先级自动使用 OPENAI_BASE_URL > DEEPSEEK_API_KEY > VERTEX_API_KEY'
          : '未检测到任何 verifier 后端凭据',
      },
      {
        id: 'deepseek',
        label: 'DeepSeek',
        configured: hasDeepseek,
        detail: hasDeepseek ? '已配置 DEEPSEEK_API_KEY' : '未配置 DEEPSEEK_API_KEY',
      },
      {
        id: 'vertex',
        label: 'Vertex AI',
        configured: hasVertex,
        detail: hasVertex ? '已配置 VERTEX_API_KEY' : '未配置 VERTEX_API_KEY',
      },
      {
        id: 'openai',
        label: 'OpenAI 兼容',
        configured: hasOpenai,
        detail: hasOpenai
          ? (all.OPENAI_BASE_URL ? `已配置 OPENAI_API_KEY（${all.OPENAI_BASE_URL}）` : '已配置 OPENAI_API_KEY（使用官方默认端点）')
          : '未配置 OPENAI_API_KEY',
      },
    ]
    return backends
  }

  const restartBridge = async (): Promise<void> => {
    if (bridgePromise) {
      try {
        await bridgePromise
      } catch {
        // 桥启动失败时继续清理，让下一次调用重新尝试
      }
    }
    bridge?.close()
    bridge = undefined
    bridgePromise = undefined
  }

  const saveConfig = async (input: SaveConfigInput): Promise<{ ok: boolean; message: string; restartBridge: boolean }> => {
    const before = { ...store }

    if (input.backend !== undefined) {
      const backends = await detectBackends()
      if (input.backend !== 'auto') {
        const selected = backends.find((item) => item.id === input.backend)
        if (!selected?.configured) {
          return { ok: false, message: `后端 ${selected?.label ?? input.backend} 未配置凭据，无法切换`, restartBridge: false }
        }
      }
      store.backend = input.backend
    }
    if (input.model !== undefined) store.model = input.model.trim()
    if (input.pythonBin !== undefined) store.pythonBin = input.pythonBin.trim()
    if (input.bridgeTimeoutMs !== undefined) store.bridgeTimeoutMs = input.bridgeTimeoutMs
    if (input.deepseekEffort !== undefined) store.deepseekEffort = input.deepseekEffort

    const changed = before.backend !== store.backend
      || before.model !== store.model
      || before.pythonBin !== store.pythonBin
      || before.bridgeTimeoutMs !== store.bridgeTimeoutMs
      || before.deepseekEffort !== store.deepseekEffort
    if (!changed) {
      return { ok: true, message: '配置未变化', restartBridge: false }
    }

    persistRuntimeStore(store)
    await restartBridge()
    const parts = ['配置已保存']
    if (before.backend !== store.backend) parts.push(`后端：${store.backend}`)
    if (before.model !== store.model) parts.push(`模型：${store.model || '默认'}`)
    return { ok: true, message: `${parts.join('；')}。桥进程将在下次调用时按新配置启动。`, restartBridge: true }
  }

  const getBridge = async (): Promise<PythonBridge> => {
    if (bridge && bridge.isRunning) return bridge
    if (bridgePromise) return bridgePromise
    bridgePromise = (async () => {
      const runtime = getConfig()
      const scriptUrl = new URL('./bridge/llm_verifier_bridge.py', import.meta.url)
      const allCredentialEnv = await loadAllCredentialEnv()
      const credentialsEnv = filterEnvByBackend(allCredentialEnv, runtime.backend)
      const env = {
        ...process.env,
        ...credentialsEnv,
        ...(runtime.model !== '' ? { LLM_VERIFIER_MODEL: runtime.model } : {}),
        ...(runtime.deepseekEffort ? { DEEPSEEK_EFFORT: runtime.deepseekEffort } : {}),
      }
      const next = new PythonBridge(scriptUrl, runtime.pythonBin, runtime.bridgeTimeoutMs, env)
      next.start()
      bridge = next
      return next
    })()
    try {
      return await bridgePromise
    } catch (error) {
      bridgePromise = undefined
      bridge = undefined
      throw error
    }
  }

  ctx.effect(() => {
    const webDisposers = registerVerifierWebRoutes(ctx, {
      getConfig,
      saveConfig,
      detectBackends,
      listProgress: listProgressRecords,
      clearProgress: clearProgressRecords,
      getDiagnostics: () => bridge?.diagnostics ?? '',
      getBridge,
    })
    return () => {
      for (const dispose of webDisposers) dispose()
      bridgePromise = undefined
      bridge?.close()
      bridge = undefined
    }
  })

  registerVerifierTools(ctx, getBridge)
  registerBestOfNCommand(ctx, getBridge)
  registerEvaluateCommand(ctx, getBridge)
  registerEvaluateTeamCommand(ctx, getBridge)
  // P2: 注册为可复用的 evaluator 服务，供其他 DSH 插件/命令直接调用。
  new VerifierEvaluatorService(ctx, getBridge)
}
