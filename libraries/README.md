# 独立库源码

本目录的十五个库各自在 `nest-agentos` 组织下维护独立 Git 仓库，通过 submodule 固定提交，统一参与主仓库的 pnpm workspace。业务包位于 `ui/`、`backend/`、`shared/`，应用宿主位于 `apps/`。

`kanban` 与 `mail` 已拆分为独立子模块。GitHub 上传与 npm 发布分别进行；源码、构建、类型声明及 tarball 可独立验证，不将上传仓库视为 npm 已发布。`tools/temporary-process` 保留在 NestOS 主仓库，作为通用进程管理工具。

```bash
git submodule update --init --recursive -- libraries
pnpm install --frozen-lockfile
pnpm workspace:check --installed
pnpm --filter @nestos/vfs-core test
```

开发通过各库的公开 exports 消费源码；发布使用 publishConfig 的 dist 入口。主仓库对库间依赖统一应用 workspace 覆盖，各库独立开发和 npm 发布能力继续保留。

更新库时先在相应仓库提交改动，再在主仓库记录新的 submodule 指针。其他 checkout 需要从独立仓库取得这些提交，因此新增提交应先推送到对应远端。

可选 npm 构建使用 `pnpm build:registry`，在独立目录安装发布版本；不会切换日常开发的依赖链接。详细配置、锁文件与发布流程见 [独立库接入](../doc/design/npm-library-consumption.md)。
