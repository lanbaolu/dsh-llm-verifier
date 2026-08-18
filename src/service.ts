/**
 * Verifier Evaluator service seam.
 *
 * Exposes the llm-verifier bridge as a Cordis service (`ctx.verifierEvaluator`)
 * so other DSH plugins / workflows / commands can reuse the same Python bridge
 * without going through the model-facing tools.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PythonBridge } from './bridge.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    verifierEvaluator: VerifierEvaluatorService
  }
}

export class VerifierEvaluatorService extends Service {
  constructor(
    ctx: Context,
    private readonly getBridge: () => Promise<PythonBridge>,
  ) {
    super(ctx, 'verifierEvaluator')
  }

  async select(params: Record<string, unknown>): Promise<any> {
    return (await this.getBridge()).request('select', params)
  }

  async compare(params: Record<string, unknown>): Promise<any> {
    return (await this.getBridge()).request('compare', params)
  }

  async track(params: Record<string, unknown>): Promise<any> {
    return (await this.getBridge()).request('track', params)
  }

  async progressStart(params: Record<string, unknown>): Promise<any> {
    return (await this.getBridge()).request('progress_start', params)
  }

  async progressUpdate(params: Record<string, unknown>): Promise<any> {
    return (await this.getBridge()).request('progress_update', params)
  }

  async progressClose(params: Record<string, unknown>): Promise<any> {
    return (await this.getBridge()).request('progress_close', params)
  }
}
