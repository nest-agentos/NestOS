# Kanban task 执行、编辑与 fix 协作

本规范补充[协调设计](kanban-coordination.md)。`KanbanItem.status` 保留既有责任/验收存储语义；面向用户的阶段统一由 `projectKanbanTask` 投影。实现位于 `libraries/kanban/src/contracts/task-projection.ts`；`item().task`、`query().items[].task`、卡片、详情及 CLI 共用该结果，`phase` 筛选在服务端执行。Session 冷摘要只补充活动和可访问链接，不证明开发成功。

## 状态来源和转换

规则按终态/验收、未解决问题、失败/未知、控制回执、执行、规划/等待顺序投影，所有字段均来自持久事实。表中的“会话”指原 dispatch 的 `executionSessionId`；没有会话时不伪造链接。已开始事项始终可以创建独立 fix 澄清。

| 阶段 | 权威事实/进入条件 | 退出条件、原因与动作 |
| --- | --- | --- |
| 等待启动 `waiting-start` | `launch.startAt`，尚未准入 | run/编辑/取消/暂停；`START_AT_PENDING`、`ADMISSION_PENDING` 或 `EDIT_LEASE_ACTIVE`；编辑中不可 run |
| 分析 `analyzing` | 宿主提交原规划调用、持久 `analysis` | 原调用的通道规划结果、具体失败或未知；不因聊天输出进入执行 |
| 排队 `queued` | `launch.admittedAt`，尚未生成 dispatch | 原计划准入/WIP 容量变化；不另建 Session |
| 等待依赖 `waiting-dependency` | `planning.dependencies` 中存在未完成项 | 仅完成的前置项放行；`DEPENDENCY_UNFINISHED:<id>` 可导航原事项；失败/取消仍阻塞，须处理原事项或显式修订尚未冻结的依赖 |
| 准备 `preparing` | dispatch `prepared` | 宿主工作树/Session 准备及正式准入回执；具体准备失败进入错误 |
| 运行 `running` | dispatch `running`，或既有已认领工作 | 提供原会话链接；只有宿主报告支持 boundary pause 才提供执行暂停 |
| 暂停请求 `pausing` | 原控制请求 requested/accepted | 接纳不是暂停确认；继续观察原 requestId |
| 已暂停 `paused` | 原控制回执 acknowledged | resume 控制同一 task/Session/attempt/worktree |
| 恢复请求 `resuming` | resume requested/accepted | 原控制回执恢复确认；失败保留具体 code，丢回执显示未知 |
| 需要澄清 `waiting-input` | 未解决的 clarification 或规划澄清 | 回答携带关联身份进入正式 Session 队列；仅对应 resolved 事件关闭问题 |
| 出错 `error` | 分析失败、dispatch failed/rejected、业务 error 或失败控制 | 保留具体阶段/错误码；规划失败用 `retry-analysis` 显式重试；已经执行的定义保持冻结，可创建 fix |
| 未知 `unknown` | 准入、观察或控制结果未知 | 只核对原持久身份，不自动重派；缺通道结果也显示未知 |
| 待验收 `review` | 原执行已终结、result 消息及交付核验通过 | 独立审核通过才完成；拒绝保留 `EXECUTION_REJECTED` |
| 完成 `completed` | 宿主验收成功；显式配置 autoAccept 的看板沿既有规则处理 | 无 run；允许新 fix 澄清 |
| 取消 `cancelled` | 未开始工作由宿主取消 | 不再 run；执行中不能通过取消后新 Session 伪装恢复 |

`analysis`、dispatch、控制和责任状态都不是 Agent 可写的调度命令。Agent 只报告业务进度、问题、错误与交付申请。业务 error 不等于原生进程已经退出；`result`、Session idle、进程正常退出和聊天“完成”均不能单独证明验收通过。

## 五分钟准入与编辑租约

新事项持久保存 `launch.startAt = createdAt + 300000`。没有 launch 的历史事项按原 createdAt 计算兼容截止点，不重建身份、不改创建时间。源发现创建同样写入截止点；共享启动扫描将缺少 launch 的旧事项一次性补齐并记录 `LEGACY_LAUNCH_INITIALIZED`，保留已有派发/认领的原开始身份。宿主复用现有共享 Kanban monitor 的事件唤醒和五秒补查；启动后补查过期截止点，没有每事项常驻计时器，也没有占住扫描请求的长 sleep。

人工 `request-run` 保存 requestedAt；定时与人工经过同一 `admit-item` 和 `prepare-dispatch` 存储事务。事务重验编辑租约、暂停、阻塞、前置验收及 WIP。并发客户端通过 expectedRevision/CAS 竞争；原 execution journal 先冻结请求，再取得唯一 submitting 权。重启只 inspect 原身份。Unknown 不产生新 Session。

`begin-edit` 接纳 editId、可信操作者及 1 秒至 5 分钟租约。`save-edit` 原子保存标题、责任、验收、项目引用和 planning；`end-edit` 取消编辑，保留定义。两者须匹配操作者/editId 和有效租约。断线不取消 task；租约到期后宿主可重新准入。编辑不重置 createdAt/startAt；到期仍编辑则等待，结束编辑再核对。实际准入后拒绝修改冻结定义。API 同样校验，UI 禁用仅用于提示。未开始事项可取消，开始分析后不支持借普通 cancel 跳过原执行控制。

暂停/恢复冻结 original call route、taskId、epoch 和 requestId，通过 `session.call.control` 执行，之后只查询 `session.call.control.receipt`。传输错误保留 unknown，不把 cancel 当 pause，也不调用执行桥重新 start。

## 超时、失败和重试边界

通道协作的 task 规划和执行调用使用 `timeoutMs: null`，取消和终结由原执行控制/宿主事实负责；不再被旧 120000ms 效果时限截断。规划中的 `EFFECT_TIMEOUT` 等具体错误会提交根事项 `report-analysis`，产生看板事件、工作日志和全局通知。失败不会因下一次扫描自动分析；`retry-analysis` 给新的规划尝试分配明确 epoch，同时保留主事项身份和冻结定义。

独立的只读 discovery Flow 仍是受限、短时扫描：`published-executor.ts` 的效果预算 120 秒、观察预算 150 秒，不用于开发通道协作。执行桥关闭上限用于停止观察和排空持久写入，不是开发执行超时。无法核对原准入或控制时，保留未知和原身份供恢复，不静默重发。交付核验失败保留具体原因，独立验收失败保持原交付可检查。

## 通道协议与边界

NestOS 通过固定 Cells API 管理 scope、读取消息与原生状态、写响应和业务接纳。Agent 只获得本 scope 的 MCP 2.0 capability，不能调用节点管理或 Kanban 命令。上下文按 section 冻结，首条输入只传 contextRef；作者提示、任务、决策、依赖结果不在启动时重复注入。

| 通道操作 | 用途与约束 |
| --- | --- |
| `session_context` | 默认返回 section 索引，按需读取单节；每节最多 64 KiB、总共 2 MiB |
| `session_report` | 不可变 progress/clarification/error/result/proposal/resolved；message 仅 type/content/payload/replyTo，content 非空且最多 8000 字符；每 scope 最多 200 条、总共 4 MiB |
| `session_receipt` | 查询同一 id 是否持久接受及业务 ack；接受不等于独立验收完成 |
| `session_request` | 持久请求宿主查询，pending 必须结束本轮；最多 128 项 |
| `session_response` | 宿主续办后读取不可变响应，并核对 scopeId/requestDigest/sha256 |
| Session 正式输入队列 | 用户答复携带 scopeId/replyTo/operationId，只续办原 Session |

消息 id 为 1–128 位字母数字、`_`、`-`。宿主从冻结 scope 取得 run/item/attempt 身份，不允许消息选择其他业务身份。先校验完整批次及 resolved 的问题引用，再冻结消息摘要，交付问题、交付 resolved；已提交业务和通知完成后写固定 API acknowledge。丢失 ack 只修复 ack，不重复提交业务。删改消息、重复 ID、作用域不符、改写请求／响应分别报具体 CHANNEL 错误。网络、存储和通知失败保留持久身份，不换 ID 重派。日志仅含关联 ID、阶段、结果、具体错误码和耗时。

```json
{"id":"question-1","message":{"type":"clarification","content":"应使用哪一份输入定义？"}}
```

```json
{"id":"resolved-1","message":{"type":"resolved","replyTo":"question-1","content":"已将答复纳入实现。"}}
```

Agent 通过 `session_report` 发布这些参数；宿主通过固定 API 读取。普通 progress 不解决既有问题。result 是交付申请，仍需原生终态、真实产物核验和独立验收。暂停／恢复继续使用正式 Session command/receipt，消息不能证明已停止。

## fix 确认和接纳

`task-fix-pre.md` 由统一 resolver 冻结为通道 section。每次 fix 有独立 worktree/Session/scope，原主执行不变。上下文包括原看板、单项目、原 task、父项和原决策版本／正文；没有决策为 null。

Agent 使用 `session_report` 的 proposal/payload 提出结构化定义（title/responsibility/acceptance/type/dependencies）。修改定义必须新 id，不覆盖旧消息。仅无附件、非注入的精确用户消息“完成”（允许外围空白）触发确认；引用、代码块和 `未完成` 不触发。宿主冻结 proposalId、确认消息 ID／digest、定义和稳定 operationId，关闭本次输入，并在原 journal 保存不可变 `fix-definition:<id>`；不创建模型轮次伪装确认。

宿主复用 create-item 和持久回执创建 planning.kind=fix 的普通等待 task，dependencies 必须包含原 task，startAt 为真实 createdAt+五分钟。原依赖未完成、失败或取消都不放行；已取消前置不能伪造完成。创建与通知完成后才 acknowledge 原 proposal。冻结、持久接纳、通知或 ack 失败均按原快照恢复，后来的 proposal 不改变已确认定义。确认接纳不代表新开发工作已完成。

## 验证入口

- `pnpm --filter @nestos/kanban test`：可控时钟、竞争/重启、编辑租约、统一状态、执行与 UI 回归。
- `pnpm --filter @nestos/app-core exec vitest run kanban channel`：具体分析失败、控制回执、通道协议、fix 快照与通知补偿。
- `pnpm --filter @nestos/llm-session exec vitest run __tests__/instruction-queue.test.ts`：正式队列确认门及接纳回执。
- CLI 使用 `kanban query <board>`、`kanban item <board> <item>` 读取同一投影；`execute --file` 传原冻结 operationId/expectedRevision/command，`fix --file`、`reply --file` 复用宿主接口，传输未知不自动换身份重发。
- Chromium fixture 位于 `libraries/kanban/tests/browser/`。运行该目录 Vite 配置，再运行 `acceptance.mjs`；Playwright 由验收环境提供，输出截图及实际业务结果/回执。该 fixture 使用真实 DOM、VFS/SeqFile、执行桥和 fix 服务，原生执行端口为确定性替身；真实远程 x1 的执行进程由宿主最终验收，不把替身结果写成生产验收成功。

## 状态与生命周期边界

Cells 记录精确 Session/turn、operationId 与状态修订。重启将 submitting/running 标为 unknown，只有原 turn 的真实终态才能解除未知；旧 turn 的迟到事件不能覆盖新 scope。scope 切换核对前驱及原 Session，旧 token 失效。宿主正式执行回执、交付核验和看板独立验收仍是完成依据。

Session 续办、看板删除屏障和临时资源释放继续沿原生命周期。未确认 fix 和未投递用户回复阻止删除。编辑与扫描使用既有 CAS；删除独占等待已准入工作，新写入等待删除回执。界面沿用现有活动刷新，事件只是失效通知，不用心跳或普通读操作制造活动。

## 手工与挂起

`launch.mode` 缺省为 automatic，维持原五分钟期限；manual 仅在显式 request-run 后准入，等待多久、重启多少次都不会自行变成自动。尚未准入的事项可通过 set-launch-mode 或编辑表单原子修改模式，模式切换清除旧的运行请求，不改变创建时间或原期限。

create-item 支持原子 `launch: {mode: 'manual', paused: true}`：事项首次可见时已经挂起，不存在创建后、再发送暂停命令前被后台认领的窗口。继续只解除暂停；手工模式仍须显式运行。已运行任务的暂停/继续继续使用原 dispatch 的真实控制回执，不能借此新建 Session。新增分析任务在本次合并期间按该模式登记，恢复执行由用户另行决定。

## 看板执行控制与手机入口

`set-board-control` 由人工操作、按 expectedRevision 原子提交，独立于执行目标配置。`executionControl.mode` 为 automatic/manual，manual 只接受任务显式 request-run；任务自身的手工模式仍有效。`executionControl.paused` 是持久的调度屏障，禁止新准入、派发及续办，重启不会丢失。已提交会话继续观察，暂停不会重启或复制 Session。

暂停同一事务为尚未暂停的活跃派发创建 request-control，controls 保存本次看板拥有的请求 ID。状态由真实 control-receipt 投影为暂停中、已暂停、恢复中或错误；不支持的执行器明确失败。继续只作用于这些请求，不恢复用户独立暂停的任务；尚未确定的请求拒绝继续，等待查明回执。任务交付或终止后不再阻塞看板控制状态。

sidebar 复用 vfs-ui 动作：外部只显示图标，菜单含图标和文字，设置明确选择当前看板或全部现有看板。行中显示状态图标及文字，设置弹窗触摸目标至少 44px。全部现有看板逐个进行版本校验，列出部分失败而不宣称原子成功，不影响以后新建看板。首屏状态只投影已有看板元数据，不枚举远程会话。界面事件刷新回执状态，关闭时释放弹窗。
