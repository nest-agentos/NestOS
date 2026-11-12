# @nestos/kanban-development

NestOS 的软件开发操作插件。提供构建、部署、交付验收、合并分析、合并和清理；其他 Kanban 插件不需要实现这些操作。

`createItemOperations(options)` 接收已授权的 Session 调用、Git/部署证据、产物校验、操作作用域及日志端口。`createSoftwareDevelopmentPlugin(context => provider)` 把该 provider 注册到 Kanban 的 `operationPlugins`。插件 ID 为 `software-development`，持久协议版本为 `1`。

Kanban 负责插件路由、原操作的插件版本绑定、通用步骤推进与回执；本包负责软件开发规则。宿主负责连接、授权和端口装配。旧的 `review-operation:`、`review-operations:` 和 `automatic-delivery:` 记录继续按原键读取，不迁移运行中身份。

插件入口与其他插件的接入方法见 [操作插件](../../doc/design/kanban-operation-plugins.md)。

```sh
pnpm --filter @nestos/kanban-development typecheck
pnpm --filter @nestos/kanban-development test
```
