# 模块化 MCP Skills

Cells 提供会话作用域内的 MCP Skills 发现与读取。NestOS 宿主支持静态清单与一次性批准的动态入口文件。协议使用 MCP `2026-07-28` 和 Agent Skills 格式，初始实现以固定的 ext-skills 提交为基线，并与官方规范概览核对。 [原始基线](https://github.com/modelcontextprotocol/ext-skills/blob/c0705f9071caa539eeb2c9f5f2f77ac16b498ca6/specification/beta/skills.mdx) · [官方规范概览](https://modelcontextprotocol.io/extensions/skills/overview)

## 贡献与投影

通用贡献契约声明模块 ID、版本、来源节点、Skill URI、阶段、所需权限，以及完整 frontmatter。静态贡献列出授权相对路径、文件 URI、字节长度与 SHA-256。动态贡献用 `resources: 'dynamic'`，Cells 的项目贡献另以 `dynamicPath` 登记唯一可读入口。路径必须在授权项目挂载内。动态支持文件可由模块另行声明为带清单的 Skill。

Kanban 只投影已确认决策明确选择的模块版本与当前阶段允许的内容。软件开发模块通过提供者契约贡献 `kanban-work` 及按需参考文件。Node 部署可用 `NESTOS_KANBAN_SKILL_PERMISSIONS` 为指定 Cells 服务端与该服务端的项目显式授权。例如 `{"cells-east":{"project-a":["kanban-work:read"]}}`。没有匹配授权时，宿主不会读取贡献文件。通道保留冻结任务、项目映射、操作身份、授权和回执。

## Cells 服务端

现代协议声明 `resources` 和 `io.modelcontextprotocol/skills`，提供 `skills/list`、`skills/get` 和 `resources/read`。每个请求都核对作用域和来源节点，读取还核对项目 revision、挂载授权和文件路径。静态文件读取校验原始字节的长度与摘要。服务端仅对已经授权的动态入口读取当前字节，限制为 16 MiB。旧客户端可继续使用五个会话工具，可选的目录读取能力暂未声明。

列表分页保留完整条目，元数据和资源结果使用 `cacheScope: private` 与 `ttlMs: 0`。直接查询不依赖分页。未知或未授权的资源返回 `-32602`，内容校验或服务内部故障返回 `-32603`。项目通道的授权读模型另外提供对应模块版本，且保留私有作用域凭据。

## 宿主批准、读取与更新

宿主以来源节点和 Skill URI 识别条目，并把实际批准绑定到 Session、能力窗口、来源、模块版本和清单摘要。静态支持文件通过 `read_skill_resource` 按请求读取。宿主核对活跃的批准、清单内的精确 URI 和原始字节，再将文本交给模型。嵌套 `SKILL.md` 可作为清单中的支持文件读出，独立激活仍需自己的授权。MCP Skill 内容不会授予工具权限。

动态批准在读取前消费，同一批准只能尝试一次激活。成功时锁定本次内容，完整 frontmatter 必须与发现的元数据相符。读取或激活失败后可重新申请批准。恢复时重建会话窗口并重新批准，只有与原上下文摘要相符的内容可在同一上下文恢复，内容变更时需要新会话。NestOS 不以旧批准重新获取生成内容。

宿主部署的决策模块目录提供已发布版本。会话发现和下一轮准备只核对该会话已授权的模块。发现版本差异时，Skill 面板提示需要新会话，已采用的条目持久记录原版本、观测版本及 `restart-required`。新会话通过正式决策确认和批准采用新的发布版本，其已加载快照保留实际采用的版本和摘要。已有任务、授权和回执继续使用冻结记录。旧 Cells 没有模块版本投影时仍可提供静态加载，宿主无法为该来源报告明确的版本变更。

## 验证与客户端兼容

Cells 协议回归覆盖直接 URI、静态摘要错误、动态入口、无关作用域和项目绑定。NestOS 回归覆盖批准消耗、按需文件读取、嵌套入口、下一轮版本差异和恢复后的持久记录。

已安装的 Codex CLI 0.169.0、Claude Code 2.1.209 和 DSH 通过真实 Cells 兼容测试，覆盖会话工具及作用域切换。测试使用本地模型夹具。独立协议探针在真实 Cells 进程上验证标准 Skills 发现、直接查询和资源读取。上述 Harness 的原生 Skill 自动激活仍需独立验证，实际驱动可继续使用冻结的 `session_context` 阶段指导。 [官方客户端支持矩阵](https://modelcontextprotocol.io/extensions/client-matrix)

2026-11-27 在隔离环境用 Cells 0.4.8 候选源码（`156b1ef` 加工作区改动）复测。每轮新建一个项目和一个作用域，首读一个静态和一个动态 Skill。三次协议探针耗时 13、16、14 毫秒，每次 7 个逻辑调用、7 个 HTTP 请求。计时从协议发现开始，包含变更后的动态重读和越权拒绝。服务已启动，无外部模型调用。本次计数覆盖协议探针，完整浏览器页面性能仍需另测。 [真实协议和 Codex 验收驱动](../../tools/cells/src/plugin/harness/tests/real_channel.py)
