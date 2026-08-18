# LLM Verifier 插件进度（PROGRESS）

## ✅ 已完成

- [x] Python stdio 桥：`ping` / `select` / `compare` / `track` / `progress_*` 已实现。
- [x] DSH Host 插件：四个工具已注册，插件已可注入。
- [x] 插件工程已从 `插件/dsh-llm-verifier` 迁移到独立目录 `llm-verifier/`，与插件仓库其他内容隔离。
- [x] `.venv` 中已安装 `llm-verifier 0.2.0`。
- [x] 桥参数白名单已按官方 API 签名修正（compare 不再传 seed，track/progress 不再传 criteria/seed）。
- [x] 插件自动复用 Harness `ctx.credentials` 中的模型凭据（DeepSeek / Vertex / OpenAI 兼容），无需用户单独配 key。
- [x] **四个工具真实端到端调用全部跑通（DeepSeek 后端）**：
  - `verifier_compare` 返回 reward
  - `verifier_select` 返回 index / scores / ranking
  - `verifier_track` 返回 scores
  - `verifier_progress` start/update/close 全流程正常
- [x] **P1 `/bestofn` 命令**：支持 JSON 参数直接触发 Best-of-N 选优。
- [x] **P1 结果缓存**：相同 `select` / `compare` 请求进程内复用结果，已验证缓存命中。
- [x] **P1 异步任务**：新增 `verifier_task_start` / `verifier_task_status`，长评分不阻塞 agent 工具调用，已验证 select 异步任务完成。
- [x] **P1 超时与参数优化**：默认桥超时提高到 `300s`；`select` / `compare` 的 `criteria` 设为必填；工具描述建议 `n_evaluations=1`、`pivots=2` 控制耗时。
- [x] **P2 Evaluator 服务化**：新增 `ctx.verifierEvaluator` 服务，其他 DSH 插件/命令可直接复用桥能力。
- [x] **P2 轨迹批量评分**：新增 `/evaluate-session` 命令，提取当前会话 assistant 步骤并 `track` 评分，导出到 `scores/<sessionId>.jsonl`。
- [x] **Agent 主动性（层次 1）**：插件向 system prompt 注入“LLM Verifier 使用策略”，引导 agent 自动使用 verifier 工具（不修改 router-standard，不改变工具面）。

## ⚠️ 当前状态与限制

- 后端默认使用 DeepSeek（`DEEPSEEK_API_KEY` 来自 Harness `~/.dsh/.credentials.yaml`，桥进程自动注入）。
- 同时支持 Vertex AI（`VERTEX_API_KEY`）和 OpenAI 兼容后端（`OPENAI_BASE_URL` + `OPENAI_API_KEY`），按官方优先级 `OPENAI_BASE_URL` > `DEEPSEEK_API_KEY` > `VERTEX_API_KEY` 自动选择。
- 依赖 verifier 后端返回 logprobs；DSH 的 `ctx.llm` 流式接口不暴露 logprobs，桥独立走官方包配置的后端。
- DeepSeek 下 `progress` 早期步骤分数可能接近 0，属于官方评分分布特性，链路本身正常。
- 异步任务为进程内内存态，DSH 重启后任务丢失。

## 🚧 待验证

- [ ] 重启 DSH 后确认 super-injector 自动从新路径加载插件（当前已通过热重载验证）。
- [ ] 在真实长任务中观察 `verifier_task_start` / `verifier_task_status` 的体验。

## 迁移记录

- 原位置：`/Users/odis/Desktop/Deepseek Harness/插件/dsh-llm-verifier`
- 新位置：`/Users/odis/Desktop/Deepseek Harness/llm-verifier`
- 注入注册表：`~/.dsh/super-injector/registry.json` 已更新指向新路径。
- `.venv` 脚本（`pip` / `activate` / `pyvenv.cfg`）中硬编码的旧 venv 路径已替换为新路径。
