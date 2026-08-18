/**
 * Thin stdio JSON-Lines client for the Python LLM-as-a-Verifier bridge.
 *
 * The Python bridge stays alive for the lifetime of this plugin. Requests are
 * correlated by incrementing ids; responses are read line-by-line from the
 * child's stdout. stderr is forwarded as diagnostics only.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { BridgeErrorResponse, BridgeResponse } from './types.ts'

export class BridgeError extends Error {
  readonly type: string

  constructor(type: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.type = type
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export class PythonBridge {
  private child?: ChildProcessWithoutNullStreams
  private lines?: Interface
  private readonly pending = new Map<string, PendingRequest>()
  private seq = 0
  private started = false
  private closed = false
  private readonly stderrTail: string[] = []

  constructor(
    private readonly scriptPath: string | URL,
    private readonly pythonBin: string,
    private readonly timeoutMs: number,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get isRunning(): boolean {
    return this.started && !this.closed && this.child !== undefined
  }

  start(): void {
    if (this.started) return
    this.started = true
    try {
      this.child = spawn(this.pythonBin, ['-u', fileURLToPath(this.scriptPath)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
      })
    } catch (error) {
      this.started = false
      throw new Error(
        `failed to start Python bridge with "${this.pythonBin}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.child.on('error', (error) => {
      this.failAllPending(new BridgeError('PythonBridgeError', `python bridge process error: ${error.message}`))
    })
    this.child.on('exit', (code, signal) => {
      this.failAllPending(
        new BridgeError(
          'PythonBridgeExit',
          `python bridge exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      )
      this.closed = true
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.stderrTail.push(text)
      if (this.stderrTail.length > 20) this.stderrTail.shift()
      process.stderr.write(`[dsh-llm-verifier:python] ${text.trimEnd()}\n`)
    })

    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.start()
    const id = String(++this.seq)
    const payload = JSON.stringify({ id, method, params })

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('BridgeTimeout', `python bridge timed out after ${this.timeoutMs}ms (method=${method})`))
      }, this.timeoutMs)

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })

      if (!this.child?.stdin.writable) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new BridgeError('BridgeClosed', 'python bridge stdin is not writable'))
        return
      }
      this.child.stdin.write(payload + '\n', (error) => {
        if (error) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(new BridgeError('BridgeWriteError', `failed to write to python bridge: ${error.message}`))
        }
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAllPending(new BridgeError('BridgeClosed', 'python bridge was closed'))
    this.lines?.close()
    this.child?.kill('SIGTERM')
    this.child = undefined
  }

  private handleLine(line: string): void {
    let parsed: BridgeResponse<unknown> | BridgeErrorResponse
    try {
      parsed = JSON.parse(line) as BridgeResponse<unknown> | BridgeErrorResponse
    } catch {
      // Non-JSON output on stdout is a protocol violation; ignore but log.
      process.stderr.write(`[dsh-llm-verifier:python] non-JSON stdout: ${line}\n`)
      return
    }
    if (parsed.id === null || parsed.id === undefined) return
    const id = String(parsed.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (parsed.ok) {
      pending.resolve((parsed as BridgeResponse<unknown>).result)
    } else {
      const error = (parsed as BridgeErrorResponse).error
      pending.reject(new BridgeError(error.type, error.message))
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** Last stderr lines for diagnostics (useful when the bridge fails at startup). */
  get diagnostics(): string {
    return this.stderrTail.join('').trim()
  }
}
