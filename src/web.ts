/**
 * Same-origin Web routes for the LLM Verifier settings panel.
 *
 * The DSH web server serves these routes under /@lanbaolu/dsh-llm-verifier/*
 * so the client bundle can read/update backend selection and render progress
 * curves without an extra auth token (same security model as other DSH panels).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProgressRecord } from './progress.ts'

export type BackendId = 'auto' | 'deepseek' | 'vertex' | 'openai'

export interface VerifierRuntimeConfig {
  backend: BackendId
  model: string
  pythonBin: string
  bridgeTimeoutMs: number
}

export interface AvailableBackend {
  id: BackendId
  label: string
  configured: boolean
  detail: string
}

export interface SaveConfigInput {
  backend?: BackendId
  model?: string
  pythonBin?: string
  bridgeTimeoutMs?: number
}

export interface VerifierWebDeps {
  getConfig(): VerifierRuntimeConfig
  saveConfig(input: SaveConfigInput): Promise<{ ok: boolean; message: string; restartBridge: boolean }>
  detectBackends(): Promise<AvailableBackend[]>
  listProgress(): ProgressRecord[]
  clearProgress(): void
  getDiagnostics(): string
}

interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

const API_PREFIX = '/@lanbaolu/dsh-llm-verifier'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
      if (raw.length > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

export function registerVerifierWebRoutes(ctx: Context, deps: VerifierWebDeps): (() => void)[] {
  const webServer = ctx.get('webServer') as { register(route: WebRouteLike): () => void } | undefined
  if (!webServer) return []

  const disposers: (() => void)[] = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/config`,
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          const [backends, config] = await Promise.all([
            deps.detectBackends(),
            Promise.resolve(deps.getConfig()),
          ])
          sendJson(res, 200, {
            ok: true,
            config,
            backends,
            diagnostics: deps.getDiagnostics(),
          })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const input: SaveConfigInput = {}
        if (body.backend !== undefined) {
          const backend = String(body.backend)
          if (!['auto', 'deepseek', 'vertex', 'openai'].includes(backend)) {
            sendJson(res, 400, { ok: false, error: `invalid backend: ${backend}` })
            return
          }
          input.backend = backend as BackendId
        }
        if (body.model !== undefined) input.model = String(body.model)
        if (body.pythonBin !== undefined) input.pythonBin = String(body.pythonBin)
        if (body.bridgeTimeoutMs !== undefined) {
          const value = Number(body.bridgeTimeoutMs)
          if (!Number.isFinite(value) || value < 1_000 || value > 3_600_000) {
            sendJson(res, 400, { ok: false, error: 'bridgeTimeoutMs must be between 1000 and 3600000' })
            return
          }
          input.bridgeTimeoutMs = value
        }
        const result = await deps.saveConfig(input)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/progress`,
    handler: async (_req, res) => {
      sendJson(res, 200, { ok: true, records: deps.listProgress() })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/progress/clear`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      deps.clearProgress()
      sendJson(res, 200, { ok: true })
    },
  }))

  return disposers
}
