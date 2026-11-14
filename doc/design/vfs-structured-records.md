# SeqFile 结构化查询与统一 ioctl

状态：已实现核心契约、内存参考后端、better-sqlite3 与 Node SQLite driver。此能力用于宿主侧业务封装；已有业务的精确键读取保持现有接口，不因打开页面而安装 schema。

## 分层与入口

vfs-core 定义通用类型、权限、路径映射、分页和事务语义，不依赖 SQLite。driver 使用真实列、联合索引及参数化 SQL；业务模块声明自己的字段与索引，核心没有看板状态或历史字段。

文件与设备通过可选 `IIOStream.ioctl(command, input)` 扩展能力，不新增平行的 fcntl。FileHandle 通过 `fs.meta.seq.ioctl(path, command, input)` 调用记录能力，设备继续使用自身驱动的控制命令。未知命令返回 `ECAPABILITY`，不会无条件向底层转发。

结构化模块提供三个行命令，通用记录另提供只读键分页：

| 命令 | 输入 | 输出 | 模式 |
| --- | --- | --- | --- |
| `seq.rows.describe.v1` | `undefined` | schema 或 null | 只读 |
| `seq.rows.define.v1` | `{schema, expectedVersion}` | 实际 schema | 写入 |
| `seq.rows.query.v1` | `{select, where?, orderBy?, limit, after?}` | `{rows, next?}` | 只读 |
| `seq.keys.page.v1` | `{keyPrefix?, after?, limit}` | `{keys, next?}` | 只读 |

应用使用 `@nestos/vfs-core/seq` 的 `seqRowControl` 获得命令对应的输入和返回类型；driver 通过 `/seq/driver` 复用校验与分页原语。`ISeqFileTransaction.ioctl` 允许安装 schema、写入行和保存幂等回执在同一事务提交。

```ts
import {seqRowControl} from '@nestos/vfs-core/seq';

const file = fs.openFile('/runs.seq');
try {
    const page = await seqRowControl(file, 'seq.rows.query.v1', {
        select: ['state', 'updatedAt'],
        where: {column: 'state', op: 'eq', value: 1},
        orderBy: [{column: 'updatedAt', direction: 'desc'}],
        limit: 20,
    });
} finally {await file.close?.();}
```

`FSCapabilities.structuredSeqFiles` 由真实后端能力派生。当前 Memory、better-sqlite3 和 Node SQLite 支持；IndexedDB、Tauri 侧车尚未实现，明确返回 `ECAPABILITY`，不通过读取全部正文模拟查询。应用 RPC 尚未开放这些控制命令，远程文件视图将该能力标为 false，浏览器仍通过业务查询接口读取所需数据，不获得通用 ioctl 或 SQL 代理。

## Schema 与查询边界

Schema 包含正整数 `version`、非空 `keyPrefix`、`columns` 和可选 `indexes`。每个 SeqFile 一份 schema，只约束匹配前缀的 entry，因此同文件里的详情、回执和计数器仍可保持原格式。

```ts
const schema = {
    version: 1,
    keyPrefix: 'run:',
    columns: {
        state: {type: 'integer'},
        updatedAt: {type: 'integer'},
        title: {type: 'text', nullable: true},
    },
    indexes: [{
        name: 'state_updated',
        columns: [
            {column: 'state', direction: 'asc'},
            {column: 'updatedAt', direction: 'desc'},
        ],
    }],
};
```

- 第一版支持 text、integer、real、boolean 和显式 nullable。整数必须在 JavaScript 安全整数范围，real 必须有限；时间由业务约定为整数毫秒。状态是否用整数由业务决定。
- 最多 24 列、8 个索引，每个排序或索引最多 6 列；列名与索引名必须是有界标识符。文本列必须是有效 Unicode，最多 4096 UTF-8 字节；原记录中未声明的冷字段不受此列限制。行 key 最多 4096 字节，schema 前缀最多 256 字节。
- 投影必填，只返回选中的列；排序列可用于内部执行但不会额外出现在返回值中。页大小为 1–500，不隐式统计总数。
- 筛选支持 eq/ne/lt/lte/gt/gte/in 以及 and/or，校验嵌套深度和条件数量；IN 最多 100 项。null 的比较规则与 SQLite 一致。未知字段、操作符、额外参数和超限输入明确失败。
- 文本按 BINARY 排序，排序最后追加 entry key，形成确定的全序。keyset 游标绑定路径、schema、投影、筛选及排序；换条件、跨文件或 schema 更新后拒绝旧游标。游标是分页位置，不是授权凭据。
- 每次查询读取一致快照；跨页期间数据仍可变化，不声称跨页冻结历史。需要完整一致操作时使用明确的事务边界，不用跨请求结果缓存隐藏变化。

## 索引选择与通用读取

按实际查询声明复合索引：等值过滤列在前，排序列随后，非唯一索引追加 entry key 保证稳定分页。例如 `state = ? AND epoch = ? ORDER BY time DESC` 使用 `(path, state, epoch, time DESC, field)`，避免先把历史正文读出再筛选。测试用 EXPLAIN QUERY PLAN 核实覆盖索引；不为每个字段机械建索引，不为低选择性的状态列单独添加索引。重复等价索引会被拒绝，唯一索引只用于业务确实要求唯一的组合。新增列和索引增加写入及空间成本，业务应按查询形状明确选择。

已有精确键和前缀索引继续使用，不为获得新接口而重复物化。`seqKeys` 在能力支持时使用有界键分页，只读取主键，不读取正文或计算总数；项目 ID 保留检查、标签替换及最近运行索引清理已接入。Memory、SQLite、IndexedDB 和 Tauri 提供键分页；旧端口保留原遍历兼容路径。远程 RPC 仍将该能力标为 false。

`getEntries/getEntriesMany` 继续用于明确字段读取。IndexedDB 将请求排队为去重后的精确 point get，避免路径范围 getAll 克隆无关正文。SQLite 的路径存在检查并入已执行恢复的同一只读快照，省去额外节点元数据快照；不能绕过恢复提前判断路径。批次中不同路径可并行解析，单次调用内去重，不保存跨请求结果缓存。

纯读取使用 `readTransaction`，事务端口拒绝写入和完成后的继续访问；需要重建持久索引的操作仍使用写事务。普通 `walkEntries` 在 native 快照内获取选中项，结束快照后才执行用户回调，允许回调继续读取文件系统。完整导出、迁移及需要正文的遍历保留正文读取。

## SQLite 实际存储

原始 entry 仍在 `records(path, field, value)` 中保留完整字符串，包括空白和 JSON 格式，既有 getEntry、CAS 和普通写入口的语义保持不变。

新增 `vfs_row_layouts` 管理可共享的物理列布局。相同列、前缀与索引声明共用一个 `vfs_rows_<id>` 表，包含 path、field 及声明的原生 TEXT / INTEGER / REAL 列。列名映射为受控的 c0、c1 等，不拼接用户提供的 SQL 标识符；所有数据值参数化绑定。JSON 中的未声明字段留在原记录，日常列表查询直接读取结构化列。

这是兼容性的物化投影：高频字段同时存在于原字符串和结构化列中，增加部分存储空间；查询不会先取完整 JSON 再在 JavaScript 过滤。它没有把历史正文重写成另一套不兼容格式。

每个文件的 schema 与物理布局引用保存在记录后端的内部保留字段中，不出现在普通 SeqFile entry 遍历里。普通 raw record 写入不能覆盖该字段，必须通过受控 schema 命令安装或升级。SQLite 内部触发器让普通 setEntry、CAS 和删除也同步维护结构化列和唯一索引，数据与索引不会分别提交。

安装与升级在同一连接、事务或 savepoint 内执行：先验证期望版本，再准备布局并原子回填已有匹配行；任何类型、唯一约束或 DDL 失败都会回滚。仅提高版本且布局不变时无需重新读取正文回填；相同声明重复安装为幂等结果。读取不创建 schema，也不预留 SQLite 写锁；连接队列仍防止读入本连接尚未提交的写入，跨连接 WAL 读写可并行。

完整 schema 结构只在安装和升级时校验。普通读取解析已保存的声明并核对布局引用、版本，不重新跑整套定义校验；查询参数执行有界的字段与形状检查。普通写入直接执行，由 SQLite 触发器和约束返回具体错误，不先读取历史或正文做预检查。

旧数据库通过现有 v4 DDL 增量创建布局目录，无旧数据重写。只有显式 define 才创建物理表与触发器。删除文件会清理其记录和无引用的布局；持久 rename 通过原记录搬迁触发索引迁移，不依赖进程缓存。跨后端 `copyFileSystemTree` 迁移逻辑 schema 并重建目标布局，不拷贝来源数据库的内部布局 ID；目标能力不足或 schema 版本冲突时明确失败。

## 验证与诊断

ioctl 复用 VFS operation 事件，记录 operationId、固定 command、records.control 阶段、成功/失败、错误码、耗时及返回行数，不记录筛选值、正文或完整参数。schema 写入及行事件在成功提交后才发布；回滚不发成功的提交通知。失败区分输入错误、类型/大小不匹配、唯一索引冲突、版本冲突、能力缺失和存储布局异常。

固定 1200 行、每行 4096 字节冷内容、每页 20 行的宿主存储基准：Node SQLite 的 SQL 读取结果序列化大小从 5,133,305 B 降至 1,796 B，中位耗时从约 14.94 ms 降至 0.40 ms；查询计划命中覆盖索引。SQL 读取语句由 3 增至 4，增加的是 schema 读取，未宣称 SQL 次数降低。两种路径返回同样的页面 DTO；这不是网络或整页同比提速，已有页面未因此自动改用新查询。详见[基准与条件](fixtures/seq-rows-20261114.json)。

按键批量读取继续使用 getEntries/getEntriesMany，按列过滤和排序的历史查询使用 query。相关现状：[Kanban 存储](kanban-coordination.md)、[VFS 读取成本](vfs-sidecar-read-cost.md)。
