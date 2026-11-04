# VFS sidecar 读取成本：测量与决策（更新 2026-09-13）

> 活文档。本文补上 [TODO](../todo.md) P0-02 里「发送延迟剩余方向需先定语义」缺的那一步：把一次发送的 sidecar 读取按调用点量化，给出候选方案的**上界测量**，并决定先做哪一层。
> 相关：[VFS 实现状态](./vfs-implementation-status.md)、[最小系统验收记录 §12/§19/§26](../minimal-system-acceptance.md)。

## 0. 当前测量与历史口径修正（2026-09-13）

旧 `.tauri-acceptance/probe-sidecar-attrib.mts` 的 `total` 把操作计数与 `args:` / `stack:` 归因计数相加，存在重复计数；测量窗口还包含主动 `eventList` 轮询及 6 秒收敛等待，缓存命中表也未统一排除启动阶段。下文 §2–3.5 是历史观察，**1804 总数、百分比及按比例外推桌面 IPC 的结论不能作为有效量化依据**。“增量优化不可能达到目标”也尚无证据证明，不能据此将性能要求移出范围。真实窗口的既有 4.2–4.4 秒 / 584–590 次结果来自其他计量入口，不由本探针替代。

新可维护入口：[profile-send-cost.ts](../../apps/cli/tests/fixtures/profile-send-cost.ts)。使用全新临时数据根、真实 app-core/LocalFS/Node SQLite 与随机端口 HTTP mock；仅在 `sendMessage` 前开启计数，在 Provider 收齐首个请求时停止。等待直接由 HTTP 请求完成通知驱动，不轮询 Kernel。操作总数只求和 operations，路径归因另列 topSignatures；初始化、回复执行和释放不计入窗口。

两次独立运行均为 **554 次 sidecar 逻辑调用**，Node 本地耗时 63 / 64 ms：

| 操作 | 次数 |
| --- | --- |
| getRecordField | 145 |
| getMetaExt | 89 |
| setRecordField | 84 |
| listRecordFields | 82 |
| begin / commit | 74 / 74 |
| deleteRecordField / upsertMetaExt | 4 / 2 |

热项：Kernel Session record 读取 33 次、tasks 目录 meta 23 次、Session 文件 meta 19 次；用户会话记录与历史索引各读取 15 次。该结果支持优先追踪写事务数量、托管资源扫描和重复前置状态读取；仍需逐调用点证明哪些可以合并。

**这些不是 Tauri IPC 次数**：Node 方法与桌面 SQL 方法实现不同，一个逻辑方法可发出多次 SQL IPC；文件系统 IPC 也不在此表中。本地 63/64 ms 不证明桌面 ≤2 秒。保留持久化边界及租约/CAS 最新值语义，不能通过省略持久写入达到指标。任何优化均需同口径重测，并补真实 Tauri 总 IPC 与延迟验收。

复现（仓库根目录）：

```bash
pnpm --filter @itookit/cli exec node --import tsx tests/fixtures/profile-send-cost.ts
```

### 0.1 已实施：合并资源清理候选读取事务

`ManagedResourceStore.sweep` 在完成 `sweepResourceTx` 的同一事务内返回清理候选，移除 `runCleanups` 开头仅用于枚举候选的独立事务。物理清理仍在事务外执行；每条候选在执行前另开事务重读当前状态、重试时间并写入认领，清理确认与容量释放逻辑保持。

最终工作树探针为 **532 次逻辑调用 / begin 64 + commit 64 / 64 ms**，对照改动前 554 次 / 74 + 74，事务边界调用减少 20 次。改动过程另两次测得 533、520 次（后者在计量截止时 begin/commit 为 62/63，反映后台调度与窗口截断）；不能将所有差值都归因于本次优化。本地耗时没有可据以宣称改善的变化，真实桌面仍待复测。Durable Kernel 整包 202 项通过，类型检查通过。

### 0.2 已实施：从目标向上检查目录

`ensureTree` 从目标路径向上查找最近的已有目录，然后顺序创建缺失子目录；不再每次从根逐段检查。没有持久或进程内目录缓存，每次调用重新检查目标。协议回归验证已有深目录只读一次、两级缺失目录只读三次，并验证删除后再次创建成功。

本轮探针为 486 次 sidecar 逻辑调用，getMetaExt 70、begin/commit 各 59；本地 65 ms。相较上一轮 532 次，扫描/事务调度也发生变化，不能将全部 46 次差值归因于目录优化。确定性证据是上述目录读取次数回归；内核整包 203 项和类型检查通过。真实桌面计量仍未补齐。

### 0.3 已实施：每次批量读取只解析一次路径

`SeqFileOps.getEntries` 先解析文件路径，再并发读取所需字段；此前每个字段都经 getEntry 重复解析同一路径。只在本次调用内复用解析结果，下一批重新解析；空批次不解析，解析失败不触发记录读取。两项回归覆盖计数、下一批路径目标变化与失败边界，VFS 整包 175 项及类型检查通过。

同一发送探针本轮 482 次逻辑调用、getMetaExt 66 次、事务 59 组、本地 66 ms；上一轮对应 486/70/59。字段 SQL 仍逐项调用，尚未增加 sidecar 批量 SQL 原语，不能据此宣称接近 ≤100 次真实 IPC 目标。

### 0.4 桌面公开 API 调用计量

trace 构建现在通过 Vite alias 包装 `@tauri-apps/api/core` 的公开 invoke，日志新增 ipcOps/ipc（按命令名聚合），与原 ops/sidecarOps 分开；失败请求也计数，不记录参数。日志自身追加使用原始 invoke，避免自计数。普通构建直接转发且不累计计数。

本机 Tauri 2.10.3 的内部 invoke 属性不可写，因此实现不修改 `window.__TAURI_INTERNALS__`。测试覆盖冻结内部对象、trace 开关、失败计数与诊断旁路；桌面类型及正常前端构建通过。

边界：计数范围是经构建 alias 的公开 API 请求，不等于底层传输次数；Tauri 内部直接调用、传输重试和绕过该导入路径的请求未自动覆盖。已补 Tauri API 内部 `./core.js` 相对导入解析，`node apps/tauri-app/scripts/verify-ipc-trace.mjs` 使用真实 Vite 配置构建并执行官方 event 模块，验证订阅/退订各计数一次且宿主内部对象冻结。真实 WebView 30 秒 smoke 已验证字段落盘（[验收 §69](../minimal-system-acceptance.md)）：同一区间逻辑计数 34、公开 API 请求 70。之后已取得真实窗口 ping 请求样本：2.707 秒，覆盖区间共 953 次公开 API 请求，因区间跨越动作边界不能视为精确发送计数（[验收 §70](../minimal-system-acceptance.md)）。通道回调取数等遗漏检查以及最终完整 IPC 口径仍未完成，不能用新增字段提前关闭 P0-02。

## 1. 现状与目标

桌面宿主上 **每一次 sidecar 调用都是一次 Tauri IPC**（`TauriSqlSidecarDb`）。第七十五轮后真机单次发送约 **4.4s / ≈590 次 IPC**，P0-02 的建议阈值是 **≤2s / ≤100 次**。第七十八轮已消掉「会话每次提交都触发托管资源全量清扫」的冗余，之后的成本主要是**同一批数据被反复读取**。

无界面探针 `.tauri-acceptance/probe-sidecar-attrib.mts`（`.tauri-acceptance/` 已 gitignore）在一次发送 + 收敛窗口内按「操作名 + 参数 + 调用栈」聚合 sidecar 调用。

## 2. 测量（一次发送 + 静置，共 1804 次 sidecar 调用）

| 操作 | 次数 |
| --- | --- |
| `getRecordField` | 253 |
| `getMetaExt` | 172 |
| `listRecordFields` | 141 |
| `setRecordField` | 127 |
| `begin` / `commit`（写事务） | 118 / 118 |

最热的重复读取（同一路径 + 字段）：

- `kernel/session.seq :: __vfs_seq__:record` **57 次**（会话记录）；
- `kernel/tasks/<task>/task.seq :: __vfs_seq__:record` 28 次；
- `session.seq :: __vfs_seq__:session` 25 次；
- `kernel/events.seq :: __vfs_seq__:next-sequence` 18 次；
- 目录/文件 `getMetaExt`：`kernel/tasks` **38 次**、`kernel/session.seq` 31 次、`shared.seq` 25 次、`task.seq` 21 次；
- `resources.seq` / `index.seq` / `messages.seq` 的 `listRecordFields` 各 26–51 次。

## 3. 两个缓存方案的**上界**测量

探针把读调用分别放进两种 memo 并统计命中（命中即可省下的调用数）：

| 方案 | 语义 | 命中（可省调用） |
| --- | --- | --- |
| **A 事务内缓存** | 只在 `begin`…`commit` 之间记忆，事务结束即清 | `getMetaExt` 20、`listRecordFields` 20、`getRecordField` 2，合计 **42**（≈2%） |
| **B 写失效缓存** | 读结果一直保留，**任何写**（`setRecordField`/`upsertMetaExt`/事务/删除）清空整表 | `getMetaExt` 310、`getRecordField` 109、`listRecordFields` 95，合计 **513**（≈28%） |

**结论**：

1. **「同一 tick 内的重复读」不存在**——另一轮把 memo 的清理放在 microtask 排空时，命中为 **0**；重复读分布在多个 tick/事务里。
2. **严格事务内缓存（A）基本无收益（2%）**，不值得引入复杂度。
3. **写失效缓存（B）能消掉约 28% 的 sidecar 调用**，但仍达不到 ≤100 次；而且它有一个必须正面回答的风险：**纯读静默期没有写来清表**，缓存可能长期保留旧值（会话记录、meta、租约文件都属于会被别的宿主改写的路径）。

## 3.5 追加测量（同轮）：为什么"加批量原语"本身没有收益

1. **每次读调用独占一个 microtask tick**：`getRecordField` calls=296/ticks=296、`getMetaExt` 541/541、`listRecordFields` 200/200，"同 tick 可合并" 为 **0**。原因是这些调用是**严格串行**的（每次 await 一次宿主往返，下一次只能在后续 tick 发起）。所以「把 sidecar 批量原语做出来」只有在**调用方先并发发起**时才有用；当前读路径没有这样的调用方。
2. **`LocalFSBackend.list` 逐子项串行取 meta**（`for (const entry of entries) { await fsOps.stat(...); await db.getMetaExt(...) }`），但它只占 `getMetaExt` 的 **8/172**——按它做批量收益极小。
3. **主要重复来自"每个事务都重新确认目录/文件存在"**：`ensureTree`/`ensureSeqFile` 对每个路径段调用 `exists`（→ `stat` → `getMetaExt`）。最热参数正是 `kernel/tasks` 38 次、`kernel/session.seq` 31 次、`shared.seq` 25 次、`task.seq` 21 次，合计约占 `getMetaExt` 的 2/3。
4. 即便把上面全部消掉：`getMetaExt` 172 + 可省的重复字段读 ~100 ≈ 总 1804 次里的 ~15%；真机 590 次大约能到 ~450 次。**结论：≤100 次/≤2s 不是增量优化能达到的**，需要改变持久化访问模式（例如一次 Run 期间把会话内核状态留在内存、只在边界 flush），那是另一件事，超出「最小可运行系统」的范围。

## 4. 决策

**不引入进程内读缓存；也不单独引入"批量原语"。** 理由：

- A 无收益；B 的收益上限（≈28%，真机约 590→420 次）不足以跨过 ≤100 次的门槛，却引入「跨进程写入不可见」的语义风险；当前每会话单写者只是**租约**约束，恢复/接管场景下第二个宿主确实会写同一份数据。
- §3.5 追加测量说明：读调用是**串行**的，批量原语没有可用的调用方；仅 `list` 一个逐子项循环也不足以改变量级。因此先做「减少逻辑读取」（下一条 2），批量原语只在**调用方并发**成立时才跟进。真正能到 ≤100 次的是**协议层**变化：
  1. **合并调用**：像第七十五轮的 `statMany` 一样，给 sidecar 增加批量原语（`getRecordFields(paths)` / `getMetaExtMany(paths)`），一次 IPC 取多条；探针显示 `getMetaExt`/`getRecordField` 里有大量**可枚举的小集合**（同一目录下的任务、同一文件的多个字段），适合批量。
  2. **把「每个逻辑步骤重读一次会话/任务记录」改成显式传参**：`session.seq::record` 57 次、`tasks` 目录 38 次都是「每一步都重新确认前置条件」的结果；调用方持有切片（例如一次 `poll` 的会话记录、一次任务列表）时不应再回读。
  3. 只有在 1+2 之后仍显著偏高时，才考虑**带作用域与 TTL 的读缓存**（例如绑定到一次 `poll`/一次 Run 步骤，并对租约/CAS 路径显式旁路）。

## 5. 若将来引入读缓存，必须满足的语义与测试

- **作用域**：绑定到一个明确的逻辑步骤（一次 `poll`、一次 Run 步骤），而不是「一个 tick」或「一段时间」；步骤结束显式失效。
- **失效**：本进程内任何写路径（记录写、meta upsert、rename/delete、事务提交）都必须使相关路径失效；**CAS/所有权判定路径必须旁路缓存**（租约续期、任务抢占、`compareAndSet`）。
- **跨进程**：文档必须写明「另一宿主对本数据根的写入在缓存作用域内不可见」，并把租约/CAS 类路径排除在外。
- **测试义务**：写后读一致、删除/重命名后一致、会话关闭再打开后一致、跨 Session 不串、CAS 读到最新值、以及一条「同一作用域内重复读只发生一次」的计数断言。

## 6. 可复现命令

```bash
cd apps/cli && node --import tsx ../../.tauri-acceptance/probe-sidecar-attrib.mts
```

输出包含操作计数、最热参数签名、以及上面 A/B 两个上界。真机侧用量见 [验收记录 §19/§26](../minimal-system-acceptance.md)。


## 2026-09-14：已打开读者的 rename 崩溃窗口

真实两个 OS 进程、LocalFS/SQLite，读者先打开，写者在文件系统 rename 完成且 sidecar 迁移之前 SIGKILL。此前 root/module 两个挂载用例均失败：读者返回旧路径记录，目标记录缺失，journal 留存。原因是 journalDirty 在读者启动时置为干净，后续只读绕过事务且写事务不再探测日志。

移除进程内 journal 干净缓存，恢复检查与读取保留在同一事务中。目录类型批量检查不受此修改影响。此前基于跳过恢复检查的事务数、发送成本样本不再代表正确实现的性能；P0-02 的 ≤2 秒 / ≤100 次桌面 IPC 仍须达成并重新测量，后续优化应合并有原子性保证的宿主调用。

本轮验证：LocalFS 配置内全套 66 项通过（含真实进程 SIGKILL、root/module 与预先打开读者），类型检查通过。修复后同口径 Node 发送探针：62 ms、857 次 sidecar 逻辑调用，其中 begin/commit 各 166 次；这是本机逻辑成本，不能替代桌面 IPC/延迟验收。


## 2026-09-14：core 内部调用覆盖

公共 invoke 的导出包装会漏掉同一 core 模块中的 Resource.close、checkPermissions/requestPermissions、addPluginListener 与 PluginListener.unregister。真实 Vite 构建回归已复现；现改为在官方 core invoke 内部记录提交，不改写宿主内部对象。兼容注册的第一次失败与第二次 fallback 分别计数；诊断写入显式旁路。trace 开/关两次构建执行均通过，正常关闭时所有计数为空。

范围仍是经过该官方 JavaScript core 的调用，不能推断为全部底层传输。动作边界快照、WebView 内部通道取数/传输重试与真实窗口计量需继续补齐。

## 2026-09-22：有明确调用方后的批量读取

新的 WebKit 录制显示 302 个 sidecar 外层事务、729 次 `sidecar_select`，并确认了两类可在调用前完整枚举的集合，因此满足本文 §4 的实施前提：

- `LocalFSBackend.list` 已经持有一个目录批次的全部路径，现按最多 64 项调用 `getMetaExtMany`，并把恢复检查和所有批次留在同一个外层事务；轻量 `listEntries` 继续不读元数据。
- `ISeqFileTransaction.getEntries` 已经持有精确字段集合，现通过可选 `IRecordTransaction.getRecordFields` 合成一次 SQL；路径映射适配器显式转发能力。Task event 分页分别批量读取指针和事件正文，代替每项一次 `getEntry`。
- Session `getLoadState` 把同一 `session.seq` 的 manifest/settings 改为一次 `getEntries`，确保桌面实际会话打开负载命中 `field IN (...)` 路径；history index 位于另一文件，仍在同一外层事务中单独读取。当前分支的父子索引可枚举且与 round 文档父指针一致时，整条历史链也由一次 `getEntries` 读取；不一致时在同一事务内回退逐项读取。100 轮 LocalFS 回归从 103 次单字段读降为 3 次单字段读 + 1 次批量读，事务仍为 1 组。

这次仍未引入进程级读缓存。批量查询发生在原来的事务和 journal 恢复边界内，不改变跨进程可见性；没有批量能力的后端保留逐字段兼容路径。四层嵌套 `FileSystemView` 还发现一个独立放大器：每层 `statType` 在前缀检查后再次查询目标，形成 16 次底层目标检查；现在复用 `noLinks` 已取得的目标类型，现有和缺失目标均为 1 次。

渲染侧也从启动路径移走 Mermaid：默认使用本地动态依赖，Tauri 构建产出独立 `mermaid-runtime` chunk，HTML 不预加载它；MathJax 只在渲染结果实际含公式定界符时加载。上述为代码与构建级证据，尚无改后真实桌面同口径录制，不能从旧 recording 推算最终延迟或宣称 P0-02 达标。

`LocalFSBackend.list()` 目前在恢复事务内执行目录枚举与分批 stat，宽目录会延长 SQLite 写锁。直接把枚举移到事务前并不等价：如果已有 rename intent，事务里的恢复可能改变目录内容，使此前枚举的路径与随后读取的元数据不属于同一命名空间状态。后续缩短这段锁持有时间需要在宿主侧提供可验证的目录快照/代次，或检测恢复及并发 rename 后重试；在此之前保持当前事务边界。

## 2026-09-23：Session 列表减少重复属性检查

Session 列表枚举目录后直接批量读取 manifest，不再对每个候选目录先做一次 `session.seq` 存在性检查；批量读取原有的 `ENOENT` 跳过逻辑仍处理创建中断留下的不完整目录。

## 2026-09-27：跨文件批量读 `getRecordFieldsMany`

§3.5 的结论「批量原语只在调用方先并发/可枚举时才有用」在 Task 扫描上同样成立，本轮据此新增第三种批量原语：`SeqFile.getEntriesMany(requests)`（多文件同名/异名键一次读，缺失 → `null`），内部优先走可选 `IRecordStore/IRecordTransaction.getRecordFieldsMany(requests)`，未实现时逐条回退。

调用方是 durable-kernel 的 `taskEntries`（`listTasks`/`listTaskIds`/恢复投影共用）：原先对 `tasks/` 下每个 Task 目录各读一次记录，在 LocalFS 上每次读自成一个事务与 journal 核对；现在一次目录枚举 + 一个事务内一次批量读。CLI 引导成本 fixture（3 Session + 9 终态 Task）sidecar 调用 994 → 814、事务 220 → 175；无 Task 的空 Session 场景保持 697/157 不变。

SQLite 侧一条 `SELECT … WHERE (path, field) IN ((?,?),(?,?),…)`（`SidecarRecordStore` 按 200 条/批），IndexedDB 侧一条 readonly 事务内同步发起全部 `get`；两者都在原有的外层事务/journal 恢复边界内，未引入进程级读缓存，也没有可枚举集合之外的调用方。路径映射（`mapRecordPaths`）与 `FileSystemView` 都转发该能力，避免视图层丢失批量语义。
