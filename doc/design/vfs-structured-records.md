# VFS 结构化记录查询提案

状态：设计提案，尚未实现。本地 driver 已使用 SQLite；本提案补充按列存储和查询的通用契约，不替换文件 IO 或现有 SeqFile。

## 目标与边界

业务层声明记录模式和实际需要的查询；vfs-core 定义类型、能力、授权与事务语义；driver 执行物理建表、索引、参数化查询和迁移。核心不依赖 SQLite、Node 或原始 SQL。前端调用业务视图接口，不接收任意建表、SQL 或索引管理权限。

现有 `IRecordStore` 是路径/字段/值模型，已有精确键批量读、前缀范围分页、查询和事务。拆分历史数组后的高频摘要已能精确读取，但每份摘要仍是一个 JSON 值，多列筛选、投影与排序无法完整下推。不要把现有 `RecordQuery.field`（记录键）直接改成行内列名，这会破坏兼容性。

## 最小契约草案

以下是结构化能力的类型形状，实际实现需要补齐泛型约束、错误类型及能力透传。文件入口优先复用下节提出的统一 `ioctl`，不要求再公开一套平行的文件定位机制。

## 统一文件控制入口

现有设备句柄支持 `ioctl(command, arg)`，普通 `IFile` 尚未支持。建议把通用文件控制契约提取后由设备、普通文件和 SeqFile 句柄共同实现。不另增 `fcntl`：其传统职责是描述符、标志和锁控制，结构化查询不需要额外的同义入口。

```ts
interface IFileControl {
    ioctl(command: string, input?: unknown): Promise<unknown>;
}
```

这一签名只负责通用分发；业务不直接操作无类型的 `unknown`。结构化模块提供带输入/输出类型的包装器，例如 `queryRows(file, request): Promise<RowPage>`，封装版本化命令 `seq.rows.query.v1`。模式发现使用 `seq.rows.describe.v1`；模式安装和迁移仅由受信宿主端口操作。具体命令输入在 driver 边界校验，不信任客户端提交的“只读”声明。

只读 query 命令应用下文的投影、条件、分页契约；写入仍经事务中的对应控制入口执行。事务句柄也须支持受约束的控制调用，否则一次查询/更新与 SeqFile 回执仍不能原子提交。不要在事务内部另开连接，也不要用 `begin/commit` 命令对外暴露可泄漏的长事务。

外部统一入口不代表内部只留一个无类型方法：vfs-core 仍声明结构化查询能力与语义，driver 可用强类型端口执行 SQL。视图负责路径、挂载、授权和只读限制；不能把未知控制命令无条件穿透给底层。无法支持的文件或命令返回 `ECAPABILITY`，不存在文件返回 `ENOENT`。HTTP 应用继续暴露业务查询与命令，不因此开放任意通用 ioctl 代理。

普通 SeqFile 的字符串读写及 CAS 语义保持兼容。第一阶段可对行 JSON 声明可索引字段，并由 SQLite driver 在同一事务维护真实投影列与索引；普通写入口也必须同步维护，不能只在新 ioctl 写入时更新。若进一步改成原生列加低频 JSON，必须显式迁移并定义兼容读写，不能让旧 `setEntry` 与新结构化更新各存一份独立事实。

## 结构化能力类型

```ts
type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'json';
type Scalar = string | number | boolean | null;
type Predicate =
    | {column: string; op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'; value: Scalar}
    | {column: string; op: 'in'; values: readonly Scalar[]}
    | {column: string; op: 'is-null' | 'is-not-null'}
    | {and: readonly Predicate[]}
    | {or: readonly Predicate[]};

interface TableSchema {
    version: number;
    columns: Readonly<Record<string, {type: ColumnType; nullable?: boolean}>>;
    primaryKey: readonly string[];
    indexes: readonly {
        name: string;
        columns: readonly {column: string; direction?: 'asc' | 'desc'}[];
        unique?: boolean;
    }[];
}
interface RowQuery {
    select: readonly string[];
    where?: Predicate;
    orderBy: readonly {column: string; direction: 'asc' | 'desc'}[];
    limit: number;
    after?: string;
}
interface StructuredTable {
    query(input: RowQuery): Promise<{rows: readonly object[]; next?: string}>;
    getMany(keys: readonly object[], select: readonly string[]): Promise<readonly (object | null)[]>;
}
interface StructuredReadTransaction {
    table(path: string): StructuredTable;
    seq: ISeqFileReadTransaction;
}
interface WritableStructuredTable extends StructuredTable {
    insert(rows: readonly object[]): Promise<void>;
    update(key: object, changes: object, expected: Readonly<Record<string, Scalar>>): Promise<boolean>;
    delete(key: object, expected: Readonly<Record<string, Scalar>>): Promise<boolean>;
}
interface StructuredTransaction extends StructuredReadTransaction {
    table(path: string): WritableStructuredTable;
    seq: ISeqFileTransaction;
}
interface StructuredRecords {
    open(path: string): Promise<StructuredTable>;
    readTransaction<T>(fn: (tx: StructuredReadTransaction) => Promise<T>): Promise<T>;
    transaction<T>(fn: (tx: StructuredTransaction) => Promise<T>): Promise<T>;
}
```

`ISeqFileReadTransaction` 在草案中表示现有 SeqFile 事务的只读子集，需要作为新公开类型提取。条件写入的 `expected` 可表达版本列的预期值，不强制核心内置固定名字的版本列。安装/升级模式由宿主受信入口执行，不放入普通 `open` 或读取调用。不得因打开表或读取而创建存储。

## 必须定义清楚的语义

- 表通过 VFS 路径寻址，路径映射、挂载、只读限制和授权与文件一致；跨后端事务明确失败，不伪造原子性。表记录、SeqFile 幂等回执和 outbox 必须能在同一物理后端事务提交。
- `select` 必填且禁止空集合；driver 只读取投影列。条件与排序列可用于数据库执行，但不加入返回值。`count` 是单独的按需操作，分页不隐式统计全部数据。
- 列名、索引和表标识经过模式白名单解析；值参数化绑定，不能把输入字符串拼成 SQL。限制查询深度、IN 项数、页大小和批量规模，拒绝超限，不静默截断。
- 排序以主键补齐成全序；文本使用明确的二进制排序。游标绑定表、模式版本、筛选条件、投影及排序，防止换条件误用。每次查询是一致快照；多次请求间的稳定历史视图需要显式快照能力，不能把 keyset 分页说成跨页冻结快照。
- `integer` 使用 JavaScript 安全整数范围，超限拒绝；时间统一整数毫秒；boolean 映射 SQLite 0/1；可空列显式声明。第一版不筛选 JSON 内部字段，需要筛选的属性必须独立成列。状态字符串是否编码为整数由业务模式决定，核心不内置业务状态。
- 更新/删除通过版本条件返回命中与否；写事务成功提交后才发布变更事件，回滚不发成功事件。索引自动随写入维护，业务不能分别提交数据和索引。
- `capabilitiesAt(path)` 声明结构化查询及共享事务能力。暂不支持的 driver 返回 `ECAPABILITY`，不静默全表读取来模拟性能承诺。第一版只要求 SQLite driver；其他后端后续按同一契约实现。

## 历史记录的物理示例

业务声明 `runs` 表：`id TEXT PRIMARY KEY`、`board_id TEXT`、`record_id TEXT`、`epoch INTEGER`、`state INTEGER`、`updated_at INTEGER`、`version INTEGER`、`detail_ref TEXT`。低频内容放 `run_details` 的 `payload JSON`（SQLite 存 TEXT），按详情引用读取。

常见查询对应联合索引，例如 `(board_id, record_id, epoch, updated_at DESC, id)`；状态筛选使用 `(board_id, state, updated_at DESC, id)`。索引应按真实查询组合选择，避免每列各建一个索引。完整冷内容只在详情页或恢复实际需要时读取，不把它重新拼回列表。

SQLite driver 使用真实独立列，按 schema 生成受控物理表名及 DDL；查询生成 `SELECT 指定列 ... WHERE ... ORDER BY ... LIMIT ?`，不依赖先取 JSON 再在 JavaScript 过滤。是否有收益须同时记录读取行数、字节、SQL 次数、耗时和 `EXPLAIN QUERY PLAN`；增加接口本身不保证更快。

## 实施顺序与验收

1. vfs-core 定义可选结构化能力，打通 engine、视图映射、权限和同后端事务，不修改既有 SeqFile 语义。
2. 本地 SQLite driver 实现真实列、联合索引、投影、条件版本写入和迁移；共用现有连接及事务管理，不另开无法原子提交的数据库。
3. 先迁移一类历史记录，校验旧数据完整往返及回滚策略，再替换业务读写。避免长期双写造成新的不一致来源。
4. 使用固定历史规模对比真实列表、单条更新、恢复场景；验证查询计划、内存、字节、并发读写、迁移中断和事件回滚。运行 core/transport/ui 性能检查并复测实际页面。

相关现状：[Kanban 协调存储](kanban-coordination.md)、[VFS 侧车读取成本](vfs-sidecar-read-cost.md)。
