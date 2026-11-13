# Kanban 操作插件

## 边界

| 层 | 职责 |
| --- | --- |
| kanban | 插件 ID/版本、动作注册与路由、原操作绑定、通用步骤推进、回执、取消、清理及恢复 |
| kanban-development | 软件开发动作、顺序、依赖、确认策略、版本证据与操作投影 |
| Session / Flow / Kernel | 正式调用、执行观察、未知 effect 核对和持久执行；不依赖 Kanban 或插件 |
| Cells | 原生 Session、指令队列及能力通道；历史会话不继承后续会话的通道 |
| app-core | 用户与项目授权、连接和端口装配；不实现操作插件或读取 Kanban 执行的 Kernel Task/effect |

软件开发插件源码位于 [backend/kanban-development](../../backend/kanban-development/README.md)。Git 规则及副作用仍归 git-delivery。通用看板不内置构建、部署或合并顺序。

## 注册

`@nestos/kanban/runtime` 的 `createKanbanRuntime` 和受信任装配入口 `assembleKanbanRuntime` 均接受 `operationPlugins`。宿主 extension 也可以贡献同名字段。插件是受信任代码，不从模型参数或项目文件动态加载 JavaScript。

插件声明 `{id, version, label, actions, create(context)}`。actions 包含插件内唯一的 `id`、`label`、可选 `dependsOn` 和 `coordination`；依赖必须存在且无环。`coordination: false` 的动作不进入管理会话的自动协调建议。相同动作名可存在于不同插件。

`create` 只收到 `service`、`journal` 和 `workLog`，不暴露 store 或 Kernel。其他已授权能力由注册宿主闭包提供。返回的 provider 提供 `itemOperations`、`runItemOperation`，可选 `applies`、`bindItemOperation` 及 `scan/quiesce/dispose`。领域执行复用 `coordinateOperation`、自动步骤推进与正式执行端口；不得另建执行队列，也不得把聊天文本当完成证据。

动作是否可执行、是否需要确认、结果如何核验由插件根据宿主真实授权和正式回执投影、执行；插件不能靠客户端 `confirmed` 获得自动授权。每个视图保留自己的 revision、会话入口、原因、确认与选择字段。看板只渲染返回的布局和字段。

## 路由与恢复

操作请求可携带 `pluginId`。单个可用插件兼容旧请求；多个插件的同名动作必须明确插件，不能猜测。初次调用在进入 provider 前原子冻结 `{pluginId, version, fingerprint}`；同一 operationId 改插件、改版本或改请求会被拒绝。插件负责复用原执行身份及持久回执；unknown 不重发。记录不因视图打开、刷新或卸载而创建、恢复或删除。

多个插件并列时视图返回 `plugins`；只有一个插件时沿用原操作布局，不增加标题。表单提交携带插件身份、插件内作用域和其自身 revision。单个插件读取失败只展示该插件的安全错误码，其他插件仍可操作。生命周期等待所有 provider，并保留各自失败，不因一个失败跳过其他释放。

## 既有会话

收尾会话可以替换目录的任务能力通道，但历史会话仍可继续对话。Cells 在恢复该历史会话时禁用已撤销的 `cells_session` 能力，不继承新收尾会话的令牌，不修改其执行事实，不复活旧 scope。需要新的业务能力时，由插件创建并绑定新的正式操作。此修复不自动重发先前已拒绝的用户指令。

验证口径与浏览器结果见 [实施记录](fixtures/kanban-operation-plugins-20261113.json)。浏览器结果使用真实领域、存储和 DOM，不代表生产 HTTP 页面的完整性能验收。

## 按步骤限定交付占用

插件通过通用自动交付策略的 `targetActions` 声明哪些步骤需要共享目标占用；未声明时保持全流程占用。声明随执行状态冻结，旧状态首次恢复时从当前插件补齐，不改操作身份或已有请求。软件开发插件的集成、构建、部署与验收阶段继续串行；工作树清理使用各资源自身的执行核对、清理回执与进程互斥，不占用整个交付目标。清理前置检查缺少关联时保留该任务的阻塞，不把它标成成功，也不阻塞其他已就绪管理任务。共享目标步骤的未知回执仍保留占用，不能重派或抢占。
