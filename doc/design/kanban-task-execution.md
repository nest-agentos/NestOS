# Kanban task 执行、编辑与 fix 协作

本规范补充[协调设计](kanban-coordination.md)。`KanbanItem.status` 保留既有责任/验收存储语义；面向用户的阶段统一由 `projectKanbanTask` 投影。实现位于 `libraries/kanban/src/contracts/task-projection.ts`；`item().task`、`query().items[].task`、卡片、详情及 CLI 共用该结果，`phase` 筛选在服务端执行。Session 冷摘要只补充活动和可访问链接，不证明开发成功。

## 收尾经验记录

开发执行的 `delivery.md` 及后续维护结果入口按需引用 `session-learnings.md`，要求 Session 在最终报告前按需回顾经验；没有可复用信息时省略 `payload.learnings` 或传空数组。每条包含稳定 `id`、明确 `itemId`、简明 `event/handling/reason/result/conditions` 和可选的当前 scope 报告 ID 列表 `evidence`，最多八条，每个正文字段最多 1200 字符。发布前必须剔除秘密、个人信息及整段对话。

`@nestos/kanban/integration.registerSessionLearnings` 拥有校验、脱敏、任务归属和幂等登记；宿主 `backend/app-core/src/kanban/session-learnings.ts` 仅注入通道摘要及日志，在开发观察器收到最终报告且执行成功后登记；`kanban-development-review.ts` 同样接入原 Session 后续分析、构建、替换及合并阶段的正式收尾结果。宿主使用执行回执的 Session 身份，复验目标 Task 的正式执行关联及 dispatch，拒绝凭标题归属；多 Task 必须逐条明确归属，未关联不创建 Task。记录复用 `append-record`、`itemIds`、`sources`，从 Task 详情的历史记录进入，保留来源 Session、报告 ID 和摘要；额外证据必须是当前通道实际存在的报告。经验登记不执行完成或验收命令。

登记身份由 board、Session、Task 与经验稳定 ID 派生；正文先经过凭据形态剔除，再冻结摘要并复用 journal 命令回执。相同身份的内容变更拒绝覆盖；丢失写入回执时使用原操作身份恢复。`learning-…:status` 保存登记成功或待恢复的阶段和安全错误分类；失败不会返回成功登记，开发观察器保留待核对状态供后续扫描重试。日志仅含操作身份、阶段、结果、错误码及耗时，不输出正文或原始异常。已有任务执行结果与独立验收仍由原机制管理。

回归入口：`libraries/kanban/tests/session-learnings.test.ts` 与 `kanban-development-observer.test.ts`。本机制接入开发执行及原 Session 后续维护的正式收尾通道；不从任意聊天正文猜测经验，也不为无通道的普通会话创建 Task。

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
| 取消中 `cancelling` | 人工请求 `request-control action=cancel`，调度与派发被持久屏障阻止 | 宿主核对原调用和执行树；接纳不等于停止，丢回执转 unknown，只查原请求 |
| 取消 `cancelled` | 未开始工作取消，或原调用及执行树已结算且子事项均终结 | 不再 run；释放认领、移交和阻塞，可逻辑删除；历史与身份保留 |

`analysis`、dispatch、控制和责任状态都不是 Agent 可写的调度命令。Agent 只报告业务进度、问题、错误与交付申请。业务 error 不等于原生进程已经退出；`result`、Session idle、进程正常退出和聊天“完成”均不能单独证明验收通过。

## 五分钟准入与编辑租约

新事项持久保存 `launch.startAt = createdAt + 300000`。没有 launch 的历史事项按原 createdAt 计算兼容截止点，不重建身份、不改创建时间。源发现创建同样写入截止点；共享启动扫描将缺少 launch 的旧事项一次性补齐并记录 `LEGACY_LAUNCH_INITIALIZED`，保留已有派发/认领的原开始身份。宿主复用现有共享 Kanban monitor 的事件唤醒和五秒补查；启动后补查过期截止点，没有每事项常驻计时器，也没有占住扫描请求的长 sleep。

人工 `request-run` 保存 requestedAt；定时与人工经过同一 `admit-item` 和 `prepare-dispatch` 存储事务。事务重验编辑租约、暂停、阻塞、前置验收及 WIP。并发客户端通过 expectedRevision/CAS 竞争；原 execution journal 先冻结请求，再取得唯一 submitting 权。重启只 inspect 原身份。Unknown 不产生新 Session。

`begin-edit` 接纳 editId、可信操作者及 1 秒至 5 分钟租约。`save-edit` 原子保存标题、责任、验收、项目引用和 planning；`end-edit` 取消编辑，保留定义。两者须匹配操作者/editId 和有效租约。断线不取消 task；租约到期后宿主可重新准入。编辑不重置 createdAt/startAt；到期仍编辑则等待，结束编辑再核对。实际准入后拒绝修改冻结定义。API 同样校验，UI 禁用仅用于提示。未开始事项可通过普通 cancel-item 取消；已准入、分析中、运行中和待验收事项通过 request-control action=cancel 核对原执行后取消，不得借普通 cancel 跳过执行控制。

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

## 取消、删除和收尾

`request-control` 支持 pause/resume/cancel。取消中和取消结果未知持续阻止新准入；取消可以取代尚未确认的暂停，但同一取消请求保持稳定身份。暂停/恢复回执优先于业务澄清或错误投影，避免已暂停任务没有恢复入口。父项取消在同一事务为未终结后代登记取消请求，父项只有在子项终结后才能进入 cancelled。执行桥在自己的 SeqFile 事务中对取消屏障与 submitting 领取进行竞争，确定尚未提交才产生 CANCELLED_BEFORE_START；已提交任务继续核对原身份。

NestOS 的 task-controls 核对原规划调用、原 dispatch 或原 Session 续办的具体 round。call-lifecycle 先冻结路由和 epoch，再提交一次控制；丢回执只查询原请求。历史 task-control 记录沿用原路由和提交阶段，不因升级重新发出控制。续办使用 submission-control 校验原 round、primary Task 和执行树，不能通过缺少独立调用路由推断其他 Session 已停止。原调用路由丢失保留 unknown，不释放认领。

执行终态与业务通道分别核对。真实失败或取消不因 SESSION_CHANNEL_REQUIRED 再次变为未知；用户取消不启动新的 postload 模型调用。可选收尾准备失败保留具体诊断，不能覆盖已确认的停止事实。已完成事项保留的历史负责人不再单独构成看板执行占用；相关执行仍须通过原回执及 Session 检查。

`delete-item` 仅对完成或取消事项保存 deletedAt 墓碑；宿主先检查关联执行、规划、fix、回复及维护操作。默认 query、catalog 和 overview 隐藏墓碑；includeDeleted 显式包含，item 和 events 保留历史，不复用 ID。删除看板预检也包含已删除事项，不能借单项删除绕过执行屏障。

决策的审核状态与执行控制分开。request-record-cancellation 保存 cancelling，cancel-record 在关联事项终结后保存 cancelled；delete-record 只删除已取消、已拒绝或已替代的决策并保留墓碑。宿主 controlRecord 持久保存 pause/resume/cancel 意图，取消只处理已物化的根事项及后代，不创建缺失工作；暂停控制登记属于本次决策的请求，恢复不解除用户独立暂停。原执行记录结算后再结束决策，重启继续同一控制。无执行的草稿也可直接取消并删除。

修复澄清可通过 taskFixes 查询、cancelFix 放弃，状态为 cancelling/cancelled。确认、恢复与放弃在同一 fix 串行；放弃后不再接纳迟到确认。已经创建但通知/ack 尚未完成的新 fix 任务也要取消并结算，才完成放弃；已正式 accepted 的 fix 引导用户处理已创建任务。放弃不修改原主执行，不要求业务通道重新就绪。

## 看板等待删除与整体取消

看板的 `lifecycle` 为持久执行屏障，和每个 task 的执行阶段分开。`request-board-stop` 原子保存 operationId、intent=cancel/delete、mode=drain/cancel、phase=waiting/ready/blocked，并将既有执行控制置为 manual + paused、关闭自动化；后续新事项、计划、准入、派发、续办和重新启用调度均由 reducer 拒绝。手工 claim 也复验屏障，不能靠其他客户端绕过。整体取消为未终结事项原子登记原执行取消请求；整体取消完成不会自动删除看板。

`requestBoardDeletion` 在预览确认后保存删除请求及清理选择。默认 drain 保留已提交执行，继续核对原回执和必要验收/答复；执行桥在原日志事务证明尚未提交时取消准备中的派发，不启动新执行。已提交的规划调用只观察到结算，不再接纳新计划。未确认 fix、未知执行、待投递回复及维护操作继续作为具体阻塞项供用户处理。显式 cancel 模式同时取消关联任务、修复澄清、回复、维护及 postload；已准备但未提交的操作沿原 journal 冻结，已提交的操作只取消并核对原身份。

看板显示“等待删除：处理完阻塞事项后自动删除”。删除请求跨重启恢复，先恢复屏障再运行共享扫描；扫描完成后，自动删除进入同一独占屏障，等待已准入操作退出，再重新预检当前资源及修订。全部阻塞解除后无需再次确认，按既定选择只清理归属明确、原执行已结算且 Git 状态符合安全条件的资源，然后写看板墓碑。已完成和已取消的事项均可参与安全资源清理；脏改动、未合并、归属未知及其他归属仍保留。任何取消、核对或清理未知都不伪造停止结果。

等待删除时仍允许读取、原执行观察、独立验收、相关答复、取消和资源清理；构建/部署/合并等新的维护执行入口禁用。讨论会话及共享 Session 的无关新轮次不因看板停止而被全局中断，原 task 的回复轮次单独登记并核对。删除后的会话、历史和资源关联继续保留。

## 面向用户的详情信息层级

借鉴 [Linear 可选展示字段](https://linear.app/docs/display-options) 与 [事项归档和删除](https://linear.app/docs/delete-archive-issues)，默认界面围绕当前状态、阻塞原因、下一步操作展开；日志、执行技术身份和完整关联按需展开。[Trello 归档和删除](https://support.atlassian.com/trello/docs/archiving-and-deleting-cards/) 区分可恢复的归档与需要确认的删除；NestOS 继续复用领域准入与既有确认流程。

| 区域 | 默认信息与操作 |
| --- | --- |
| 看板顶栏 | 看板标题、运行控制、搜索/筛选、新建、刷新；空列隐藏 |
| 任务卡片 | 点击编号/标题进入事项详情；独立会话链接打开 NestOS 标签页。展示阶段、负责人、创建时间、会话状态及真实最近活动；未知活动不以读取时间代替。省略空领域/里程碑 |
| 详情顶部 | 状态、运行/暂停/继续/修订等当前可用操作、原始执行会话入口；取消旧任务可跳转从头重跑的新任务 |
| 主要内容 | 工作范围、验收要求、依赖、子任务；父事项仅汇总子任务，不再显示成等待执行本身 |
| 更多菜单 | 复制编号、复制链接、归档/恢复、取消/删除；按后台状态开放，危险操作继续走确认及资源检查 |
| 技术详情 | 来源身份、规划结果、关联会话与 worktree；各资源保持原归属 |
| 页面底部 | 活动与日志，默认折叠；展开才读取事件与关联记录 |

已到启动时间但未派发显示等待调度；不显示 0 秒倒计时或原始内部原因码。原因码保留为诊断属性，不代替用户提示。原生会话本轮结束仅说明执行轮次结束，任务仍须正式结果核对与验收。归档不删除工作台会话，删除与 worktree 清理继续复验生命周期和未合入改动。看板级归档尚无领域契约，不提供无效按钮；后续若增加，应先定义停止自动调度、恢复和历史检索的领域规则。

规划要求澄清时，任务投影为 waiting-input，决策执行投影为 blocked/DECISION_INPUT_REQUIRED；不生成执行计划或开发派发。问题直接显示在任务详情顶部。规划通道提供 planning-input（当前任务与候选目录）以及按候选 section 名称读取的冻结详情，不在主上下文反复传送整个看板的工作范围和验收正文；来源决策、看板和项目身份继续保留。重新分析仍须由模型重新判断 ready，不等于用户已经回答问题。

### 在原会话澄清与重新规划

决策通过 `recordSessions` 读取各项目任务当前规划会话，宿主归档与诊断通过 `planningSession` 读取原生资源地址；任务界面不读取或展示规划会话。两者都沿 current analysis → 正式调用回执 → 原生资源定位，不枚举会话历史。决策顶部显示规划的“继续澄清”；任务及子任务只显示执行会话，执行中的澄清进入原执行会话。入口复用 NestOS 内部标签页。规划会话元数据异步补充，主体内容不等待会话查询。

规划 `clarification` 是持久的 waiting-input 阶段，不结算规划、不重新发送原提示词。AI 在同一会话等待用户答复，通过 `resolved(replyTo)` 逐条解决问题；全部解决后才能发布一个不可变 `result`，payload 含 `ready:true` 和总结已确认范围的 reason。缺少信息时不生成开发派发。工作上下文附带已采纳规划结论，子任务继承父规划确认的范围。

Cells 在消息首次持久化的事务记录 sessionId、turnId、operationId、revision 来源，不接受模型自行提供来源。宿主冻结消息摘要与问题轮次；规划的 resolved 必须来自同一会话的后续输入轮次，最终结果必须对应已完成的原生轮次。提前发布 ready 或同轮自行解决会得到 rejected 回执，问题继续阻塞，后续有效答复可以用新消息 ID 更正。validated 回执仅表示报告核验通过，计划仍须通过来源决策和任务定义核对、计划采纳规则及后续执行验收。

宿主重启沿原 journal 恢复观察，消息与回执留在 Cells；不重复创建会话。暂停保留原会话；取消先结算原调用，再核对并中断仍运行的原生轮次，以稳定请求 ID 查询回执。仅在原生执行空闲且 revision 一致时撤销通道；未知结果保留责任，不声称已取消。关闭视图或关闭 httpd 只释放观察，不取消用户会话。

`retry-analysis` 仅重试失败规划；待澄清时进入原会话回答，不用重新分析代替回答。已采纳或已有开发执行的规划不原地覆盖，后续修改通过新版本或后续任务承接。不得仅凭聊天中的 OK、轮次结束或 MCP 发布成功判定规划或任务完成。

任务卡片标题始终进入事项详情，独立会话链接只打开开发执行会话；规划会话只在决策展示。任务组没有独立执行会话。看板状态继续消费 MCP 发布及原生执行证据，不从聊天正文推断完成。

规划报告投影的操作身份包含当前看板修订与报告摘要，防止同一报告再次同步时携带不同 CAS 修订触发幂等冲突。同步冲突仅记录同步诊断，不将模型规划改写为失败；历史 `IDEMPOTENCY_CONFLICT` 投影允许通过原规划 journal 继续核对，不重新派发会话。

事项详情按当前状态与下一步、工作范围与验收、关联会话、执行操作、子事项分层；更多操作、技术来源与日志按需展开。待澄清状态本身可进入原会话。未知取消回执明确提示未确认的操作与具体错误，不能用会话空闲推断取消完成或绕过删除准入。

规划续轮须通过 `channel-status` 核对所有历史澄清，包括旧版 `result.ready=false`。用户的已确认答复可结算多个历史问题，但每个问题报告均须有独立 `resolved.replyTo`，不能只解决最新一条。宿主拒绝的规划报告不算采纳；Agent 应根据拒绝原因修正协议并以新稳定 ID 发布结果，保持原已确认范围，不要求用户重新回答宿主协议问题。该指令来自全局规划文件，新会话无需重编译即可读取；已冻结会话沿原身份补充技术续办。

### 决策的重新执行、归档与删除

`controlRecord` 的 `restart/archive/delete` 是持久协调意图：先禁止新的派发，逐层请求取消并核对回执；未知结果持续保留处理中，不假定已经停止。重启继续同一操作。归档/删除同时处理生成任务及其全部子任务，跨目标看板保持原归属；无关根事项不在控制范围。归档使用既有事项归档存储，删除使用逻辑墓碑，原生会话通过宿主 archiveSession 端口按稳定操作身份归档，未知回执只核对，不重复发送；不删除会话历史或未满足安全条件的 worktree。决策列表可包含已归档项。

重新执行在旧轮结算后归档旧事项，记录新的 executionEpoch 并创建新 Run、新任务与新会话，保留原记录与追溯链接。新规划只读取原始决策要求，不继承上一轮澄清或规划结果。旧决策执行快照具有 archivedAt 标记，在界面历史中折叠；worktree 只归档关联元数据，保留目录、分支和安全清理约束。同一操作重试复用原 epoch，不创建第三轮。UI 菜单确认后携带所见决策 revision；CLI `kanban record-control <board> --file <request.json>` 复用同一服务入口，冻结请求包含 recordId、operationId、action 与 expectedRevision。

规划拒绝回执携带 pendingQuestionIds，明确列出尚未结算的历史问题；有效 resolved 也具有 validated 回执。已验证的最终规划保持冻结，后续会话轮次不能使其退回等待。

子任务卡片与详情顶部显示父事项编号及名称，并提供父任务入口；汇总父项明确标注由子任务汇总进度。澄清尚未 ready 时，宿主不得采纳拆分或创建开发子任务。

### 决策操作与关注汇总

决策详情直接提供继续澄清/继续执行与 Restart 从头开始。Resume 保留原会话和工作区；Restart 不继承旧澄清。未澄清的每项目内部事项标记为 purpose=planning，由决策管理，默认开发看板以 excludePlanning 隐藏；规划通过后在 publish-plan 同一事务中晋升为开发事项或汇总父项。历史规划载体在运行协调时按原身份补标，不重复派发会话。

看板内的看板/日志/决策页签显示需要用户处理的数量，顶部窗口标签不显示。数字来自同一 SeqFile 读取视图中的事项/决策摘要及工作流事实，不单独持久化、不读取会话正文；同一决策的多个待澄清项目只计一次。正常等待和运行不计入关注数。决策列表标出待澄清/错误，处理后自动消除提醒。

父任务详情按完整直接子任务集合统计完成、运行、待澄清、错误、待验收和暂停数量，不受当前分页影响。已有子任务时定时刷新同一分页，状态修订导致游标失效才返回首页；正常无变化不替换 DOM。父任务仍以全部子任务的真实验收结果结算，不以规划或开发 Session 的终止替代验收。

任务组与执行任务复用卡片和详情组件，以 planning.execution=children 区分角色。组状态由完整子任务集合投影，关注优先级为错误、待澄清、待验收、执行中、等待；组本身不提供 run/fix 或假恢复按钮，不重复计算待处理数字。任务标题栏显示编号和名称，详情按最新状态、执行会话、工作内容和验收、子任务汇总、历史排序。

决策的 recordSessions 默认只解析当前执行版本；需要历史时显式传 includeArchived，普通刷新不读取已归档 Session。开发列表不再为每张卡片补读 planningSession，规划解析仅由决策、诊断与归档使用。

## 状态证据与读取失败

各层状态分别表达自身事实，不用一个“失败”或“完成”覆盖其他层：

| 层级 | 状态依据 | 不应据此推断的结果 |
| --- | --- | --- |
| 决策设置 | `completion=automatic` 为“执行方式：自动推进” | 不表示已经执行成功 |
| 决策记录 | draft / confirmed / rejected / archived | 已确认仅表示决策获准，不代表开发、验收或合并完成 |
| 决策执行 | planning / running / blocked / review / completed 等，由关联工作和交付准入汇总 | 会话读取失败不能改写历史执行结果 |
| 协调任务 | 子任务阶段和已提交的任务组结算 | 1/1 完成不证明构建、替换、Git 合并或资源清理成功 |
| 执行任务 | 同一 attempt 的正式业务结果及验收记录 | Session idle、原生 turn 完成、已接纳请求均不是验收通过 |
| 交付步骤 | 各步骤原 operation 的正式回执 | skipped 不是 succeeded；取消已受理不是物理停止已确认 |
| 查询展示 | 当前会话、关联记录或操作面板读取结果 | `CONFLICT` 等读取错误不表示原任务执行失败 |

`projectKanbanTask` 保留 `phase=completed` 的结算语义，通过可选 `completion` 补充 accepted、waived、mixed 或 children。豁免及部分豁免在列表、卡片和详情明确标注；任务组递归汇总子任务豁免。旧记录缺少验收依据时不补造通过记录。是否已合入 Git、部署或清理，继续以对应步骤回执为准。

真实执行失败保留 error，结果未确认保留 unknown；不推进后续依赖、不标为完成、不自动重发未知请求。自动流程错误优先于旧 done 标记，步骤未走完也不能以 done 显示完成。已正式结算的历史任务不会因之后的详情查询或独立操作失败被改成失败；新修订、重启和新操作沿各自身份记录。

读取错误局部展示为“关联管理会话加载失败”“执行会话状态读取失败”或“交付操作面板加载失败”，保留安全错误码并提供“重试加载”。重试只重新读取目标区域，不调用派发、run、accept 或 merge。读取成功移除该区域旧错误；切换资源后的迟到错误不写入新资源。

历史独立调用可能早于 caller recovery 配置。新的调用在准备阶段冻结 recovery 元数据；历史读取只在不可变 Kernel 回执精确匹配的前提下选择有/无 recovery 的原始格式。原指纹校验不放宽，不修改旧回执、不新建 Session、不重发开发任务。KBD-2-5 / KBC-2-100 的 CONFLICT 属于这类历史回执读取问题，修复读取不改变已结算任务。

管理操作的会话观察只读取原提交和通道回执，不执行 Git 快照。完整仓库批次校验分别位于准备、继续执行前及结果接纳边界；继续执行必须重新核对所有贡献者和冻结版本。正在运行或等待回执的续办轮次不申请工作区进程锁。观察失败日志区分 `operation.observe.submission` 与 `operation.observe.channel`，不把观察错误解释为原生轮次失败。
