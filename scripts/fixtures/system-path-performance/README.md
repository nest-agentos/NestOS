# 授权路径点击的 HTTPS 验收

该驱动在同一个 `withTemporaryScope` 中运行真实 Cells、使用客户端证书认证的 HTTPS 宿主和 Chrome。每个样本创建独立存储、证书及新浏览器上下文；工作区含一个系统本地项目、一个 Cells 远程项目、一条会话消息和一个 40 行文件。消息包含该文件的绝对路径及 `:26`，以及指向同一路径的同源 HTTPS 链接。先打开会话、等待消息链接与输入框，再从点击开始计时，直到目标编辑器可编辑且活动行包含第 26 行标记；额外等待 250 ms，期间继续计数。冻结计时后还重新打开会话，点击同源 HTTPS 链接并核验同一行，不将这次功能检查混入计时。三次均独立建库；服务器与操作系统缓存热，浏览器上下文新建，会话已打开。后台是普通夹具服务，其他宿主负载由执行方另行记录。

浏览器侧统计操作期间全部 HTTP 请求；应用批次内每个逻辑调用分别计数，未知格式和未结束的 API 请求失败。宿主审计单独统计 Cells 协议请求。LocalFS 和 SQLite sidecar 在宿主端口层统计计时区间内发起的调用、文件字节及已识别的返回条目（下界），**不是物理磁盘扫描量**；Cells 内部存储读写与扫描没有插桩，因此这些结果不能声称覆盖全部存储成本。驱动记录根仓库和三个相关子仓库的 HEAD/工作树摘要、UI 和 Cells 二进制摘要、Node/浏览器版本、数据集、缓存状态及错误。驱动在清理确认之后才写正式结果，失败样本也保存为独立文件；不得把本检查当作全页冷启动或完整存储性能验收。

以下在任务原工作树执行，工具链、冻结依赖及浏览器由宿主准备。`PERF_UI` 必须是工作树内部的新目录；不要复用其他版本的静态产物。下面的 UI 构建不会删除旧目录，目录存在时应先改用新的路径，不能混合版本。所有输出、临时 Chrome 文件和作用域登记保留在该工作树的 retained-environment。

```bash
set -euo pipefail
R="$PWD/_nestos/kanban/retained-environment/rust"
export CARGO_HOME="$R/cargo"
export PATH="$R/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PWD/_nestos/kanban/retained-environment/toolchain/bin:$PATH"
export PERF_ENV="$PWD/_nestos/kanban/retained-environment"
export CARGO_TARGET_DIR="$PERF_ENV/cells-target"
export XDG_STATE_HOME="$PERF_ENV/state"
export PERF_UI="$PERF_ENV/system-path-ui-first"
: "${KANBAN_BROWSER:?Set to the browser executable used for the measurement}"
: "${PERF_PLAYWRIGHT:?Set to the Playwright entry point}"
export KANBAN_BROWSER PERF_PLAYWRIGHT
test ! -e "$PERF_UI"
cargo build --locked --offline --manifest-path tools/cells/Cargo.toml --bin cells
pnpm --filter @nestos/http-app exec vite build --outDir "$PERF_UI"
node scripts/verify-system-path-performance.mjs baseline
```

`baseline` 只在三个样本均满足严格 `< 5 秒`、逻辑 API `< 30`、计数完整、无浏览器或 Cells 失败且作用域清理确认后，以 `wx` 创建 `system-path-baseline.json`；文件已存在时拒绝运行，不自动更新。此基线是**新功能首次可用版本**的冻结基线：旧版没有可点击的系统路径，不能把它说成改动前的同操作基线。若首次样本未达标，保留 `system-path-failed-*.json` 和作用域记录，修复后再创建基线，不得放宽门槛。

后续候选版本在新的空 UI 输出目录重新构建，并沿用相同夹具脚本、数据规模、机器和负载：

```bash
export PERF_UI="$PERF_ENV/system-path-ui-candidate"
test ! -e "$PERF_UI"
cargo build --locked --offline --manifest-path tools/cells/Cargo.toml --bin cells
pnpm --filter @nestos/http-app exec vite build --outDir "$PERF_UI"
node scripts/verify-system-path-performance.mjs current
```

`current` 必须读取已冻结的基线，夹具文件摘要不同时拒绝比较；逐次样本执行既有 `assessPerformance`，不得增加逻辑调用，耗时不得超过基线的 `1.2 倍 + 50 ms`，绝对门槛仍严格生效。成功和失败候选分别写入新的 `system-path-current-*.json` / `system-path-failed-*.json`，不会覆盖基线。源文件、UI 或二进制在测量期间变化时拒绝结果。若临时作用域清理为 unknown，保留登记和输出，按登记身份交由宿主恢复；不能将其他作用域的清理确认当成它的回执。
