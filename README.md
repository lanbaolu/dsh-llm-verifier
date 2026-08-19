# @dsh-external/dsh-llm-verifier

> [!WARNING]
> ## ⚠️ 实验阶段（Experimental）
> 本插件**仍处于实验阶段**，尚未达到稳定可用标准，请勿在生产环境启用；如需联调，建议在隔离的 profile / 会话中验证。
> 当前已确认的稳定性风险：
> - Python stdio 桥向 DeepSeek API 发送不被接受的 `image_url` 消息格式（该 API 端点只接受 `text`），曾导致 DSH 启动期 `fatal load failure`；
> - 依赖 verifier 后端返回 `logprobs`，`ctx.llm` 流式接口不暴露，桥独立走官方包配置的后端；
> - 异步任务表与 Web UI 分数曲线均为**进程内内存态**，DSH 重启/插件重载后任务丢失；
> - 插件通过 super-injector（插件注入管理器）注入时，需保证 `cordis.patch.yml` 的 disabled 用与 registry 一致的完整包名（如 `@lanbaolu/dsh-llm-verifier`），否则重启会被自动恢复加载。

LLM-as-a-Verifier bridge for DSH：通过 Python stdio 桥把 `select` / `compare` / `track` / `ProgressTracker` 暴露成 DSH agent 工具。

> 当前实现：**Python stdio 桥 MVP**。Python 侧直接复用官方 [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) 包，DSH 侧只负责进程/JSON 管道和工具契约。验证有价值后，再考虑 TS 原生移植。

## 文档

- [方案（PLAN）](docs/PLAN.md)
- [进度（PROGRESS）](docs/PROGRESS.md)
- [方向（ROADMAP）](docs/ROADMAP.md)

## 架构

```
DSH Agent
  ↓ 调用 verifier_select / verifier_compare / verifier_track / verifier_progress
DSH Host 插件（Node/TS, lib/）
  ↓ JSON Lines over stdin/stdout
Python 桥（lib/bridge/llm_verifier_bridge.py）
  ↓
llm-verifier（官方 Python 包）
  ↓
DeepSeek / Gemini / vLLM 等支持 logprobs 的后端
```

## 安装

### 1. 安装 Python 依赖

推荐使用插件自带虚拟环境（避免 Homebrew Python 的 PEP 668 限制）：

```bash
cd llm-verifier
python3 -m venv .venv
.venv/bin/pip install llm-verifier
```

然后把插件 `pythonBin` 配置为虚拟环境 Python 的绝对路径（见下文）。

也可以直接安装到系统/用户环境：

```bash
pip install llm-verifier
```

桥进程会自动读取 Harness 已配置的模型凭据（`ctx.credentials` 中的 `DEEPSEEK_API_KEY` / `VERTEX_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL`），无需手动设置环境变量；也支持通过 DSH 启动环境或插件根目录 `.env` 提供凭据。

后端选择优先级（官方 `llm-verifier` 规则）：`OPENAI_BASE_URL` > `DEEPSEEK_API_KEY` > `VERTEX_API_KEY`。调用工具时传 `model` 可指定具体模型，例如 `model="gemini-2.5-flash"`、`model="deepseek-v4-flash"` 或 vLLM 上托管的模型名。

### 2. 构建插件

需要 DSH 源码 checkout（提供 `tsc` 和类型包）：

```bash
DSH_CHECKOUT=<dsh-source-checkout> bash scripts/build.sh
```

构建产物：

- `lib/index.js` / `lib/bridge.js` / `lib/tools.js`：Host 插件
- `lib/bridge/llm_verifier_bridge.py`：Python 桥（随包分发）
- `lib/client.js`：Web 设置面板（`npm run build:client`，或直接 `npm run build` 一起构建）

### 3. 注入 / 安装

开发环境（运行时注入，免重启）：

```text
dev_inject_plugin { "dir": "/path/to/llm-verifier" }
```

正式安装（bundle）：

```bash
dsh plugin --profile web add /path/to/llm-verifier
```

重启后插件通过 `cordis.patch.yml` 挂载。

## 插件配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `pythonBin` | `python3` / `python`(Windows) | Python 可执行文件 |
| `bridgeTimeoutMs` | `300000` | 单次桥调用超时（毫秒） |
| `verifierModel` | 无 | 默认 verifier 模型 id，工具未传 `model` 时透传为 `LLM_VERIFIER_MODEL`（当前桥未强制消费，官方包自行决定默认后端） |

示例 patch：

```yaml
- insert:
    - id: dsh-llm-verifier
      name: '@dsh-external/dsh-llm-verifier'
      config:
        pythonBin: python3
        bridgeTimeoutMs: 180000
        verifierModel: deepseek-v4-flash
```

## Web 设置面板

DSH 设置页会出现 **✅ LLM Verifier** 面板，功能：

- **后端选择**：`自动选择 / DeepSeek / Vertex AI / OpenAI 兼容`，未配置凭据的后端会禁用并提示原因。
- **默认 model / 桥超时**：留空 model 表示使用后端默认模型。
- **分数曲线**：展示 `verifier_progress` 的 ProgressTracker 分数历史（SVG 折线图 + 最近步骤），可清空历史。

配置保存到 `~/.dsh/llm-verifier/config.json`；切换后端/模型后，桥进程会在下一次 verifier 调用时按新配置重启，无需重启 DSH。

## DSH 工具

### `verifier_select`

从多个候选答案/轨迹中选最优。

- `problem`: 任务描述
- `candidates`: 候选字符串数组
- `criteria`（必填）：preset 名或 JSON 对象字符串，例如 `{"Correctness":"..."}`
- 可选：`model`、`n_evaluations`、`pivots`、`images`、`seed`、`max_workers`
- 返回：`index` / `ranking` / `scores`

### `verifier_compare`

两两比较两个候选，返回细粒度奖励。

- `problem` / `candidate_a` / `candidate_b`
- `criteria`（必填）：preset 名或 JSON 对象字符串
- 可选：`model`、`n_evaluations`、`images`、`seed`
- 返回：`reward_a` / `reward_b`

### `verifier_track`

给已完成轨迹逐步打分。

- `problem` / `steps`（有序步骤数组）
- 可选：`checkpoint_steps`、`model`、`n_evaluations`、`images`、`seed`
- 返回：`scores`

### `verifier_progress`

管理在线 `ProgressTracker`。

- `action=start`：传入 `problem`，返回 `tracker_id`
- `action=update`：传入 `tracker_id` + `step`，返回当前 `score`
- `action=close`：传入 `tracker_id`，释放 tracker

### `verifier_task_start` / `verifier_task_status`

异步执行长任务。

- `verifier_task_start`：传 `method`（select/compare/track）+ `params`（JSON 字符串），立即返回 `task_id`
- `verifier_task_status`：传 `task_id`，返回 `running` / `done` / `error`

## 使用方式：主要给 Agent 自动用

这套工具的主要使用方式是 **agent 在任务中自动调用**，不需要你手动敲命令。你只需要在对话里自然描述需求，agent 会在合适时机使用：

| 你的话 | agent 会做什么 |
|---|---|
| “从这几个方案里选最好的” | 调 `verifier_select` |
| “对比一下这两个实现” | 调 `verifier_compare` |
| “帮我复盘一下刚才的解题过程” | 调 `verifier_track` |
| “这个任务很长，边做边跟踪进度” | 调 `verifier_progress` |
| “评分可能很久，用异步方式跑” | 调 `verifier_task_start` + `verifier_task_status` |

### 对话示例

```
从这 3 个反转字符串实现里选最优：
criteria={"Correctness":"是否正确反转"}
candidates=["def reverse(s): return s[::-1]", "def reverse(s): return ''.join(reversed(s))", "用循环实现"]
```

```
对比这两个去重方案，criteria={"Correctness":"是否正确去重并保持顺序"}
方案A：return [...new Set(arr)]
方案B：return arr.filter((v, i) => arr.indexOf(v) === i)
```

### 手动命令（可选）

- `/bestofn {"problem":"...","candidates":["...","..."]}`：不走模型，直接跑选优
- `/evaluate-session`：给当前会话轨迹打分并导出 JSONL

## 当前状态与限制

- ✅ Python stdio 桥：`ping` / `select` / `compare` / `track` / `progress_*` 已实现
- ✅ DSH Host 插件：四个核心工具 + 异步任务工具已注册，插件已可注入
- ✅ 已安装 `llm-verifier 0.2.0` 到 `.venv`
- ✅ **四个核心工具真实端到端调用全部跑通**（DeepSeek 后端）
- ✅ 自动复用 Harness `ctx.credentials` 中的模型凭据，无需用户单独配 key
- ✅ P1 完成：`/bestofn`、结果缓存、异步任务、超时优化
- ✅ P2 完成：`ctx.verifierEvaluator` 服务、`/evaluate-session` 轨迹评分导出、Web 设置面板（后端选择 + 分数曲线）
- ✅ 已验证：真实长任务异步体验（`verifier_task_start` 立即返回 `running`，轮询 `verifier_task_status` 最终 `done`；实测 select 3 候选约 207s）
- ⚠️ 依赖 verifier 后端返回 logprobs；DSH 的 `ctx.llm` 流式接口不暴露 logprobs，桥独立走官方包配置的后端
- ⚠️ 异步任务表为进程内内存态，DSH/插件重载后任务变 `unknown`；Python 桥单进程串行处理 stdin，多异步任务排队执行
- ⏭️ 详细进度见 [docs/PROGRESS.md](docs/PROGRESS.md) 和 [docs/ROADMAP.md](docs/ROADMAP.md)
