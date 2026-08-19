import type * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

const API_BASE = '/@lanbaolu/dsh-llm-verifier'

type BackendId = 'auto' | 'deepseek' | 'vertex' | 'openai'

interface BackendItem {
  id: BackendId
  label: string
  configured: boolean
  detail: string
}

interface RuntimeConfig {
  backend: BackendId
  model: string
  pythonBin: string
  bridgeTimeoutMs: number
}

interface ProgressStepRecord {
  index: number
  text: string
  score: number
  at: string
}

interface ProgressRecord {
  trackerId: string
  problem: string
  createdAt: string
  status: 'active' | 'closed'
  steps: ProgressStepRecord[]
}

const panelStyle: React.CSSProperties = {
  padding: '14px 16px',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--text-1, #1f2328)',
  background: 'var(--surface-2, rgba(127,127,127,.06))',
  border: '1px solid var(--border-color, rgba(127,127,127,.18))',
  borderRadius: 10,
  margin: '8px 0',
}

const sectionStyle: React.CSSProperties = {
  marginTop: 14,
  paddingTop: 12,
  borderTop: '1px solid var(--border-color, rgba(127,127,127,.15))',
}

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  margin: '0 0 8px',
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-start',
  padding: '6px 8px',
  borderRadius: 6,
  cursor: 'pointer',
}

const labelDisabledStyle: React.CSSProperties = {
  opacity: 0.55,
  cursor: 'not-allowed',
}

const radioStyle: React.CSSProperties = {
  marginTop: 3,
  accentColor: 'var(--primary, #0969da)',
}

const inputStyle: React.CSSProperties = {
  padding: '5px 8px',
  border: '1px solid var(--border-color, rgba(127,127,127,.4))',
  borderRadius: 6,
  background: 'var(--surface-3, rgba(127,127,127,.06))',
  color: 'var(--text-1, inherit)',
  fontSize: 12,
  minWidth: 220,
}

const buttonStyle: React.CSSProperties = {
  padding: '5px 12px',
  border: '1px solid var(--border-color, rgba(127,127,127,.4))',
  borderRadius: 6,
  background: 'var(--button-bg, #fff)',
  color: 'var(--text-1, inherit)',
  cursor: 'pointer',
  fontSize: 12,
}

const messageStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
}

const hintStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  opacity: 0.7,
}

const emptyStyle: React.CSSProperties = {
  padding: '16px',
  textAlign: 'center',
  opacity: 0.7,
  border: '1px dashed var(--border-color, rgba(127,127,127,.25))',
  borderRadius: 8,
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.min(1, Math.max(0, score))
}

function ScoreChart({ steps }: { steps: ProgressStepRecord[] }): React.JSX.Element {
  const width = 640
  const height = 220
  const padding = { top: 16, right: 16, bottom: 28, left: 40 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const lastIndex = Math.max(steps.length - 1, 0)

  const x = (index: number): number => (
    padding.left + (steps.length <= 1 ? chartWidth / 2 : (index / lastIndex) * chartWidth)
  )
  const y = (score: number): number => (
    padding.top + (1 - clampScore(score)) * chartHeight
  )

  const points = steps.map((step) => `${x(step.index)},${y(step.score)}`).join(' ')
  const gridLines = [0, 0.25, 0.5, 0.75, 1]

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="ProgressTracker 分数曲线"
      style={{ width: '100%', maxWidth: width, height: 'auto', display: 'block' }}
    >
      {gridLines.map((value) => {
        const lineY = y(value)
        return (
          <g key={value}>
            <line
              x1={padding.left}
              y1={lineY}
              x2={width - padding.right}
              y2={lineY}
              stroke="var(--border-color, rgba(127,127,127,.2))"
              strokeWidth={1}
            />
            <text
              x={padding.left - 6}
              y={lineY + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--text-2, #59636e)"
            >
              {value.toFixed(2)}
            </text>
          </g>
        )
      })}
      {steps.length > 0 && (
        <polyline
          points={points}
          fill="none"
          stroke="var(--primary, #0969da)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {steps.map((step) => (
        <g key={step.index}>
          <circle cx={x(step.index)} cy={y(step.score)} r={3.5} fill="var(--primary, #0969da)" />
          <text
            x={x(step.index)}
            y={height - 8}
            textAnchor="middle"
            fontSize={10}
            fill="var(--text-2, #59636e)"
          >
            {step.index + 1}
          </text>
        </g>
      ))}
    </svg>
  )
}

export function LlmVerifierPanel(_props: SettingsSectionOwnerProps): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)

  const [config, setConfig] = useState<RuntimeConfig | null>(null)
  const [backends, setBackends] = useState<BackendItem[]>([])
  const [backend, setBackend] = useState<BackendId>('auto')
  const [model, setModel] = useState('')
  const [bridgeTimeoutMs, setBridgeTimeoutMs] = useState(300_000)

  const [progress, setProgress] = useState<ProgressRecord[]>([])
  const [selectedTrackerId, setSelectedTrackerId] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [configRes, progressRes] = await Promise.all([
        fetch(`${API_BASE}/config`, { cache: 'no-store' }),
        fetch(`${API_BASE}/progress`, { cache: 'no-store' }),
      ])
      if (!configRes.ok) throw new Error(`config HTTP ${configRes.status}`)
      if (!progressRes.ok) throw new Error(`progress HTTP ${progressRes.status}`)
      const configData = await configRes.json()
      const progressData = await progressRes.json()
      if (!configData.ok) throw new Error(configData.error || '加载配置失败')
      setConfig(configData.config)
      setBackends(configData.backends ?? [])
      setBackend(configData.config.backend)
      setModel(configData.config.model ?? '')
      setBridgeTimeoutMs(configData.config.bridgeTimeoutMs ?? 300_000)
      const records = Array.isArray(progressData.records) ? progressData.records as ProgressRecord[] : []
      setProgress(records)
      setSelectedTrackerId((prev) => {
        if (records.some((item) => item.trackerId === prev)) return prev
        return records[0]?.trackerId ?? ''
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selectedTracker = useMemo(
    () => progress.find((item) => item.trackerId === selectedTrackerId) ?? progress[0],
    [progress, selectedTrackerId],
  )

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    setMessage('')
    try {
      const res = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backend,
          model: model.trim(),
          bridgeTimeoutMs: Number(bridgeTimeoutMs) || 300_000,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || data?.message || `HTTP ${res.status}`)
      }
      setMessage(data.message || '配置已保存')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function clearHistory(): Promise<void> {
    setClearing(true)
    setError(null)
    setMessage('')
    try {
      const res = await fetch(`${API_BASE}/progress/clear`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      setMessage('已清空 ProgressTracker 历史')
      setProgress([])
      setSelectedTrackerId('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
    }
  }

  if (loading) {
    return (
      <div style={panelStyle} aria-busy="true" aria-label="LLM Verifier 面板加载中">
        加载中…
      </div>
    )
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={titleStyle}>LLM Verifier</h2>
        {config && (
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            Python：{config.pythonBin} · 超时 {Math.round(config.bridgeTimeoutMs / 1000)}s
          </span>
        )}
      </div>

      <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>后端选择</legend>
        <div role="radiogroup" aria-label="Verifier 后端">
          {backends.map((item) => {
            const disabled = !item.configured
            return (
              <label
                key={item.id}
                style={disabled ? { ...labelStyle, ...labelDisabledStyle } : labelStyle}
                aria-disabled={disabled}
              >
                <input
                  type="radio"
                  name="verifier-backend"
                  style={radioStyle}
                  checked={backend === item.id}
                  disabled={disabled}
                  onChange={() => setBackend(item.id)}
                />
                <span>
                  <strong>{item.label}</strong>
                  <span style={{ display: 'block', fontSize: 12, opacity: 0.75 }}>{item.detail}</span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12 }}>模型（留空 = 后端默认）</span>
          <input
            type="text"
            style={inputStyle}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="deepseek-v4-flash / gemini-2.5-flash"
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12 }}>桥超时（毫秒）</span>
          <input
            type="number"
            style={{ ...inputStyle, minWidth: 140 }}
            value={bridgeTimeoutMs}
            min={1000}
            max={3_600_000}
            step={10_000}
            onChange={(event) => setBridgeTimeoutMs(Number(event.target.value))}
          />
        </label>
        <button type="button" style={buttonStyle} disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存配置'}
        </button>
      </div>

      {error && (
        <div style={{ ...messageStyle, color: 'var(--danger, #d1242f)' }} role="alert">
          {error}
        </div>
      )}
      {message && (
        <div style={{ ...messageStyle, color: 'var(--success, #1a7f37)' }} role="status">
          {message}
        </div>
      )}

      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ ...titleStyle, margin: 0 }}>ProgressTracker 分数曲线</h3>
          <button type="button" style={buttonStyle} disabled={clearing || progress.length === 0} onClick={() => void clearHistory()}>
            {clearing ? '清空中…' : '清空历史'}
          </button>
        </div>

        {progress.length === 0 ? (
          <div style={{ ...emptyStyle, marginTop: 10 }}>
            暂无 ProgressTracker 记录。agent 调用 <code>verifier_progress</code> 后，分数曲线会显示在这里。
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12 }}>选择 tracker</span>
              <select
                style={{ ...inputStyle, minWidth: 320 }}
                value={selectedTracker?.trackerId ?? ''}
                onChange={(event) => setSelectedTrackerId(event.target.value)}
              >
                {progress.map((item) => (
                  <option key={item.trackerId} value={item.trackerId}>
                    {item.trackerId} · {item.status === 'active' ? '进行中' : '已关闭'} · {item.problem.slice(0, 40)}
                  </option>
                ))}
              </select>
            </label>

            {selectedTracker && (
              <>
                <p style={{ margin: '8px 0 4px', fontSize: 12, wordBreak: 'break-word' }}>
                  {selectedTracker.problem}
                </p>
                <ScoreChart steps={selectedTracker.steps} />
                {selectedTracker.steps.length === 0 && (
                  <div style={emptyStyle}>该 tracker 还没有 update 记录。</div>
                )}
                <ol style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 12 }}>
                  {selectedTracker.steps.slice(-5).map((step) => (
                    <li key={step.index} style={{ marginBottom: 4 }}>
                      <span style={{ opacity: 0.75 }}>
                        Step {step.index + 1} · 分数 {clampScore(step.score).toFixed(3)}：
                      </span>{' '}
                      <span style={{ opacity: 0.9 }}>{step.text.slice(0, 120)}{step.text.length > 120 ? '…' : ''}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </div>

      <div style={hintStyle}>
        配置保存在 <code>~/.dsh/llm-verifier/config.json</code>，切换后端/模型后桥进程会在下一次 verifier 调用时按新配置启动；分数曲线历史为进程内存态，重启 DSH 后清空。
      </div>
    </div>
  )
}
