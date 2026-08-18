# LLM Verifier 插件方案（PLAN）

## 目标

把官方 `llm-as-a-verifier` 的 `select` / `compare` / `track` / `ProgressTracker` 能力以 DSH agent 工具形式暴露出来，让 DSH 内的 agent 可以对候选答案、轨迹和渐进式任务做 LLM-as-a-Verifier 评估。

## 技术路线（当前选择）

**Python stdio 桥 MVP**：DSH Host 插件（Node/TS）通过 JSON Lines over stdin/stdout 与 Python 桥通信，Python 侧直接复用官方 `llm-verifier` 包，DSH 侧只负责进程/JSON 管道和工具契约。

选这个路线的原因：

- 官方包成熟，避免从零实现 logprobs 后端接入。
- Python 桥与 DSH Host 解耦，便于独立测试。
- 验证价值后再考虑 TS 原生移植。

## 架构

```
DSH Agent
  ↓ 调用 verifier_select / verifier_compare / verifier_track / verifier_progress
DSH Host 插件（Node/TS, lib/）
  ↓ JSON Lines over stdin/stdout
Python 桥（bridge/llm_verifier_bridge.py）
  ↓
llm-verifier（官方 Python 包）
  ↓
DeepSeek / Gemini / vLLM 等支持 logprobs 的后端
```

## 工具契约

| DSH 工具 | 对应官方能力 | 主要参数 | 返回 |
|---|---|---|---|
| `verifier_select` | select | `problem`, `candidates`, `criteria`, `model`, `n_evaluations`, `pivots`, `images`, `seed`, `max_workers` | `index` / `ranking` / `scores` |
| `verifier_compare` | compare | `problem`, `candidate_a`, `candidate_b`, `criteria`, `model`, `n_evaluations`, `images`, `seed` | `reward_a` / `reward_b` |
| `verifier_track` | track | `problem`, `steps`, `checkpoint_steps`, `criteria`, `model`, `n_evaluations`, `images`, `seed` | `scores` |
| `verifier_progress` | ProgressTracker | `action=start/update/close`, `problem`, `tracker_id`, `step` | `tracker_id` / `score` |

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `pythonBin` | `python3` / `python`(Windows) | Python 可执行文件 |
| `bridgeTimeoutMs` | `120000` | 单次桥调用超时（毫秒） |
| `verifierModel` | 无 | 默认 verifier 模型 id |

## 关键决策记录

- 桥独立走官方包配置的后端，不依赖 DSH `ctx.llm`，因为 DSH 的流式接口不暴露 logprobs。
- 凭据通过 DSH 启动环境变量（如 `DEEPSEEK_API_KEY` / `VERTEX_API_KEY`）透传给桥进程。
