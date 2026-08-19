/**
 * Model-facing tools that bridge DSH to `llm-verifier` via the Python stdio
 * bridge.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PythonBridge } from './bridge.ts'
import type { Criteria, VerifierCompareArgs, VerifierProgressArgs, VerifierSelectArgs, VerifierTrackArgs } from './types.ts'
import { recordProgressClose, recordProgressStart, recordProgressUpdate } from './progress.ts'

/** Criteria accepts a preset name ("terminal_bench") or a JSON object string. */
function parseCriteria(raw: string | undefined): Criteria | undefined {
  if (raw === undefined || raw === '') return undefined
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
    } catch {
      // fall through: send the raw string and let llm-verifier decide
    }
  }
  return trimmed
}

const LOOSE_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {},
} as const

/** 进程内结果缓存：相同 select/compare 请求直接复用，避免重复计费。 */
const resultCache = new Map<string, Promise<any>>()

function cached<T>(key: string, request: () => Promise<T>): Promise<T> {
  const existing = resultCache.get(key)
  if (existing !== undefined) return existing as Promise<T>
  const promise = request().catch((error) => {
    resultCache.delete(key)
    throw error
  })
  resultCache.set(key, promise)
  return promise
}

/** 异步 verifier 任务表：长评分不阻塞 agent 工具调用。 */
interface VerifierTask {
  promise: Promise<any>
  settled: boolean
  result?: any
  error?: string
}
const verifierTasks = new Map<string, VerifierTask>()
let verifierTaskSeq = 0

export function registerVerifierTools(ctx: Context, getBridge: () => Promise<PythonBridge>): void {
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(defineTool({
        name: 'verifier_select',
        description:
          'Select the best candidate answer/trajectory for a problem using LLM-as-a-Verifier. Pass candidates as a JSON array of strings; returns index, ranking and fine-grained scores. To keep latency/cost low, prefer n_evaluations=1 and pivots=2 unless higher accuracy is required; for long tasks use verifier_task_start + verifier_task_status instead of blocking.',
        parameters: {
          problem: { type: 'string', required: true, description: 'Task/problem statement shared by all candidates.' },
          candidates: { type: 'array', items: { type: 'string' }, required: true, description: 'Candidate answers or agent trajectories (strings).' },
          criteria: { type: 'string', required: true, description: 'Evaluation criteria: a preset name (e.g. "terminal_bench") or a JSON object string like {"Correctness":"..."}. Required by the verifier backend.' },
          model: { type: 'string', description: 'Verifier model id (e.g. gemini-2.5-flash, deepseek-v4-flash). Default is llm-verifier configured backend.' },
          n_evaluations: { type: 'number', description: 'Repeated evaluations per criterion (default 4).' },
          pivots: { type: 'number', description: 'Pivots for Probabilistic Pivot Tournament; fewer pivots reduce cost.' },
          images: { type: 'array', items: { type: 'string' }, description: 'Optional image file paths/URLs; pass a one-element array for a single image.' },
          seed: { type: 'number', description: 'Random seed.' },
          max_workers: { type: 'number', description: 'Max parallel verifier workers.' },
        },
        output: {
          schema: LOOSE_OBJECT_SCHEMA,
          render: (_args, value: Record<string, any>) => [
            { type: 'text', text: `Best candidate index: ${value.index}\nScores: ${JSON.stringify(value.scores)}\nRanking: ${JSON.stringify(value.ranking)}` },
          ],
        },
        async execute(args: VerifierSelectArgs): Promise<Record<string, any>> {
          const criteria = parseCriteria(args.criteria)
          const cacheKey = JSON.stringify({
            type: 'select', problem: args.problem, candidates: args.candidates, criteria,
            model: args.model, n_evaluations: args.n_evaluations, pivots: args.pivots,
            images: args.images, seed: args.seed, max_workers: args.max_workers,
          })
          return cached(cacheKey, async () => (await getBridge()).request<Record<string, any>>('select', {
            problem: args.problem,
            candidates: args.candidates,
            ...(criteria !== undefined ? { criteria } : {}),
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.n_evaluations !== undefined ? { n_evaluations: args.n_evaluations } : {}),
            ...(args.pivots !== undefined ? { pivots: args.pivots } : {}),
            ...(args.images !== undefined ? { images: args.images } : {}),
            ...(args.seed !== undefined ? { seed: args.seed } : {}),
            ...(args.max_workers !== undefined ? { max_workers: args.max_workers } : {}),
          }))
        },
      })),

      ctx.tools.register(defineTool({
        name: 'verifier_compare',
        description:
          'Compare two candidate answers/trajectories and return fine-grained rewards in [0,1] using LLM-as-a-Verifier. To keep latency/cost low, prefer n_evaluations=1.',
        parameters: {
          problem: { type: 'string', required: true, description: 'Task/problem statement.' },
          candidate_a: { type: 'string', required: true, description: 'First candidate trajectory/answer.' },
          candidate_b: { type: 'string', required: true, description: 'Second candidate trajectory/answer.' },
          criteria: { type: 'string', required: true, description: 'Evaluation criteria preset name or JSON object string. Required by the verifier backend.' },
          model: { type: 'string', description: 'Verifier model id.' },
          n_evaluations: { type: 'number', description: 'Repeated evaluations per criterion.' },
          images: { type: 'array', items: { type: 'string' }, description: 'Optional images for multimodal verification.' },
          seed: { type: 'number', description: 'Random seed.' },
        },
        output: {
          schema: LOOSE_OBJECT_SCHEMA,
          render: (_args, value: Record<string, any>) => [
            { type: 'text', text: `reward_a=${value.reward_a}\nreward_b=${value.reward_b}` },
          ],
        },
        async execute(args: VerifierCompareArgs): Promise<Record<string, any>> {
          const criteria = parseCriteria(args.criteria)
          const cacheKey = JSON.stringify({
            type: 'compare', problem: args.problem,
            candidate_a: args.candidate_a, candidate_b: args.candidate_b, criteria,
            model: args.model, n_evaluations: args.n_evaluations, images: args.images, seed: args.seed,
          })
          return cached(cacheKey, async () => (await getBridge()).request<Record<string, any>>('compare', {
            problem: args.problem,
            candidate_a: args.candidate_a,
            candidate_b: args.candidate_b,
            ...(criteria !== undefined ? { criteria } : {}),
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.n_evaluations !== undefined ? { n_evaluations: args.n_evaluations } : {}),
            ...(args.images !== undefined ? { images: args.images } : {}),
            ...(args.seed !== undefined ? { seed: args.seed } : {}),
          }))
        },
      })),

      ctx.tools.register(defineTool({
        name: 'verifier_track',
        description:
          'Score a finished agent trajectory step-by-step with LLM-as-a-Verifier. Pass the full ordered steps; returns a progress score per step.',
        parameters: {
          problem: { type: 'string', required: true, description: 'Task/problem statement.' },
          steps: { type: 'array', items: { type: 'string' }, required: true, description: 'Ordered trajectory steps (strings).' },
          checkpoint_steps: { type: 'array', items: { type: 'number' }, description: 'Optional 1-based checkpoint indices to score; defaults to every step.' },
          model: { type: 'string', description: 'Verifier model id.' },
          n_evaluations: { type: 'number', description: 'Repeated evaluations per criterion.' },
          images: { type: 'array', items: { type: 'string' }, description: 'Optional images for multimodal verification.' },
          seed: { type: 'number', description: 'Random seed.' },
        },
        output: {
          schema: LOOSE_OBJECT_SCHEMA,
          render: (_args, value: Record<string, any>) => [
            { type: 'text', text: `Progress scores: ${JSON.stringify(value.scores)}` },
          ],
        },
        async execute(args: VerifierTrackArgs): Promise<Record<string, any>> {
          const criteria = parseCriteria(args.criteria)
          return (await getBridge()).request<Record<string, any>>('track', {
            problem: args.problem,
            steps: args.steps,
            ...(args.checkpoint_steps !== undefined ? { checkpoint_steps: args.checkpoint_steps } : {}),
            ...(criteria !== undefined ? { criteria } : {}),
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.n_evaluations !== undefined ? { n_evaluations: args.n_evaluations } : {}),
            ...(args.images !== undefined ? { images: args.images } : {}),
            ...(args.seed !== undefined ? { seed: args.seed } : {}),
          })
        },
      })),

      ctx.tools.register(defineTool({
        name: 'verifier_progress',
        description:
          'Manage a live LLM-as-a-Verifier ProgressTracker. action="start" creates a tracker for a problem and returns tracker_id; action="update" feeds one step and returns the current progress score; action="close" releases the tracker.',
        parameters: {
          action: { type: 'string', enum: ['start', 'update', 'close'], required: true, description: 'start | update | close' },
          tracker_id: { type: 'string', description: 'Required for update/close.' },
          problem: { type: 'string', description: 'Task/problem statement; required for start.' },
          step: { type: 'string', description: 'Next agent step text; required for update.' },
          model: { type: 'string', description: 'Verifier model id.' },
          n_evaluations: { type: 'number', description: 'Repeated evaluations per criterion.' },
          images: { type: 'array', items: { type: 'string' }, description: 'Optional images for the current step.' },
          seed: { type: 'number', description: 'Random seed.' },
        },
        output: {
          schema: LOOSE_OBJECT_SCHEMA,
          render: (_args, value: Record<string, any>) => [
            { type: 'text', text: JSON.stringify(value) },
          ],
        },
        async execute(args: VerifierProgressArgs): Promise<Record<string, any>> {
          const bridge = await getBridge()
          switch (args.action) {
            case 'start': {
              if (!args.problem) throw new Error('verifier_progress start requires `problem`')
              const criteria = parseCriteria(args.criteria)
              const result = await bridge.request<Record<string, any>>('progress_start', {
                problem: args.problem,
                ...(criteria !== undefined ? { criteria } : {}),
                ...(args.model !== undefined ? { model: args.model } : {}),
                ...(args.n_evaluations !== undefined ? { n_evaluations: args.n_evaluations } : {}),
                ...(args.seed !== undefined ? { seed: args.seed } : {}),
              })
              if (typeof result?.tracker_id === 'string') {
                recordProgressStart(result.tracker_id, args.problem, args.model, args.n_evaluations)
              }
              return result
            }
            case 'update': {
              if (!args.tracker_id) throw new Error('verifier_progress update requires `tracker_id`')
              if (!args.step) throw new Error('verifier_progress update requires `step`')
              const result = await bridge.request<Record<string, any>>('progress_update', {
                tracker_id: args.tracker_id,
                step: args.step,
                ...(args.images !== undefined ? { images: args.images } : {}),
              })
              if (typeof result?.score === 'number') {
                recordProgressUpdate(args.tracker_id, args.step, result.score)
              }
              return result
            }
            case 'close': {
              if (!args.tracker_id) throw new Error('verifier_progress close requires `tracker_id`')
              const result = await bridge.request<Record<string, any>>('progress_close', { tracker_id: args.tracker_id })
              recordProgressClose(args.tracker_id)
              return result
            }
          }
        },
      })),

      ctx.tools.register(defineTool({
        name: 'verifier_task_start',
        description:
          'Start a long-running verifier task asynchronously and return a task_id immediately. Supported methods: select, compare, track. Poll with verifier_task_status.',
        parameters: {
          method: { type: 'string', enum: ['select', 'compare', 'track'], required: true, description: 'Verifier method to run in background.' },
          params: { type: 'string', required: true, description: 'JSON object string with the method arguments (same as the synchronous tool, e.g. {"problem":"...","candidates":[...],"criteria":"...","n_evaluations":1,"pivots":2}).' },
        },
        output: {
          schema: LOOSE_OBJECT_SCHEMA,
          render: (_args, value: Record<string, any>) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args: any): Promise<Record<string, any>> {
          let params: any
          try {
            params = JSON.parse(String(args.params ?? '').trim())
          } catch {
            return { error: 'params must be a valid JSON object string' }
          }
          if (typeof params?.criteria === 'string' && /^[[{]/.test(params.criteria.trim())) {
            try {
              params.criteria = JSON.parse(params.criteria)
            } catch {
              // keep raw string
            }
          }
          const taskId = `verifier-${++verifierTaskSeq}`
          const task: VerifierTask = { promise: Promise.resolve(), settled: false }
          task.promise = getBridge()
            .then((bridge) => bridge.request<any>(args.method, params))
            .then(
              (result) => {
                task.settled = true
                task.result = result
                return result
              },
              (error) => {
                task.settled = true
                task.error = error instanceof Error ? error.message : String(error)
                throw error
              },
            )
          verifierTasks.set(taskId, task)
          return { task_id: taskId, status: 'running', hint: `use verifier_task_status with task_id=${taskId} to poll` }
        },
      })),

      ctx.tools.register(defineTool({
        name: 'verifier_task_status',
        description: 'Check the status of an asynchronous verifier task started with verifier_task_start.',
        parameters: {
          task_id: { type: 'string', required: true, description: 'Task id returned by verifier_task_start.' },
        },
        output: {
          schema: LOOSE_OBJECT_SCHEMA,
          render: (_args, value: Record<string, any>) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args: any): Promise<Record<string, any>> {
          const task = verifierTasks.get(args.task_id)
          if (!task) return { task_id: args.task_id, status: 'unknown' }
          if (!task.settled) return { task_id: args.task_id, status: 'running' }
          if (task.error !== undefined) return { task_id: args.task_id, status: 'error', error: task.error }
          return { task_id: args.task_id, status: 'done', result: task.result }
        },
      })),
    ]
    return () => disposers.forEach((dispose) => dispose())
  })
}
