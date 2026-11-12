# 软件开发操作插件

- 本包拥有软件开发的操作名称、阶段顺序、确认策略、版本证据、界面投影和软件开发操作编排。
- 通过 `createSoftwareDevelopmentPlugin` 注册，复用 kanban 的操作协调、取消、清理、占用及恢复机制。
- 不依赖 app-core、Kernel、Cells 或 UI 实现。Session/Flow 使用公开调用契约；项目授权、远程连接和服务切换由宿主注入。
- Git 规则与实际仓库副作用由 git-delivery 提供。不得在 kanban 核心加入软件开发动作分支或提示词。
- 兼容既有 review/automatic journal 键、操作 ID 和冻结请求；unknown 只核对原执行，不重派。
- `pnpm --filter @nestos/kanban-development test` 和 `typecheck` 验证插件自身，不加载 app-core。
