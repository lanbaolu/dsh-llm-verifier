/**
 * dsh-llm-verifier — LLM-as-a-Verifier bridge for DSH.
 *
 * Exposes `select`, `compare`, `track` and a live `ProgressTracker` as DSH
 * agent tools through a long-lived Python stdio bridge. The Python side
 * delegates to the official `llm-verifier` package, so algorithm behavior
 * stays upstream; this plugin only owns process/JSON plumbing and tool
 * contracts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export const name = '@dsh-external/dsh-llm-verifier'
export const inject = ['tools', 'credentials', 'systemPrompt']

export interface Config {
  /** Python executable used to launch the bridge. Defaults to python3 (python on Windows). */
  pythonBin?: string
  /** Per-request timeout for bridge calls in milliseconds. */
  bridgeTimeoutMs?: number
  /** Default verifier model passed to llm-verifier when a tool omits `model`. */
  verifierModel?: string
}

export const Config = z.object({
  pythonBin: z.string().default(''),
  bridgeTimeoutMs: z.number().default(300_000),
  verifierModel: z.string().default(''),
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
}

function defaultRuntimeStore(config: Config): RuntimeConfigStore {
  return {
    backend: 'auto',
    model: config.verifierModel ?? '',
    pythonBin: config.pythonBin ?? '',
    bridgeTimeoutMs: config.bridgeTimeoutMs ?? 300_000,
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

/** 层次 1：注入给 agent 的使用策略提示，让 agent 更主动调用 verifier_*。 */
const VERIFIER_AGENT_STRATEGY = `## LLM Verifier 使用策略

在以下情况主动使用 verifier_* 工具，而不是手动用命令行跑：

- 当你准备给出多个候选方案时，先用 \`verifier_select\` 选优；
- 当两个方案需要对比时，用 \`verifier_compare\`；
- 长任务每完成一个关键步骤，用 \`verifier_progress\` 更新进度；
- 任务收尾时，用 \`verifier_track\` 复盘。
- 注意：\`verifier_select\` / \`verifier_compare\` 必须传 \`criteria\`（JSON 对象字符串，例如 {"Correctness":"..."}）。`

export function apply(ctx: Context, config: Config): void {
  let bridge: PythonBridge | undefined
  let bridgePromise: Promise<PythonBridge> | undefined
  const store: RuntimeConfigStore = loadRuntimeStore(config)

  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const sections = Array.isArray(assembled?.sections) ? assembled.sections : []
    if (sections.some((section: any) => section?.name === 'llm-verifier-agent-strategy')) return assembled
    return {
      ...assembled,
      sections: [...sections, { name: 'llm-verifier-agent-strategy', text: VERIFIER_AGENT_STRATEGY, order: 150 }],
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

    const changed = before.backend !== store.backend
      || before.model !== store.model
      || before.pythonBin !== store.pythonBin
      || before.bridgeTimeoutMs !== store.bridgeTimeoutMs
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
  // P2: 注册为可复用的 evaluator 服务，供其他 DSH 插件/命令直接调用。
  new VerifierEvaluatorService(ctx, getBridge)
}
