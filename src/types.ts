/** Shared public types for the LLM-as-a-Verifier DSH plugin. */

export type Criteria = string | Record<string, string>

export interface VerifierSelectArgs {
  problem: string
  candidates: string[]
  criteria?: string
  model?: string
  n_evaluations?: number
  pivots?: number
  images?: string[]
  seed?: number
  max_workers?: number
}

export interface VerifierSelectResult {
  index: number | null
  ranking?: unknown[] | null
  scores?: number[] | null
}

export interface VerifierCompareArgs {
  problem: string
  candidate_a: string
  candidate_b: string
  criteria?: string
  model?: string
  n_evaluations?: number
  images?: string[]
  seed?: number
}

export interface VerifierCompareResult {
  reward_a: number
  reward_b: number
}

export interface VerifierTrackArgs {
  problem: string
  steps: string[]
  checkpoint_steps?: number[]
  criteria?: string
  model?: string
  n_evaluations?: number
  images?: string[]
  seed?: number
}

export interface VerifierTrackResult {
  scores: number[]
}

export type VerifierProgressAction = 'start' | 'update' | 'close'

export interface VerifierProgressArgs {
  action: VerifierProgressAction
  tracker_id?: string
  problem?: string
  step?: string
  criteria?: string
  model?: string
  n_evaluations?: number
  images?: string[]
  seed?: number
}

export interface VerifierProgressResult {
  tracker_id?: string
  score?: number
  closed?: boolean
}

/** Wire result returned by the Python bridge. */
export interface BridgeResponse<T> {
  id: string | number | null
  ok: true
  result: T
}

export interface BridgeErrorResponse {
  id: string | number | null
  ok: false
  error: {
    type: string
    message: string
  }
}
