# Kanban task 执行、编辑与 fix 协作

本规范补充[协调设计](kanban-coordination.md)。`KanbanItem.status` 保留既有责任/验收存储语义；面向用户的阶段统一由 `projectKanbanTask` 投影。实现位于 `libraries/kanban/src/contracts/task-projection.ts`；`item().task`、`query().items[].task`、卡片、详情及 CLI 共用该结果，`phase` 筛选在服务端执行。Session 冷摘要只补充活动和可访问链接，不证明开发成功。

## 收尾经验记录

开发执行的 `delivery.md` 及后续维护结果入口按需引用 `session-learnings.md`，要求 Session 在最终报告前按需回顾经验；没有可复用信息时省略 `payload.learnings` 或传空数组。每条包含稳定 `id`、明确 `itemId`、简明 `event/handling/reason/result/conditions` 和可选的当前 scope 报告 ID 列表 `evidence`，最多八条，每个正文字段最多 1200 字符。发布前必须剔除秘密、个人信息及整段对话。

`@nestos/kanban/integration.registerSessionLearnings` 拥有校验、脱敏、任务归属和幂等登记；宿主 `backend/app-core/src/kanban/session-learnings.ts` 仅注入通道摘要及日志，在开发观察器收到最终报告且执行成功后登记；`kanban-development-review.ts` 同样接入原 Session 后续分析、构建、替换及合并阶段的正式收尾结果。宿主使用执行回执的 Session 身份，复验目标 Task 的正式执行关联及 dispatch，拒绝凭标题归属；多 Task 必须逐条明确归属，未关联不创建 Task。经验写入通过宿主当前用户已授权的记录服务完成；观察器的自动协调身份继续用于任务协调，不扩大其 `append-record` 权限。权限失败保留原任务、原报告及幂等请求，修复后核对原回执继续登记。记录复用 `append-record`、`itemIds`、`sources`，从 Task 详情的历史记录进入，保留来源 Session、报告 ID 和摘要；额外证据必须是当前通道实际存在的报告。经验登记不执行完成或验收命令。

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
| 看板顶栏 | 看板标题、运行控制、搜索/筛选、新建、刷新；空阶段保留为窄列，不展示滚动或点击教学文案 |
| 任务卡片 | 点击编号/标题进入事项详情；独立会话链接打开 NestOS 标签页。管理卡片包含未完成子任务，执行卡片显示自身状态与会话；通过包含关系及任务职责区分。创建时间保留在详情，未知活动不以读取时间代替 |
| 详情顶部 | 具体状态与原因、管理或原执行会话入口、待处理子任务和当前操作；取消旧任务可跳转从头重跑的新任务 |
| 主要内容 | 未完成子任务、整体验收及交付；任务定义、工作范围与验收要求默认折叠 |
| 更多菜单 | 复制编号、复制链接、归档/恢复、取消/删除；按后台状态开放，危险操作继续走确认及资源检查 |
| 技术详情 | 来源身份、规划结果、关联会话与 worktree；各资源保持原归属 |
| 页面底部 | 活动与日志，默认折叠；展开才读取事件与关联记录 |

已到启动时间但未派发显示等待调度；不显示 0 秒倒计时或原始内部原因码。原因码保留为诊断属性，不代替用户提示。原生会话本轮结束仅说明执行轮次结束，任务仍须正式结果核对与验收。归档不删除工作台会话，删除与 worktree 清理继续复验生命周期和未合入改动。看板级归档尚无领域契约，不提供无效按钮；后续若增加，应先定义停止自动调度、恢复和历史检索的领域规则。

规划要求澄清时，任务投影为 waiting-input，决策执行投影为 blocked/DECISION_INPUT_REQUIRED；不生成执行计划或开发派发。问题直接显示在任务详情顶部。规划通道提供 planning-input（当前任务与候选目录）以及按候选 section 名称读取的冻结详情，不在主上下文反复传送整个看板的工作范围和验收正文；来源决策、看板和项目身份继续保留。重新分析仍须由模型重新判断 ready，不等于用户已经回答问题。

### 在原会话澄清与重新规划

决策通过 `recordSessions` 读取各项目任务当前规划会话，管理任务详情通过 `planningSession` 读取已有管理会话，执行任务详情通过 `executionSession` 读取原执行会话。管理解析沿 current analysis → 正式调用回执 → 原生资源定位，不枚举会话历史。两类详情均在上方提供当前会话与具体待处理事项；执行中的澄清进入原执行会话。入口复用 NestOS 内部标签页，补充读取不阻塞主体可操作。无现成会话时显示具体缺失状态及已有创建/恢复操作，读取与渲染不创建会话。

规划 `clarification` 是持久的 waiting-input 阶段，不结算规划、不重新发送原提示词。AI 在同一会话等待用户答复，通过 `resolved(replyTo)` 逐条解决问题；全部解决后才能发布一个不可变 `result`，payload 含 `ready:true` 和总结已确认范围的 reason。缺少信息时不生成开发派发。工作上下文附带已采纳规划结论，子任务继承父规划确认的范围。

Cells 在消息首次持久化的事务记录 sessionId、turnId、operationId、revision 来源，不接受模型自行提供来源。宿主冻结消息摘要与问题轮次；规划的 resolved 必须来自同一会话的后续输入轮次，最终结果必须对应已完成的原生轮次。提前发布 ready 或同轮自行解决会得到 rejected 回执，问题继续阻塞，后续有效答复可以用新消息 ID 更正。validated 回执仅表示报告核验通过，计划仍须通过来源决策和任务定义核对、计划采纳规则及后续执行验收。

宿主重启沿原 journal 恢复观察，消息与回执留在 Cells；不重复创建会话。暂停保留原会话；取消先结算原调用，再核对并中断仍运行的原生轮次，以稳定请求 ID 查询回执。仅在原生执行空闲且 revision 一致时撤销通道；未知结果保留责任，不声称已取消。关闭视图或关闭 httpd 只释放观察，不取消用户会话。

`retry-analysis` 仅重试失败规划；待澄清时进入原会话回答，不用重新分析代替回答。已采纳或已有开发执行的规划不原地覆盖，后续修改通过新版本或后续任务承接。不得仅凭聊天中的 OK、轮次结束或 MCP 发布成功判定规划或任务完成。

任务卡片标题始终进入事项详情。管理卡片的会话操作按需查找已有管理会话，缺失时进入详情呈现已有恢复操作；执行卡片链接直接打开原执行会话。管理任务的会话与子任务执行会话分别绑定，不虚构独立开发执行。看板状态继续消费 MCP 发布及原生执行证据，不从聊天正文推断完成。

规划报告投影的操作身份包含当前看板修订与报告摘要，防止同一报告再次同步时携带不同 CAS 修订触发幂等冲突。同步冲突仅记录同步诊断，不将模型规划改写为失败；历史 `IDEMPOTENCY_CONFLICT` 投影允许通过原规划 journal 继续核对，不重新派发会话。

事项详情按当前状态、会话参与与待处理事项、交付结果分层；任务定义、更多操作、技术来源与日志按需展开。待澄清状态本身可进入原会话。未知取消回执明确提示未确认的操作与具体错误，不能用会话空闲推断取消完成或绕过删除准入。

规划续轮须通过 `channel-status` 核对所有历史澄清，包括旧版 `result.ready=false`。用户的已确认答复可结算多个历史问题，但每个问题报告均须有独立 `resolved.replyTo`，不能只解决最新一条。宿主拒绝的规划报告不算采纳；Agent 应根据拒绝原因修正协议并以新稳定 ID 发布结果，保持原已确认范围，不要求用户重新回答宿主协议问题。该指令来自全局规划文件，新会话无需重编译即可读取；已冻结会话沿原身份补充技术续办。

### 决策的重新执行、归档与删除

`controlRecord` 的 `restart/archive/delete` 是持久协调意图：先禁止新的派发，逐层请求取消并核对回执；未知结果持续保留处理中，不假定已经停止。重启继续同一操作。归档/删除同时处理生成任务及其全部子任务，跨目标看板保持原归属；无关根事项不在控制范围。归档使用既有事项归档存储，删除使用逻辑墓碑，原生会话通过宿主 archiveSession 端口按稳定操作身份归档，未知回执只核对，不重复发送；不删除会话历史或未满足安全条件的 worktree。决策列表可包含已归档项。

重新执行在旧轮结算后归档旧事项，记录新的 executionEpoch 并创建新 Run、新任务与新会话，保留原记录与追溯链接。新规划只读取原始决策要求，不继承上一轮澄清或规划结果。旧决策执行快照具有 archivedAt 标记，在界面历史中折叠；worktree 只归档关联元数据，保留目录、分支和安全清理约束。同一操作重试复用原 epoch，不创建第三轮。UI 菜单确认后携带所见决策 revision；CLI `kanban record-control <board> --file <request.json>` 复用同一服务入口，冻结请求包含 recordId、operationId、action 与 expectedRevision。

规划拒绝回执携带 pendingQuestionIds，明确列出尚未结算的历史问题；有效 resolved 也具有 validated 回执。已验证的最终规划保持冻结，后续会话轮次不能使其退回等待。

子任务卡片与详情顶部显示父事项编号及名称，并提供父任务入口；汇总父项明确标注由子任务汇总进度。澄清尚未 ready 时，宿主不得采纳拆分或创建开发子任务。

### 决策操作与关注汇总

决策详情直接提供继续澄清/继续执行与 Restart 从头开始。Resume 保留原会话和工作区；Restart 不继承旧澄清。未澄清的每项目内部事项标记为 purpose=planning，保持管理职责；默认看板展示这些管理任务，excludePlanning 仅保留为显式查询兼容选项；规划通过后在 publish-plan 同一事务中晋升为开发事项或汇总父项。历史规划载体在运行协调时按原身份补标，不重复派发会话。

看板内的看板/日志/决策页签显示需要用户处理的数量，顶部窗口标签不显示。数字来自同一 SeqFile 读取视图中的事项/决策摘要及工作流事实，不单独持久化、不读取会话正文；同一决策的多个待澄清项目只计一次。正常等待和运行不计入关注数。决策列表标出待澄清/错误，处理后自动消除提醒。

父任务详情按完整直接子任务集合统计完成、运行、待澄清、错误、待验收和暂停数量，不受当前分页影响。已有子任务时定时刷新同一分页，状态修订导致游标失效才返回首页；正常无变化不替换 DOM。父任务仍以全部子任务的真实验收结果结算，不以规划或开发 Session 的终止替代验收。

任务职责统一通过 `kanbanTaskType` 识别为 coordination/execution，兼容历史 purpose=planning 与 planning.execution=children。mark-planning 与 finish-planning 保留 coordination 身份，不因结束规划而退回 execution。管理详情优先呈现管理会话、子任务待处理事项与协调操作；执行详情优先呈现原执行会话与具体问题；正常结果交付由原会话报告、宿主自动核对并交接，不显示提交、验收确认或成功交付提示。仅交接失败/未知、取消中等需要处理的情况显示诊断和恢复入口。组阶段仍由完整子任务集合投影，不重复计算待处理数字；分列通过 `kanbanColumnStatus` 使用汇总阶段，不修改持久 status。

决策的 recordSessions 默认只解析当前执行版本；需要历史时显式传 includeArchived，普通刷新不读取已归档 Session。默认看板不逐卡读取 planningSession；仅点击管理卡片会话操作或打开管理详情时读取对应会话。

### Session 内的本地代码提交

新开发策略默认 worktree，验证默认 none/release；用户要求才增加功能检查或独立验收。Session 核对必要的提交归属和交付证据后自动提交本任务的改动，按子仓库先于父 gitlink 的顺序使用冻结身份和任务 trailers。已经冻结的 changes 策略及显式 changes 选择继续保留未提交改动；规划仍强制 changes，只读验收不得提交。正常本地提交无需再次确认，失败由原 Session 尽量修复，缺少身份/权限/用户输入时保留具体原因。宿主继续核验实际 Git 事实和归属，模型报告不代替交付回执。自动模式下，管理范围先按源/目标提交的 Kanban trailers 读取已授权任务、决策和验收上下文，无待决冲突时冻结授权后自动合入；真实冲突、权限缺失和证据变化保留具体处理入口。少量独立脏改动不作为冲突：Git 需要清洁索引时，由原会话以稳定操作身份保存可恢复检查点，合入后恢复并核对正文和暂存状态，不能夹带无关改动提交。推送、发布和资源清理继续遵循各自授权与核验链路。

入口 task.md 只说明职责与按需读取位置；工作树边界在 workspace-rules.md，本地提交规则只在 delivery.md 定义，避免多轮重复堆叠 prompt。自定义项目配置及既有执行快照保持原冻结版本。

### 管理分组查询与事件边界

默认 UI 查询使用 `groupBy: 'management'`。后台先筛选匹配项，再补齐最上层管理归属并按管理根分页；`items` 为管理根或独立执行任务，`groups` 为每个管理根的未完成后代预览，包含 parentId、total 和最多六项摘要。筛选命中的执行任务优先进入预览，其次按待澄清、未知、错误、待验收、运行与等待排序。搜索、阶段筛选和 Session 活动筛选均保留管理归属；已完成、归档和直接子任务查询沿用平铺分页。前端不逐卡补查子项。详情中的完整子任务进度和 attentionItems 不受当前子任务页限制。

queryActivity 在一个批次补充当前页管理根、子任务预览和 attentionItems 的已有执行活动；显式 Session 活动筛选先核对完整匹配集合，再恢复管理归属。普通未过滤看板只补充有限预览，不枚举全看板 Session；单个 Session 的结束仍不改变任务验收结果。

管理链路为规划/发布子任务 → 观察子任务正式状态与异常 → 协调及版本化操作 → 整体验收/结算；执行链路为准备/派发 → 执行观察/问题 → 结果核对 → 独立验收。两者继续复用 SeqFile 事务、授权、稳定 operationId 和正式回执，不引入第二份完成状态。新领域事件记录当时的 taskType，结合 itemId、dispatchId、planId 和 operationId 区分职责与关联；历史未携带 taskType 的事件继续可读，协调 journal 保留自身调用和交付回执。事件仅触发界面失效刷新，聊天文本、会话 idle 或读取时间不推进任务成功。

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

仓库 scope 已完成验收和资源清理时，详情与收尾状态以该持久事实显示完成，关闭该历史 scope 的执行按钮；旧自动流程的目标等待记录保留用于追溯，不覆盖已完成的仓库事实，也不在读取时改写回执。没有仓库 scope 时仍读取原自动流程状态。

## 2026-11-12 分组与会话参与验收

隔离 Chrome 中以真实 DOM/CSS、MemoryBackend/SeqKanbanStore 和授权 Session 来源验证 1 个看板、3 个管理任务、24 个执行任务及 3 个待澄清项。组件冷打开 48.4 ms/3 次逻辑 API，管理详情 57.4 ms/3 次，执行详情 5 ms/3 次，原会话跳转 5.3 ms/0 次；各样本均低于 5 秒且少于 30 次，HTTP 请求为 0。完整记录及源码摘要见[验收数据](fixtures/kanban-task-hierarchy-20261112.json)。该组件场景不包含生产 HTTP 加载与真实用户持久数据，不能替代正式运行环境的页面性能验收。测试作用域清理已确认。

core 与 ui 性能套件通过。真实 Git 回归覆盖 Kanban trailers 反查、独立目标提交、同一文件的暂存/未暂存改动及未跟踪文件，按操作身份暂存保护后合入并恢复，最终核对原内容和索引。自动交付回归区分无冲突自动推进、真实冲突等待选择、未知执行不重派以及显式人工节点。prompt 的 task/工作区/交付规则与合入指南按需读取，没有把这些流程重复注入首条输入。

### 执行结果的静默交接

已有管理归属的执行任务，结果由执行会话经正式结果通道自动报告。宿主核对冻结源码与 Dispatch 结果后，使用稳定 handoff/review-accept 身份自动结算子任务；即使管理范围采用手动集成，也不要求用户确认子任务交接。管理任务继续持有整合与整体验收责任。暂停、取消、未知回执及资源边界仍沿原链路核对，页面读取不推进交付。

执行详情仅保留进入管理任务的链接；正常等待、交付中和交付完成均不生成“提交验收”提示、确认框或成功通知。真实交接失败或未知仍保留具体错误、原会话和受准入保护的恢复操作。宿主内部 accept-execution 回执不等同于用户产品验收，不把底层动作名直接作为界面分组名。

### 用户介入的最小边界

执行任务仅在缺少影响结果的输入或权限、且原会话无法自行补齐时要求用户参与。管理任务仅在冲突仍缺少已确认需求/提交上下文等判断依据并涉及方案取舍、新增授权/范围或用户显式保留的人工节点时确认。正常排队、等待依赖、结果交接、无冲突提交/集成、后台核验与成功收尾均不提示用户操作；未就绪的管理步骤保留在折叠历史，自动推进中的无冲突步骤不重复显示确认框。

版本变化需要重新核对并使旧批准失效，不等同于必须重新询问产品问题；宿主在同一管理范围、原 Session 和已有授权内自动重新分析。仅只读分析失效或存在匹配操作指纹及原分析身份的正式未启动合入回执时，才创建新分析轮次；旧请求与回执保持不可变。结果未知的合入不生成新身份。执行结果未知只沿原身份核对，不以用户点确认来代替结果证明。异常展示仅包含具体原因、需要决定的事项和对应原会话/恢复入口，不重复解释整个流程。

静默交接的[浏览器记录](fixtures/kanban-quiet-handoff-20261112.json)启用了操作投影，管理/执行详情分别为 66.9 ms/4 次逻辑 API、4.9 ms/4 次，HTTP 请求为 0；确认没有执行交付验收表单，保留管理任务和原执行会话入口。该场景比早期分组样本多启用了 itemOperations，调用数不作为同口径性能比较。显式“仅构建”范围先构建，再等待人工节点；旧检查点也不能在该边界之前自动合入。


### 状态与接口收敛

`taskType` 是新任务的职责分类来源；创建时拒绝执行类型与管理计划的矛盾输入，计划编辑为子任务组时在原事务内提升为管理类型。历史记录缺少类型时由统一兼容函数推导；已有矛盾字段在存储读取边界归一化，读取不回写存储、不生成领域事件。

自动交付检查点保存冻结步骤、游标、请求身份、目标占用和恢复证据。完成与授权等待由统一纯投影计算，不再新增持久 `done` 或 `waitingForUser` 字段；旧字段仅兼容读取及既有报告消费者，不能覆盖步骤和错误事实。`reportedBoundary` 仅用于通知去重。管理 scope 尚未开始时按实际条件显示等待依赖或后台推进，不能据此要求用户确认；就绪 scope 由后台发现并启动，打开详情不启动工作。

`KanbanOperationFact` 与操作界面投影分别声明，状态、按钮、文案及选择表单由 `item-operation-projection.ts` 统一派生；执行、权限和持久化不依赖确认文案。`attention.kind` 区分方案选择、授权及结果恢复，具体原因与原 Session 仍沿现有字段提供。scope 适配器只允许覆盖 adapter、交付计划、目标及清理端口，不能替换宿主 service、journal 或授权来源。

手工与自动操作复用同一执行接口。`confirmed` 只表示手工确认；自动请求不生成该字段，宿主在执行入口重新核对自动策略、管理归属和保留的人工边界。构建后继续发布依据原构建冻结的后续请求，逐字段摘要匹配后续身份，不能凭新的确认标志扩张授权。源码及目标版本核对、正式结果回执与清理证据保留；默认不追加功能验证，只有决策会话明确要求才加入验证步骤。

结构收敛后的[浏览器回归记录](fixtures/kanban-structure-20261112.json)覆盖管理/执行详情、原会话入口及未知操作反馈。相同分组夹具下冷打开为 48.5 ms / 3 次逻辑 API，管理详情为 59.4 ms / 4 次；独立操作夹具冷打开为 86.5 ms / 6 次，未知状态刷新为 6.2 ms / 1 次。两套夹具均无 HTTP 传输；临时作用域清理已确认，不据此声明生产网络完整页面性能。


执行会话结束但 Task-call 未结算时，后台先核对原调用的执行树。原 Effect 因 EIO、断线或超时观察错误停在 indeterminate 时，宿主通过既有 resolveEffect 的 reconcile 意图恢复原身份核对，按原 attempt 的持久时间退避（最长 60 秒）；不创建新的 Session/派发/原生命令，不接受聊天文本或会话 idle 作为完成依据。核对进行中与未决结果显示 unknown，不能继续显示健康运行。权限、原生上下文命名空间或指纹冲突不自动放行；暂停和取消保持约束。节点进程 epoch 改变时，只允许经当前授权读取原 sessionId/turnId 的正式历史：必须已有匹配的 committed turn 回执、原 ContextBinding 所有权、相同持久 contextId 及项目/目录绑定；只结算已匹配的终态，不修改旧 epoch，不 create/resume/turn，不用当前会话空闲或其他轮次终态代替证据。拿到原生正式终态、调用树结算与正式 result 后，仍执行源码交付核验和原自动交接链路。


旧受控轮次被取消后，同一原生会话的后续轮次可能已完成相同工作范围并发布正式 result。此时旧 Kernel/Dispatch 的取消事实不改写。恢复准入创建新的稳定 continuation；若已有发布来源与终态匹配的交付，宿主冻结 source scope、resultId、sessionId、turnId、operationId 和摘要，核对原工作树/源码，并为新 Dispatch 生成独立所有权产物。该模式不 submit 新模型轮次，不重跑开发或功能验证；来源缺失、轮次/操作不匹配、未结束、结果变化或源码不符合冻结授权时均拒绝接纳。

通用候选恢复已归独立 kanban integration，app-core 仅注入已确认决策的自动授权与正式证据。读页面不恢复执行；后台已有扫描消费有界待处理索引。人工恢复和自动恢复复用 recoverTask/continue-execution，暂停、取消、未知旧操作和最新尝试检查一致。

[运行核对记录](fixtures/kanban-result-recovery-20261112.json)：KBT-2-107 的旧受控轮次保留取消事实，后续原生轮次的正式完成报告经宿主核验后由新 continuation 接纳，任务已 completed，最新派发 accepted，并自动 handoff 给原管理任务；冻结执行 schema=3，没有新的模型提交。相关领域、宿主、内核恢复回归及 core/UI 性能检查通过。
