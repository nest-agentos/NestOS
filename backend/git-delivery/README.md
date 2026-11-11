# Git delivery

平台无关的 Git 交付领域模块，文件、Git 进程与持久日志均由宿主授权后注入。模块不启动模型、Task 或执行队列；已有 Task/Effect 经 Kernel 与 Session 的正式入口运行。

公开能力：

| 入口 | 职责 |
| --- | --- |
| `/contracts` | GitProcess、GitJournal、冻结源与批准契约 |
| `/worktrees`、`/repositories` | 相对命名空间工作树、子模块和源码交付核验 |
| `/snapshots` | 单源与批次 Git 证据版本 |
| `/results` | 冻结交付回执、版本及冲突方案格式核验 |
| `/integration` | 全部源提交、目标连续性、gitlink 及批准冲突的核验 |
| `/cleanup`、`/removal` | 资源清理意图、回执与 Git 删除；结果未知时保留责任 |
| `/branches`、`/archives` | 显式登记分支和不可变证据归档 |
| `/identity`、`/provenance`、`/contexts` | 提交身份、来源追溯及上下文核对；当前业务事实通过端口取得 |
| `/policy`、`/runtime` | Git 交付策略及已批准运行版本的来源核验 |

所有原 journal key、worktree 身份、分支、版本摘要及来源 schema 保持兼容。读取不创建 Task，不获取 Session writer，也不自行重派未知操作。资源准备/清理日志只管理资源意图，与 Kernel 的执行状态分别归属。
