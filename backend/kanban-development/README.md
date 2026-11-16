# @nestos/kanban-development

NestOS 的软件开发操作插件。提供构建、部署、交付验收、合并分析、合并和清理；其他 Kanban 插件不需要实现这些操作。

`createItemOperations(options)` 接收已授权的 Session 调用、Git/部署证据、产物校验、操作作用域及日志端口。`createSoftwareDevelopmentPlugin(context => provider)` 把该 provider 注册到 Kanban 的 `operationPlugins`。插件 ID 为 `software-development`，持久协议版本为 `1`。

Kanban 负责插件路由、原操作的插件版本绑定、通用步骤推进与回执；本包负责软件开发规则。宿主负责连接、授权和端口装配。旧的 `review-operation:`、`review-operations:` 和 `automatic-delivery:` 记录继续按原键读取，不迁移运行中身份。

插件入口与其他插件的接入方法见 [操作插件](../../doc/design/kanban-operation-plugins.md)。

```sh
pnpm --filter @nestos/kanban-development typecheck
pnpm --filter @nestos/kanban-development test
```

软件报告移交保持普通文件校验，拒绝符号链接和特殊文件，并返回具体相对路径及文件类型，不跟随链接或记录正文。移交失败由宿主登记为独立问题；只有源码核验和实际报告移交均成功，宿主才关联关闭自己登记的问题。问题修复不能由聊天文本替代；未知结果保留原身份，成功后再次失败使用新的代次，历史失败和关联回执保留。
