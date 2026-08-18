# LLM Verifier 插件方向方案（ROADMAP）

## 目标：对齐官方 LLM-as-a-Verifier 的设计目的

官方 `llm-as-a-verifier` 的核心目的不是“提供一个打分 API”，而是给 agent 提供 **可用于决策的细粒度反馈**：

1. **Best-of-N 测试时扩展**：同一任务生成多个候选轨迹，用细粒度 reward 选出最优。
2. **在线进度追踪**：agent 每执行一步，就获得“当前离成功有多近”的连续信号，低分时及时调整策略。
3. **可复用奖励信号**：细粒度分数可作为强化学习 / 数据筛选 / 轨迹评估的 reward。
4. **多模态 / 多后端**：同一套验证框架适用于文本、图像等多模态输入，以及 DeepSeek / Gemini / vLLM 等后端。

我们这套 DSH 插件的方向，就是**在 DSH 内把这些目的变成 agent 可自动使用的基础能力**，而不仅仅是“能调用官方 Python 包”。

---

## 现状评估：现在能实现官方目的吗？

**结论：核心能力已具备，但还只是“工具可用”，尚未形成“自动闭环”。**

| 官方目的 | 当前状态 |
|---|---|
| 细粒度评分 | ✅ `select` / `compare` / `track` / `progress` 已真实跑通 |
| Best-of-N 选优 | ✅ agent 可以调用 `verifier_select` 完成，但需要 agent 自己知道去用 |
| 在线进度追踪 | ✅ `verifier_progress` 可用，但还没有自动挂到 agent loop 上 |
| 强化学习 / 数据筛选 | ⚠️ 分数可产出，但还没有导出、缓存、批处理能力 |
| 多模态 | ⚠️ 参数已透传 `images`，尚未真实验证 |
| 多后端 | ✅ 支持 DeepSeek / Vertex / OpenAI 兼容，自动读 Harness 凭据 |

所以：**“能用，但还没形成体系”**。下一步方向就是把它从“工具”变成“DSH agent 的自动验证/反馈闭环”。

---

## P0：当前已完成（工具层）

- [x] Python stdio 桥 + 官方 `llm-verifier 0.2.0`
- [x] 四个工具：`verifier_select` / `verifier_compare` / `verifier_track` / `verifier_progress`
- [x] 复用 Harness `ctx.credentials` 凭据，多后端自动选择
- [x] 真实 DeepSeek 端到端验证

## P1：使用闭环（近期，让 agent 真正“会用”）

目标：让 DSH agent 在完成任务时**自动**使用 verifier，而不是等用户手动叫它用。

1. **Agent 使用指南 / preset**
   - 在 DSH agent preset 或系统提示中加入“何时使用 verifier”规则：
     - 多候选决策 → `verifier_select`
     - 两个方案对比 → `verifier_compare`
     - 长任务分步执行 → `verifier_progress`
     - 复盘已完成轨迹 → `verifier_track`
   - 让 agent 在合适时机主动调用，并解释分数含义。

2. **自动 Best-of-N 工作流**
   - 做一个 command / workflow：给定 problem → 并行生成 N 个候选（多个子代理或多次采样）→ 自动 `verifier_select` → 返回最佳候选。
   - 可接入 `dsh-agent-teams`：团队成员各自产出方案，最后由 verifier 选优。

3. **自动进度追踪**
   - 在 agent loop 的关键节点自动调用 `verifier_progress.update`，把分数写回上下文。
   - 低分阈值触发“暂停并调整策略”的提示。

4. **结果缓存**
   - 相同 `problem + candidates + criteria + model + seed` 复用评分结果，避免重复计费。

5. **异步任务**
   - 长评分不阻塞 agent 工具调用，返回任务 id，完成后可取结果。

## P2：深度集成（中期，让 verifier 成为 DSH 的评估基础设施）

1. **Evaluator 服务化**
   - 把 verifier 从“工具”升级为 DSH 的 `evaluator` 服务，供其他插件 / workflow / preset 调用。
   - 统一配置：后端、model、n_evaluations、pivots、超时。

2. **轨迹评估与数据导出**
   - 支持对已完成会话/轨迹批量打分，结果写入会话元数据或导出 JSONL。
   - 可作为 RL 训练数据、数据筛选、Agent 评测集的输入。

3. **与现有插件集成**
   - `dsh-trajectory-debug`：把 verifier 分数叠加到轨迹视图。
   - `dsh-agent-teams`：reviewer 角色用 `verifier_compare/track` 做自动评审。
   - `dsh-usage-stats`：记录 verifier token 消耗。

4. **多模态验证**
   - 真实验证 `images` 参数（截图、图表、UI 图）并补充文档。

5. **Web UI**
   - 在 DSH 设置页选择 verifier 后端/model。
   - 展示 ProgressTracker 分数曲线。

## P3：原生与规模化（远期）

1. **TS 原生移植**
   - 去掉 Python 桥，直接用 TS 实现 logprob 读取与评分逻辑，减少进程开销和部署复杂度。
   - 前提：确认 DSH 可用的后端 API 能稳定返回 logprobs。

2. **自带 benchmark 评测**
   - 接入官方 Terminal-Bench / SWE-Bench / MedAgentBench 数据，作为 DSH 插件自检/发布门槛。

3. **在线学习 / RL 反馈回路**
   - 把 verifier 分数作为 reward signal，接入 DSH 的 agent 策略优化或数据飞轮。

---

## 非目标 / 边界

- 不把 DSH `ctx.llm` 流式接口当作 logprobs 来源（接口不暴露 logprobs）。
- 不重复实现官方算法，优先复用 `llm-verifier` 包，直到 TS 移植被证明必要。
- 不做通用“裁判”产品，聚焦 DSH agent 的验证与反馈场景。

## 建议的下一步（按优先级）

1. 先做 **P1 的 Agent 使用指南**（成本最低，立刻让 agent 主动用起来）。
2. 再做 **自动 Best-of-N command / workflow**（最直接体现官方“测试时扩展”目的）。
3. 然后做 **结果缓存 + 异步任务**（让长任务可用性达标）。
4. 视使用反馈决定是否进入 P2 服务化与 UI。
