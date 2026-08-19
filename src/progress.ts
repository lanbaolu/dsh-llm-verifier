/**
 * In-memory ProgressTracker history.
 *
 * The Python bridge owns the official ProgressTracker instances; this module
 * only records the score timeline so the Web UI can render progress curves.
 * State is intentionally process-local (same lifecycle as the bridge).
 */

export interface ProgressStepRecord {
  index: number
  text: string
  score: number
  at: string
}

export interface ProgressRecord {
  trackerId: string
  problem: string
  createdAt: string
  status: 'active' | 'closed'
  steps: ProgressStepRecord[]
}

const progressRecords = new Map<string, ProgressRecord>()

export function recordProgressStart(
  trackerId: string,
  problem: string,
  model?: string,
  nEvaluations?: number,
): ProgressRecord {
  const record: ProgressRecord = {
    trackerId,
    problem,
    createdAt: new Date().toISOString(),
    status: 'active',
    steps: [],
  }
  progressRecords.set(trackerId, record)
  return record
}

export function recordProgressUpdate(
  trackerId: string,
  step: string,
  score: number,
): ProgressRecord | undefined {
  const record = progressRecords.get(trackerId)
  if (!record) return undefined
  record.steps.push({
    index: record.steps.length,
    text: step,
    score,
    at: new Date().toISOString(),
  })
  return record
}

export function recordProgressClose(trackerId: string): ProgressRecord | undefined {
  const record = progressRecords.get(trackerId)
  if (!record) return undefined
  record.status = 'closed'
  return record
}

export function listProgressRecords(): ProgressRecord[] {
  return [...progressRecords.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function clearProgressRecords(): void {
  progressRecords.clear()
}
