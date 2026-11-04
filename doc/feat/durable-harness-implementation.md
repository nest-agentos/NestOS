# Durable Harness 实施记录与使用方式

> ⚠️ 历史归档：本文记录当时的方案与审查结论，**不随代码更新**，不作为当前实现依据。当前文档见 `../`。

日期：2026-09-05。对应 [主协议](../design/durable-harness-protocol.md) 和 [Cache 协议](../design/durable-harness-cache.md)。本记录描述当前代码行为；设计文档中的未来扩展不能作为已有 API 使用。

当前 Session/Task 文件组织、通信与等待的记录位置、cache receipt 和可重建索引边界见 [持久存储与文件组织](../design/durable-harness-storage.md)。

进一步的 [Linux IPC 完备性审查](durable-harness-ipc-completeness-review.md) 列出完整目标的缺口。随后按 [简化核心](../design/durable-harness-core.md) 实施了窄入口、状态视图和同后端资源共享，准确行为见第 7 节。完整 1.1 account/export/import/迁移等协议仍未整体落地；第 6 节保留此前核心的验证，第 7 节记录本次重构验证。

## 1. 本轮落地

| 能力 | 实际实现 |
|---|---|
| Task 内部推进 | 显式 step 输入；stepNumber/stateRevision/stepAttemptCount 与 lease attemptCount 分离；失败的 reducer 不污染 checkpoint；控制失效后释放悬挂 reducer 的并发槽 |
| 并发输入 | 消息、signal、Effect/Interaction 更新不使业务 claim 失效；提交保留当前权威记录的输入尾部和外部结果 |
| Task 控制 | pause/interrupt/resume、幂等 requestId、可选 expectedEpoch、控制确认；父控制屏障与子任务自己的暂停分别保存 |
| Session 控制 | suspending/suspended、运行中 reducer fencing；Effect 按 drain 策略收敛；关闭使用持久 drain/cancel 模式，禁止 closed→open |
| 恢复 | 周期过期 lease 扫描、timer/shared wait 检查、outbox 重投和 cancellation cleanup；缺失程序版本等待注册 |
| 创建身份 | Session registration intent、防止覆盖另一 Session 的存储；TaskSpec.requestId 幂等提交 |
| 依赖 | 缺失/重复依赖拒绝，多级依赖失败继续传播并唤醒 waiter |
| Task 消息 | 稳定 messageId、同 Session 原子投递、跨 Session outbox/inbox 去重、消费与回复登记同事务 |
| 共享等待 | shared-version/timer 叶子与 any/all/quorum 组合；唤醒输入保存具体 revision，暂停和删除不会使它漂移 |
| Effect | 逻辑身份去重、持久 deadline、明确幂等 adapter 的失败重试、未知结果保持 indeterminate、resolveEffect 幂等人工裁决 |
| Fencing | stale claim/abandon 拒绝；Effect emit/shared write/budget charge 在写事务中验证 lease；失去 Effect lease 时 abort 本地执行 |
| Cache | step/task/session scope、reusable/single-use、显式 sources/mode/fingerprint、TTL/配额、grants、generation、续期/失效、持久读 receipt |
| Effect 容量 | maxConcurrentEffects 独立限制外部执行并发 |
| TaskBoard | claim token；renew/complete 需要匹配 token 和未过期 lease |
| 观察/接入 | Event schema 标识、增量 Effect 来源、终态 journal 补读；UI 附着控制器使用新的 pause/interrupt/resume API |

上述功能以新增协议测试和已有调用方回归测试验证，不表示全部主协议扩展已经实现。

## 2. 暂停与继续

```ts
const paused = await task.pause({ requestId: 'pause-001' });
// 请求已持久接受；有在途 Effect 时 acknowledged 可能暂时为 false。
const snapshot = await task.status();
if (snapshot.task.control?.acknowledged) {
  await task.resume({
    requestId: 'resume-001',
    expectedEpoch: snapshot.task.control.epoch,
    signal: { type: 'input', payload: '根据新的要求继续' },
  });
}
```

interrupt 使用相同控制屏障，并保存 mode/reason。当前外部操作采用 **drain**：暂停新的派发，等待在途 Effect 完成或进入明确的未知结果；不承诺任意操作瞬间停止。控制 mode/acknowledged 与 Task 的基础调度 status 分开读取。父恢复只解除父施加的 hold，不能解除 child 自己的 pause；Session 屏障同样不能被 Task resume 绕过。

`session.close({ cancelRunning: false })` 表示接受 drain 请求；仍有工作时保留 closing，由轮询推进到 closed。`cancelRunning: true` 持久取消工作和清理责任。adapter 无法确认已派发操作的清理时，不会假报 Session 已关闭。cancel 后任务逻辑终态与 Effect.cleanupPending 分别可查询。

## 3. 通信与共享等待

Task 或 Decision 都可发送显式消息：

```ts
await sender.sendMessage({
  idempotencyKey: 'request-001',
  targetSessionId: targetSession.id,
  targetTaskId: targetTask.id,
  topic: 'build',
  payload: { revision: 'abc123' },
});
```

Program 中用 `send-message` action 发送，和本次状态/输入消费一起提交。接收方等待 `{ type: 'message', topic: 'build' }`，收到 `TaskInputEvent` 的 message 分支。回复使用原消息 id 作为 correlationId，目标取原消息 sourceSessionId/sourceTaskId。inbox 的 delivered 与 consumedAt 分别表示投递及业务消费事实。

共享状态等待写在 Decision 中：

```ts
return {
  state,
  next: {
    type: 'wait',
    on: {
      type: 'any',
      waits: [
        { type: 'shared-version', key: 'build.result', afterVersion: 12 },
        { type: 'timer', id: 'build-deadline', at: deadlineAt },
      ],
    },
  },
};
```

`shared-changed` 输入携带被绑定的 SharedStateRevision。timer 使用绝对时间；不要把 `TaskHandle.wait({ timeoutMs })` 当作持久业务 deadline。any 只决定等待何时满足，不会自动取消其他工作。

## 4. Task 管理与选择 Cache

默认 cache 私有于 Task，可重复读；pause 不使其失效。通过既有 Resource grant 可以显式共享 Session cache。

```ts
const { namespace, handle } = await task.createCache({
  name: 'parsed-files', scope: 'task', usage: 'reusable',
  ttlMs: 60_000, maxEntries: 128, maxBytes: 4 * 1024 * 1024,
});

await task.publishCache({
  operationId: 'parse-publish-001', handleId: handle.id,
  key: 'src/main.ts', fingerprint: 'contentHash:parserVersion',
  expectedGeneration: namespace.generation,
  value: { imports: ['example'] },
});

const receipt = await task.readCache({
  operationId: 'parse-read-001', mode: 'prefer-cache',
  sources: [{
    handleId: handle.id, key: 'src/main.ts',
    fingerprint: 'contentHash:parserVersion',
  }],
});

await task.invalidateCache(handle.id, namespace.generation);
// 重读相同 operationId 返回已经持久保存的 receipt；新 operationId 才重新选择 cache。
```

`sources` 按顺序选择，且每个来源都必须授权。`cache-only` 在 miss 时不触发计算；`refresh/bypass` 返回 bypass，由 Program 显式决定后续 Effect 和是否 publish。内核不会隐式重复副作用或把 cache 内容全部注入模型。

Program 内可以用 `cache-create` action 自行创建 namespace，等待 `{ type: 'cache-management', operationId }` 后从 `cache-managed` 输入获取持久 handle；随后使用 `cache-read/cache-publish`。`cache-invalidate/cache-renew` 同样通过带 operationId 的 action 自主管理缓存，不需要 reducer 捕获 TaskHandle 或内存 Map。`cache-read` 的 `cache-result` 输入与 Decision 同事务提交，可等待 `{ type: 'cache', operationId }`。当前小 JSON 值直接复制到 task.seq 的 durable receipt；缓存失效、TTL 和容量淘汰不会删除该 receipt。

`listCaches()` 枚举获授权且未失效的 namespace；`renewCache(handleId, generation, ttlMs)` 续期尚未过期的条目并增加 generation。旧 fill 无法覆盖新 generation；已过期或 consumed 的条目不会复活。single-use 在当前 SeqFile authority 的一个事务中完成读取、标记 consumed 和写 Task receipt，重试只返回原操作的结果。

## 5. 兼容性与仍需实施的扩展

- TaskSpec.requestId、TaskRecord 的 step/control 字段及事件 schema 字段是新增字段；旧记录通过字段缺省逻辑读取。尚未提供通用业务 state/schema migration API。
- retry.maxAttempts 现在按执行步限制重试；attemptCount 仍是全部 lease 的历史计数。需要沿用旧的“整个任务所有执行量子上限”时，调用方应增加明确的业务步数预算。
- TaskBoard 的 `renewTaskBoardLease(id, assigneeTaskId, leaseToken, leaseMs?)` 和 `completeTaskBoardItem(id, leaseToken, result?, failed?)` 必须传回 claim 返回的 token；旧的无 token 完成调用不再安全，也不再支持。
- 目前 parent 关系提供控制屏障与取消监管；structured/detached TaskGroup、父成功前自动 join、first-success 策略仍需独立落地，不能根据 parent 字段假定已有。
- 跨 Session 支持数据副本与 Task 消息；owner-managed SharedResource 命令/版本订阅服务、跨主机认证 transport、严格单来源发送顺序和背压/dead-letter 仍是扩展项。现有 mailbox 消费沿用 Task 输入队列，不声称已实现多 channel 独立消费水位。
- Cache 的跨 Session owner 资源、provider 远端 cache 管理、artifact promotion、大内容存储、aggregate quota、pin/GC 服务尚未实现。当前 maxEntries/maxBytes 限制每个 namespace，Task receipt 使用独立的持久保留策略。
- Effect 的 cancel-and-reconcile/checkpoint-and-detach 控制策略、cleanup lease/跨 worker 幂等确认、完整 reservation/settlement 账本仍需扩展。当前 cleanup 可能至少一次调用 adapter.cancel，adapter 必须幂等。
- 当前恢复/等待刷新使用持久记录扫描；大规模部署还需分页、索引、保留与 compaction。native SQLite/IndexedDB 多进程 kill 验收未在本轮运行。

## 6. 验证

- durable-kernel：64 项测试通过（原有 36 项 + 新协议 28 项）；TypeScript 检查及 ESM/CJS/类型声明构建通过。
- llm-tasks：17 项；llm-flow：50 项；llm-session：50 项；kernel-adapters：20 项回归测试通过。
- llm-ui：附着控制器 5 项测试通过；新的控制面与窄接口已接入。
- 上述包类型检查通过。app-shell 没有独立 tsconfig/typecheck 脚本，本轮未声称其独立类型检查通过；需要真实 API 的 app-shell 集成测试未运行。

本记录是当前实施边界，不把平台故障注入或上述扩展项标记为完成。

## 7. 简化核心重构：实际 API 与边界

新增入口 `@itookit/durable-kernel/core`，提供 `createHarness()`、`Session`、`Task`、`Resource` 类型与 `defineTask()`。旧根入口、状态枚举及已有存储仍兼容；不会把旧 ResourceRecord/Handle 自动解释成新容量池。

```ts
import { createHarness, defineTask, resourceResult } from '@itookit/durable-kernel/core';

const harness = createHarness({ catalog: { fs, rootPath: '/kernel' } });
// 同一个事务型 IModuleFS 实例用于 kernel root 与这些 Session 的不同 root。
harness.registerStorageResolver({
  kind: 'local',
  async resolve(ref) { return { fs, rootPath: String(ref.locator) }; },
});
await harness.initialize();
const session = await harness.createSession({ id: 'S1', storage: { kind: 'local', locator: '/sessions/S1' } });

const program = defineTask<number, number, number>({
  kind: 'counter', version: '1', state: 0,
  step(state, event) {
    if (event.type === 'initialize') return { state: event.input, next: { type: 'continue' } };
    return { state, next: { type: 'complete', output: state } };
  },
});
harness.registerProgram(program);
const task = await session.spawn({ program: program.manifest, input: 3, deferStart: true, requestId: 'task-1' });

const pool = await resourceResult(harness.resources.create({
  requestId: 'pool-1', kind: 'pool', name: 'browser', capacity: 2,
}));
await resourceResult(harness.resources.share(pool.ref, {
  requestId: 'share-S1', toSessionId: session.id, rights: ['execute'],
}));
const handle = await resourceResult(task.resources.open(pool.ref, {
  requestId: 'open-browser', name: 'browser', rights: ['execute'],
}));
const claim = await resourceResult(task.resources.acquire(handle, { requestId: 'take-browser', quantity: 1 }));
// 此处仅取得逻辑容量。真实外部调用仍用 Effect，并由 adapter 校验许可/执行权。
await resourceResult(task.resources.release(claim, { requestId: 'release-browser' }));
await task.start();
console.log(await task.wait());
```

`defineTask` 将一个同步、纯 step 函数适配到已有 init/reduce 状态机；初始 state 被固定并为每个 Task 克隆。初始化事件为 `initialize`。没有增加另一套执行引擎，也没有承诺恢复普通 async function 的栈。外部操作仍使用已有 `effect` action，提案中的 `call()` 简写尚未引入。

窄 Task 接口提供 `stat/stats/watch`、控制、等待、`send`、`cache` 和 `resources`。`cache.create/list/read/publish/invalidate/renew` 复用既有 cache 协议；`send` 复用持久 mailbox。详细 Attempt/Effect 诊断仍可从兼容根入口访问。

`stat()` 显示 phase、控制请求/确认、blockedBy、exit、activeOperations；`stats()` 显示已记录的 step 计数、Attempt 数、待消费输入和操作数，附 observedRevision。统计不用于资源准入。`session.stat()` 显示简明生命周期；关闭被占用资源阻塞时返回 `blockedBy: resource-claims`。`watch()` 复用 journal，未重做第二条事件链路。

资源当前只实现两个 managed kind：`pool`（正整数容量）与 `shared`（小 JSON + CAS version）。`kernel.resources.create` 的 scope 为 `kernel`，`session/task.resources.create` 的 scope 为 `session:<sessionId>`。Task 创建者可管理自身创建的资源；其他 Task 需 Session 授权或宿主显式 open。宿主接口是可信管理面，Task 绑定接口会校验 holder，不能把任意调用方传来的 taskId 当认证。

`create/share/open/acquire/release/close/read/write` 返回持久 Request；`request(scope, requestId)` 可重连查询，`resourceResult()` 是宿主等待便利函数。requestId 按调用 Session/Task 和 authority scope 隔离，同键不同内容冲突。`open` 在 Task 绑定接口可省略 taskId；在 Session 接口必须指定。`list()` 返回本调用域的 Task handles，kernel scope 无 Task handles；它不是全局资源枚举 API。`stat(ref)` 返回已授权可见本体、held 和 waiting。共享值的 read receipt 固定当时版本，重放原 requestId 不读取最新值。

acquire 按同资源的请求次序分配，排队 deadline 与客户端 wait timeout 分离；客户端超时不取消申请。显式 cancel 可写先于申请到达的 tombstone。Session suspended 时申请保留，resume 后继续；closing/终态请求者的未分配申请失败。已授予的 claim 不因暂停、worker 丢失或 Task 终态自动释放。`close(handle)` 拒绝仍有 claim 的引用，Session close 等待显式 release。

claim 是无自动到期的协作许可，release 必须传回 token 和正确 holder。`validate(claim)` 检查许可是否仍有效及持有者控制状态，不能代替 adapter 的实际外部 fencing，也不能证明设备已停止。调用方确认清理后才 release；未知操作不能靠 TTL 回收。这一首版没有自动物理设备管理或通用 lease 抢占。

Program 原生动作和等待如下；它们与 Task Decision 同事务，不占外部 Effect 槽等待资源：

```ts
actions: [{ type: 'resource', command: {
  type: 'acquire', requestId: 'take', handle, quantity: 1,
} }],
next: { type: 'wait', on: { type: 'resource', scope: handle.ref.scope, requestId: 'take' } }
// 结果事件：{ type: 'resource-result', receipt: { id, scope, status, result?, error? } }
```

claim 结果、resource-result 输入、Task 唤醒和请求完成标记原子提交。重放回执不会再入队一次。整个 Decision 中后续动作校验失败时，之前的资源修改和 Task state 一起回滚。

新记录位于 authority/使用方 `resources.seq` 的 `managed/*` 命名空间：`schema=1`、resource、access、handle、claim、request、sequence。capacity 与 claim 是唯一权威，handle 保存使用方引用。不同 root 必须解析到同一 IModuleFS 实例；当前以对象身份保守验证事务域，跨模块/后端直接拒绝。资源轮询、恢复及 release 都推进 pending 请求。普通文件不参与这些事务；未新增 artifact 发布或文件回滚承诺。

Session cache 的授权检查已移除对创建 Task 本体的读取依赖，测试覆盖删除创建 Task record 后另一已授权 Task 仍能读取；grant 链仍需保留。这不是完整 owner schema 迁移或自动 GC。

验证：durable-kernel 80 项测试（原有 64 + 本轮 16），包括容量争抢、重连去重、取消/期限、权限、CAS、暂停/关闭、原生 Decision 原子回滚及等待时更换 worker。下游 llm-tasks 17、llm-flow 50、llm-session 50、kernel-adapters 20、UI 附着控制器 5 项回归通过；相关类型检查与双入口 ESM/CJS/DTS 构建通过。这里的重启验证是重建 Kernel 实例与共享 Memory 后端，尚不等于真实 SQLite/IndexedDB 多进程 kill 验收。
