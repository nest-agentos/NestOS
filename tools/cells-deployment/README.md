# Cells managed delivery plugin

This external Node module implements `RuntimeServiceControl` for one administrator-selected Firecracker service. NestOS core has no Cells names, Rust build commands or VM restart commands.

Install the runtime files (`index.mjs`, `artifact.mjs`, `guest.mjs`) into a versioned private directory outside the shared project, then register that immutable module in the administrator's `~/.config/nestos/service-modules.json` (0600), or the trusted `NESTOS_SERVICE_MODULES` environment variable. Each entry has an `id`, absolute `module` path and private `options`: `id`, `vm`, `root` (source checkout), `executable` (the guest executable at `/usr/local/lib/nestos/cells/cells`), `identity`, `stateDirectory`, and `server` (Firecracker CLI). Match these to the installed service; no discovery grants authority. Credentials and options are never sent to models.

The public descriptor supplies the task's build command, artifact format and store. Run `node tools/cells-deployment/cli.mjs build` from a clean, integrated source checkout. The build uses a separate `release/cells-build` Cargo target directory so compilation cannot overwrite the running shared executable. It freezes the Git commit, rejects source changes during compilation, and packages an immutable binary plus a hash manifest under `release/cells`.

Artifact verification persists the manifest digest outside the project. Replacement rechecks the same artifact, the actual running process executable hash inside the bound VM, the retained root and the expected service/version. A SQLite OS lock serializes switches. Pending or unknown requests keep their original identity. The verified binary is copied into the guest filesystem, replaced atomically, and picked up when the registered Firecracker workload unit restarts. No service package, credentials, persistent root or Session data are rewritten. Success requires the original VM binding to be ready and its actual process binary hash to match the verified artifact. Interrupted controllers reconcile saved requests without replaying the restart.

在宿主机的干净检出中，`pnpm cells:redeploy` 默认更新 `cells-x1` 和本机 Cells。可传 `cells-x1` 或 `local` 单独更新。逻辑目标 `cells-x1` 通过管理员配置绑定到实际 VM ID，例如 `cell-x1`。命令核对两个正在运行的目标，只构建一次，再把同一份制品分别安装到宿主和 VM 各自的 `/usr/local/lib/nestos/cells/cells`。每个目标独立核对磁盘与运行版本。两者均与制品摘要一致时，该目标返回 `unchanged`。

两个服务都显式读取各自的 `/usr/local/lib/nestos/cells/cells.toml`，权限为 0600。宿主使用 `nestos-cells-local.service` 并通过 `sudo -n` 更新二进制及重启。VM 的安装目录须允许现有 SSH 管理账号写入，并保存在持久根盘。首次迁移使用各目标当前配置作为安装源。仓库中的本机配置名为 `tools/cells.toml`，由 Git 忽略。常规重部署只更新二进制，配置由各目标单独管理。

每个目标在安装目录保留替换前的 `previous-<操作ID>`。重启会结束当前服务进程，持久会话可重新打开，在途原生操作的恢复取决于 harness 和已有持久回执。输出包含操作 ID 和各目标的状态。若重启后的运行版本暂时无法核实，执行 `node tools/cells-deployment/cli.mjs redeploy-status all <操作ID>` 继续查询，避免重复重启。

Project `_nestos/etc/deployment.json` schema 2 selects the registered service for each management task with `bindings: { "<item-id>": "<service-id>" }` and an optional `defaultServiceId`. Project data selects existing authority only. Existing schema 1 remains compatible. Selection is frozen into each build result; changing the target requires a new build.

Enable `host_log = true` in the installed Cells service definition to mirror startup and runtime output to a private rotating archive on the Firecracker host. Operators and authorized collectors can read the archive when Cells or its VM is offline. See [Firecracker service logging](../fc-server/doc/services.md#停止销毁与日志).
