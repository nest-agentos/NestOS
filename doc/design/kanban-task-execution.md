# Kanban task 执行、编辑与 fix 协作

本规范补充[协调设计](kanban-coordination.md)。`KanbanItem.status` 保留既有责任/验收存储语义；面向用户的阶段统一由 `projectKanbanTask` 投影。实现位于 `libraries/kanban/src/contracts/task-projection.ts`；`item().task`、`query().items[].task`、卡片、详情及 CLI 共用该结果，`phase` 筛选在服务端执行。Session 冷摘要只补充活动和可访问链接，不证明开发成功。

## 状态来源和转换

规则按终态/验收、未解决问题、失败/未知、控制回执、执行、规划/等待顺序投影，所有字段均来自持久事实。表中的“会话”指原 dispatch 的 `executionSessionId`；没有会话时不伪造链接。已开始事项始终可以创建独立 fix 澄清。

| 阶段 | 权威事实/进入条件 | 退出条件、原因与动作 |
| --- | --- | --- |
| 等待启动 `waiting-start` | `launch.startAt`，尚未准入 | run/编辑/取消/暂停；`START_AT_PENDING`、`ADMISSION_PENDING` 或 `EDIT_LEASE_ACTIVE`；编辑中不可 run |
| 分析 `analyzing` | 宿主提交原规划调用、持久 `analysis` | 原调用的文件规划结果、具体失败或未知；不因聊天输出进入执行 |
| 排队 `queued` | `launch.admittedAt`，尚未生成 dispatch | 原计划准入/WIP 容量变化；不另建 Session |
| 等待依赖 `waiting-dependency` | `planning.dependencies` 中存在未完成项 | 仅完成的前置项放行；`DEPENDENCY_UNFINISHED:<id>` 可导航原事项；失败/取消仍阻塞，须处理原事项或显式修订尚未冻结的依赖 |
| 准备 `preparing` | dispatch `prepared` | 宿主工作树/Session 准备及正式准入回执；具体准备失败进入错误 |
| 运行 `running` | dispatch `running`，或既有已认领工作 | 提供原会话链接；只有宿主报告支持 boundary pause 才提供执行暂停 |
| 暂停请求 `pausing` | 原控制请求 requested/accepted | 接纳不是暂停确认；继续观察原 requestId |
| 已暂停 `paused` | 原控制回执 acknowledged | resume 控制同一 task/Session/attempt/worktree |
| 恢复请求 `resuming` | resume requested/accepted | 原控制回执恢复确认；失败保留具体 code，丢回执显示未知 |
| 需要澄清 `waiting-input` | 未解决的 clarification 或规划澄清 | 回答进入正式 Session 队列并写关联文件；仅对应 resolved 事件关闭问题 |
| 出错 `error` | 分析失败、dispatch failed/rejected、业务 error 或失败控制 | 保留具体阶段/错误码；规划失败用 `retry-analysis` 显式重试；已经执行的定义保持冻结，可创建 fix |
| 未知 `unknown` | 准入、观察或控制结果未知 | 只核对原持久身份，不自动重派；缺结果文件也显示未知 |
| 待验收 `review` | 原执行已终结、result 文件及交付核验通过 | 独立审核通过才完成；拒绝保留 `EXECUTION_REJECTED` |
| 完成 `completed` | 宿主验收成功；显式配置 autoAccept 的看板沿既有规则处理 | 无 run；允许新 fix 澄清 |
| 取消 `cancelled` | 未开始工作由宿主取消 | 不再 run；执行中不能通过取消后新 Session 伪装恢复 |

`analysis`、dispatch、控制和责任状态都不是 Agent 可写的调度命令。Agent 只报告业务进度、问题、错误与交付申请。业务 error 不等于原生进程已经退出；`result`、Session idle、进程正常退出和聊天“完成”均不能单独证明验收通过。

## 五分钟准入与编辑租约

新事项持久保存 `launch.startAt = createdAt + 300000`。没有 launch 的历史事项按原 createdAt 计算兼容截止点，不重建身份、不改创建时间。源发现创建同样写入截止点；共享启动扫描将缺少 launch 的旧事项一次性补齐并记录 `LEGACY_LAUNCH_INITIALIZED`，保留已有派发/认领的原开始身份。宿主复用现有共享 Kanban monitor 的事件唤醒和五秒补查；启动后补查过期截止点，没有每事项常驻计时器，也没有占住扫描请求的长 sleep。

人工 `request-run` 保存 requestedAt；定时与人工经过同一 `admit-item` 和 `prepare-dispatch` 存储事务。事务重验编辑租约、暂停、阻塞、前置验收及 WIP。并发客户端通过 expectedRevision/CAS 竞争；原 execution journal 先冻结请求，再取得唯一 submitting 权。重启只 inspect 原身份。Unknown 不产生新 Session。

`begin-edit` 接纳 editId、可信操作者及 1 秒至 5 分钟租约。`save-edit` 原子保存标题、责任、验收、项目引用和 planning；`end-edit` 取消编辑，保留定义。两者须匹配操作者/editId 和有效租约。断线不取消 task；租约到期后宿主可重新准入。编辑不重置 createdAt/startAt；到期仍编辑则等待，结束编辑再核对。实际准入后拒绝修改冻结定义。API 同样校验，UI 禁用仅用于提示。未开始事项可取消，开始分析后不支持借普通 cancel 跳过原执行控制。

暂停/恢复冻结 original call route、taskId、epoch 和 requestId，通过 `session.call.control` 执行，之后只查询 `session.call.control.receipt`。传输错误保留 unknown，不把 cancel 当 pause，也不调用执行桥重新 start。

## 超时、失败和重试边界

文件协作的 task 规划和执行调用使用 `timeoutMs: null`，取消和终结由原执行控制/宿主事实负责；不再被旧 120000ms 效果时限截断。规划中的 `EFFECT_TIMEOUT` 等具体错误会提交根事项 `report-analysis`，产生看板事件、工作日志和全局通知。失败不会因下一次扫描自动分析；`retry-analysis` 给新的规划尝试分配明确 epoch，同时保留主事项身份和冻结定义。

独立的只读 discovery Flow 仍是受限、短时扫描：`published-executor.ts` 的效果预算 120 秒、观察预算 150 秒，不用于开发文件协作。执行桥关闭上限用于停止观察和排空持久写入，不是开发执行超时。无法核对原准入或控制时，保留未知和原身份供恢复，不静默重发。交付核验失败保留具体原因，独立验收失败保持原交付可检查。

## 文件协议与边界

以下路径相对于当前 manifest/protocol 所在目录。最终 YAML 文件（包括 JSON 语法的 YAML）先写临时文件，再原子重命名；发布后的 inbox 文件不得修改或删除。目录事件只是唤醒，文件及持久回执才是依据。临时文件不会被当成消息。

| 方向/文件 | 版本与合法类型 | 限制与权限 |
| --- | --- | --- |
| Agent → 宿主 `inbox/<event-id>.yaml` | `work-message/1`: progress/clarification/error/result | 64 KiB；content 非空字符串，至多 8000 UTF-16 字符；id 为 1–128 位字母数字、`_`、`-`，basename 必须等于 id |
| Agent → 宿主 同一路径 | `work-message/2`: 兼容上述类型，新增 resolved | resolved 必须 replyTo 指向本 attempt 的 clarification/error；无关 progress 不解决问题 |
| 宿主 → Session `outbox/reply-<operationId>.yaml` | `work-reply/1`: user-response | 由已授权宿主写入，关联 replyTo；答复仍通过正式 Session 输入队列接纳，不通过模型调用 Kanban API |
| 宿主 → Session `outbox/ack-<event-id>.yaml` | `work-reply/1`: accepted | 含原 digest/replyTo；表示事件已接纳，不表示开发验收成功；ack id 可因前缀达到 132 字符 |
| fix 草稿 `<fix-directory>/proposal.yaml` | `kanban.fix-proposal/1` | 可替换草稿，不是建 task 命令；字段 title/responsibility/acceptance/type/dependencies |
| fix 确认 `<fix-directory>/confirmation.yaml` | `kanban.fix-confirmation/1` | 宿主冻结，含确认消息身份、输入 digest、定义快照及 operationId |
| fix 建任务 `<fix-directory>/kanban.yaml` | `kanban.fix/1`，version: 1 | basename 固定，由宿主从快照生成并重新读取核验；不能把任意 YAML 或聊天文本当创建命令 |
| fix 回执 `<fix-directory>/accepted.yaml` | `kanban.fix-reply/1` | task 持久接纳及全局通知之后发布 |

所有执行消息包含 schema/runId/itemId/attemptId/id/type/content 字符串，可选 replyTo 字符串。除此之外的字段拒绝。宿主从冻结 manifest 取得看板/项目授权和当前尝试，不接受消息选择其他看板、项目或执行身份。YAML 使用 JSON schema、禁止重复映射键，限制 20 层、5000 节点；每 inbox 最多 200 项。旧 work-message/1 和 legacy `.json`、`.yml`、无 content 的 body 兼容；新 resolved 必须显式使用 v2。已冻结旧协议不覆盖，新工作区协议声明扩展。

失败保留 FSError 的 EINVAL/ECONFLICT 兼容码，`reasonCode` 提供具体分类并经执行桥诊断投影：

| 分类 | 处理 |
| --- | --- |
| `WORK_MESSAGE_SCHEMA_INVALID` / `WORK_MESSAGE_TYPE_INVALID` / `WORK_MESSAGE_FIELDS_INVALID` | 拒绝版本、事件类型或未声明字段 |
| `WORK_MESSAGE_SCOPE_MISMATCH` / `WORK_MESSAGE_ID_INVALID` / `WORK_MESSAGE_FILENAME_MISMATCH` | 拒绝错误 run/task/attempt、非法或错名身份；旧尝试不能覆盖当前执行 |
| `WORK_MESSAGE_YAML_INVALID` / `WORK_MESSAGE_CONTENT_INVALID` / `WORK_MESSAGE_REPLY_INVALID` | 拒绝畸形、递归/超限 YAML、非法正文或关联 |
| `WORK_MESSAGE_SIZE_LIMIT` / `WORK_MESSAGE_COUNT_LIMIT` / `WORK_MESSAGE_FILE_INVALID` | 拒绝过大、过多或非普通有效文件 |
| `WORK_MESSAGE_READ_CONFLICT` / `WORK_MESSAGE_CHANGED` / `WORK_MESSAGE_MISSING` | 拒绝读取期间变化、同 ID 改字节、历史已发布文件消失 |
| `WORKSPACE_RESOLUTION_INVALID` | resolved 引用不存在的问题，提交前拒绝 |
| `FIX_DEFINITION_INVALID` / `FIX_DEPENDENCY_REQUIRED` / `FIX_INPUT_CLOSED` | 草稿不完整、丢原依赖，或确认后试图改定义 |
| `FIX_FILE_SCOPE_MISMATCH` / `FIX_DECISION_REVISION_UNAVAILABLE` | 建任务文件与快照不符，或无法取得原决策版本；禁止猜测替代 |
| `EDIT_LEASE_ACTIVE` / `EDIT_LEASE_EXPIRED` / `TASK_DEFINITION_FROZEN` | 编辑/启动竞争与冻结定义校验失败 |
| `TASK_CONTROL_UNSUPPORTED` / `TASK_CONTROL_RECEIPT_MISSING` / `CONTROL_UNSETTLED` | 不支持控制、回执缺失或原控制未结清 |

读取完整有效批次后，先交付问题、后交付 resolved，文件名排序不能改变关联语义。消息接纳顺序为：最终文件读取 → schema/执行作用域/授权/状态校验 → 持久去重及看板日志/问题提交 → 全局通知 → 关联接纳回执。已提交业务的通知失败通过原 journal/outbox 重放补齐；不会转换为业务失败，也不会重新创建 task。日志只记录安全关联 ID、操作/阶段/结果、具体错误和耗时，不记录正文、参数快照或密钥。

### 执行、答复、解决与接纳示例

以下每段代表一个独立不可变文件，所有身份均来自本轮 protocol。

```yaml
# inbox/progress-1.yaml — Agent -> host
schema: work-message/1
runId: run-1
itemId: task-1
attemptId: attempt-1
id: progress-1
type: progress
content: 已完成解析回归，继续检查界面。
```

```yaml
# inbox/question-1.yaml — Agent -> host
schema: work-message/1
runId: run-1
itemId: task-1
attemptId: attempt-1
id: question-1
type: clarification
content: 应使用哪一份输入定义？
```

```yaml
# outbox/reply-answer-1.yaml — host -> Session, also admitted to its input queue
schema: work-reply/1
runId: run-1
itemId: task-1
attemptId: attempt-1
id: reply-answer-1
type: user-response
replyTo: question-1
content: 使用已经审查的输入定义。
```

```yaml
# inbox/resolved-1.yaml — Agent -> host, closes exactly question-1
schema: work-message/2
runId: run-1
itemId: task-1
attemptId: attempt-1
id: resolved-1
type: resolved
replyTo: question-1
content: 已将答复纳入实现，问题解决。
```

```yaml
# inbox/error-1.yaml — Agent -> host
schema: work-message/1
runId: run-1
itemId: task-1
attemptId: attempt-1
id: error-1
type: error
content: 输入格式不符合约束，已保留失败证据。
```

error 同样须由独立 v2 resolved 的 replyTo 精确关联处理；历史文件继续保留，普通进度不能清除它。

```yaml
# inbox/result-1.yaml — Agent -> host, delivery request only
schema: work-message/1
runId: run-1
itemId: task-1
attemptId: attempt-1
id: result-1
type: result
content: 实现与测试记录见 artifacts/report.json；申请独立验收。
```

```yaml
# outbox/ack-result-1.yaml — host -> Session
schema: work-reply/1
runId: run-1
itemId: task-1
attemptId: attempt-1
id: ack-result-1
type: accepted
replyTo: result-1
content: Accepted
digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

控制由正式 Session command/receipt 执行，不把文件当调度命令。协议中的 `control` 是宿主提示方向的保留类型；当前控制 UI 通过持久控制回执展示，不依赖模型读取该提示。支持提示文件的宿主可使用以下信封；它仅描述已核对事实，不能凭文件宣称暂停完成。

```yaml
# outbox/control-pause-1.yaml — host -> Session, informational only
schema: work-reply/1
runId: run-1
itemId: task-1
attemptId: attempt-1
id: control-pause-1
type: control
content: 暂停请求 pause-1 已接纳，仍待原执行边界确认；原会话和尝试身份不变。
```

## fix 确认和接纳

`task-fix-pre.md` 通过统一生命周期 prompt resolver 处理默认、全局/项目逐文件覆盖及 digest 冻结，发布到 `_nestos/kanban/prompts/task-fix-pre.md`。每次 fix 使用独立 worktree/Session 和 manifest 内 `context.input.fix` 声明的 `fix/<id>` 作用域。原主执行引用不变。上下文包含原看板 ID/名称、单项目、原 task、父项，以及原决策身份/版本/正文；无决策明确为 null，不能猜测其他决策。

普通澄清输入继续沿 Session 队列；只有无附件、非注入的精确用户消息“完成”（允许外围空白）触发确认。`未完成`、引用、代码块或文件正文不触发。宿主在队列准备/派发前冻结消息 ID、输入 digest、当前草稿和稳定 operationId，关闭本次澄清输入，再生成文件。队列持久保存这条被宿主消费的接纳回执，不创建新的模型执行来伪装确认。确认后输入不能修改快照；重复确认仅恢复原操作。

```yaml
# fix/<fix-session-id>/kanban.yaml — host-generated after confirmation
schema: kanban.fix/1
version: 1
operationId: fix-stable-operation
sourceSessionId: original-fix-session
confirmation:
  messageId: confirmed-user-message
  content: 完成
  digest: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
board:
  id: development
project:
  id: selected-remote-project
type: fix
dependencies: [task-1]
title: 修复输入校验
responsibility: 补全约束与错误路径。
acceptance: 指定回归通过，原任务执行不受影响。
```

宿主验证快照/文件一致性后，复用 create-item 和持久 operation receipt 创建普通等待 task：planning.kind=fix、dependencies 指向原 task，startAt 使用新 task 的真实 createdAt+五分钟。没有 fixOf 字段。原依赖未完成、失败或取消都不放行。依赖链接打开原事项：失败工作可通过显式解除阻塞恢复既有计划的新尝试；未知执行先核对原身份。已取消前置不能伪造完成，尚未开始的 fix 提供编辑/取消入口，可取消该 fix 并经用户明确的新定义另建普通工作。写文件、存储接纳或通知失败保留快照，重启按同身份补齐；accepted.yaml 之前不宣称创建成功，更不能宣称新开发工作完成。

## 验证入口

- `pnpm --filter @nestos/kanban test`：可控时钟、竞争/重启、编辑租约、统一状态、执行与 UI 回归。
- `pnpm --filter @nestos/app-core exec vitest run kanban workspace-messages`：具体分析失败、控制回执、文件协议、fix 快照与通知补偿。
- `pnpm --filter @nestos/llm-session exec vitest run __tests__/instruction-queue.test.ts`：正式队列确认门及接纳回执。
- CLI 使用 `kanban query <board>`、`kanban item <board> <item>` 读取同一投影；`execute --file` 传原冻结 operationId/expectedRevision/command，`fix --file`、`reply --file` 复用宿主接口，传输未知不自动换身份重发。
- Chromium fixture 位于 `libraries/kanban/tests/browser/`。运行该目录 Vite 配置，再运行 `acceptance.mjs`；Playwright 由验收环境提供，输出截图及实际 YAML/回执。该 fixture 使用真实 DOM、VFS/SeqFile、执行桥和 fix 服务，原生执行端口为确定性替身；真实远程 x1 的执行进程由宿主最终验收，不把替身结果写成生产验收成功。

## 与当前实现的兼容边界

当前 Session 续办、交付验收/合并操作、看板删除屏障和临时进程释放保留。work-message/2 的上下文请求以 scopeId 标识请求/响应通道；业务问题解决事件以 runId/itemId/attemptId 标识业务通道。两个消费者只处理自己的包络，原请求方向、作用域及不可变回执校验仍执行。未确认的 fix 和用户回复阻止看板删除，已删除看板不能通过新增端口继续派发。

编辑与扫描允许并发，由已有 CAS 和冻结定义规则判定；看板删除独占等待已准入操作结束，新写入等待删除回执，避免模型调用阻塞编辑校验。界面沿用当前 15 秒活动刷新节奏，倒计时复用该刷新，不新增每秒全页面轮询。

## 手工与挂起

`launch.mode` 缺省为 automatic，维持原五分钟期限；manual 仅在显式 request-run 后准入，等待多久、重启多少次都不会自行变成自动。尚未准入的事项可通过 set-launch-mode 或编辑表单原子修改模式，模式切换清除旧的运行请求，不改变创建时间或原期限。

create-item 支持原子 `launch: {mode: 'manual', paused: true}`：事项首次可见时已经挂起，不存在创建后、再发送暂停命令前被后台认领的窗口。继续只解除暂停；手工模式仍须显式运行。已运行任务的暂停/继续继续使用原 dispatch 的真实控制回执，不能借此新建 Session。新增分析任务在本次合并期间按该模式登记，恢复执行由用户另行决定。

## 看板执行控制与手机入口

`set-board-control` 由人工操作、按 expectedRevision 原子提交，独立于执行目标配置。`executionControl.mode` 为 automatic/manual，manual 只接受任务显式 request-run；任务自身的手工模式仍有效。`executionControl.paused` 是持久的调度屏障，禁止新准入、派发及续办，重启不会丢失。已提交会话继续观察，暂停不会重启或复制 Session。

暂停同一事务为尚未暂停的活跃派发创建 request-control，controls 保存本次看板拥有的请求 ID。状态由真实 control-receipt 投影为暂停中、已暂停、恢复中或错误；不支持的执行器明确失败。继续只作用于这些请求，不恢复用户独立暂停的任务；尚未确定的请求拒绝继续，等待查明回执。任务交付或终止后不再阻塞看板控制状态。

sidebar 复用 vfs-ui 动作：外部只显示图标，菜单含图标和文字，设置明确选择当前看板或全部现有看板。行中显示状态图标及文字，设置弹窗触摸目标至少 44px。全部现有看板逐个进行版本校验，列出部分失败而不宣称原子成功，不影响以后新建看板。首屏状态只投影已有看板元数据，不枚举远程会话。界面事件刷新回执状态，关闭时释放弹窗。
