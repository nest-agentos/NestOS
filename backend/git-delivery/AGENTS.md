# @nestos/git-delivery

Git 交付领域模块，拥有工作树、仓库证据、批准范围内的整合核验和资源清理规则。通过注入的 GitProcess/Journal/VFS 能力工作，不依赖 app-core、Session、Kernel 或 UI，不拥有执行队列、重试 Task 或模型提示词。

- 业务请求的持久执行、取消和恢复归 Kernel/Session/Flow。模块只核对资源事实和原操作回执；unknown 不重做副作用。
- 不修改既有 worktree/operation 身份、分支、journal key 或已冻结的批准。
- Git 命令通过受限 INativeShell 端口，工作区命名空间映射由适配器提供；禁止访问 Node 进程或宿主文件系统。
- 用户未提交、未合入、执行中或归属未知的资源继续保留。
- 对外仅使用 package exports；应用层不得保留同功能兼容实现。
- 注释用英文，日志保留阶段、结果和安全错误码，不记录内容或参数正文。
