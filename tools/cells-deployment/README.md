# Cells managed delivery plugin

This external Node module implements `RuntimeServiceControl` for one administrator-selected Firecracker service. NestOS core has no Cells names, Rust build commands or VM restart commands.

Install the runtime files (`index.mjs`, `artifact.mjs`, `guest.mjs`) into a versioned private directory outside the shared project, then register that immutable module in the administrator's `~/.config/nestos/service-modules.json` (0600), or the trusted `NESTOS_SERVICE_MODULES` environment variable. Each entry has an `id`, absolute `module` path and private `options`: `id`, `vm`, `root` (source checkout), `executable` (the guest executable at `/usr/local/lib/nestos/cells/cells`), `identity`, `stateDirectory`, and `server` (Firecracker CLI). Match these to the installed service; no discovery grants authority. Credentials and options are never sent to models.

The public descriptor supplies the task's build command, artifact format and store. Run `node tools/cells-deployment/cli.mjs build` from a clean, integrated source checkout. The build uses a separate `release/cells-build` Cargo target directory so compilation cannot overwrite the running shared executable. It freezes the Git commit, rejects source changes during compilation, and packages an immutable binary plus a hash manifest under `release/cells`.

Artifact verification persists the manifest digest outside the project. Replacement rechecks the same artifact, the actual running process executable hash inside the bound VM, the retained root and the expected service/version. A SQLite OS lock serializes switches. Pending or unknown requests keep their original identity. The verified binary is copied into the guest filesystem, replaced atomically, and picked up when the registered Firecracker workload unit restarts. A project-bound Kanban release also verifies and installs the configured options.configSource or the target’s existing configuration, using the paired install and restart receipt below. The service package, persistent root and Session data are retained. Success requires the original VM binding to be ready and its actual process binary hash to match the verified artifact. Interrupted controllers reconcile saved requests without replaying the restart.

在宿主机的检出中，`pnpm cells:redeploy` 默认同时发布宿主机和 `cells-x1` 的 Cells 二进制与配置。可传 `cells-x1` 或 `local` 单独更新，或加 `--config-only`（例如 `pnpm cells:redeploy local --config-only`）仅校验、备份并安装配置后重启而不重编二进制。构建源干净检查仅覆盖 `tools/cells` 及其子模块指针，不因主仓库其他目录的未提交改动拦截。逻辑目标 `cells-x1` 通过管理员配置绑定到实际 VM ID，例如 `cell-x1`。两个目标共用一次构建，配置分别读取：

- 宿主机默认读取 `tools/` 下由 Git 忽略的私有配置 `cells.toml`；该文件由宿主管理，不随仓库提供。可用 `NESTOS_CELLS_LOCAL_CONFIG` 指定绝对路径。
- VM 默认读取 `/etc/nestos/firecracker/service-sources/cells-x1/service.toml` 中目标为 `cells.toml` 的声明，兼容目标为 `config.toml` 的旧清单。可用管理员 `service-modules.json` 中的 `options.configSource` 或 `NESTOS_CELLS_X1_CONFIG` 指定该 VM 专用配置的绝对路径，环境变量优先。未指定配置源且默认清单不存在或不可读时，命令从 VM 的安装目录读取现有 `cells.toml`，校验后与二进制一起发布。预检日志以 `configurationSource: "vm-installed"` 标注这一分支；如需应用新的 VM 配置，请提供可读的服务清单或显式配置源。

源配置须为非符号链接的普通文件且仅属主可访问，例如权限 0600。命令会在切换任何目标前检查两个目标的绑定、读取配置并用新二进制校验 TOML。目标端复核实际安装文件的原配置摘要，校验后将二进制和配置分别安装到 `/usr/local/lib/nestos/cells/cells` 和 `/usr/local/lib/nestos/cells/cells.toml`。宿主机通过 `sudo -n` 操作 `nestos-cells-local.service`。VM 的安装目录须允许现有 SSH 管理账号写入，并保存在持久根盘。

每个目标保留 `previous-<操作ID>` 和私有的 `previous-<操作ID>.toml`。发布核对运行进程、二进制及落盘配置摘要；仅配置改变也会重启。已确认运行进程加载同一组版本且文件未变化时返回 `unchanged`。操作台账只保存摘要和关联信息。若重启后的运行版本暂时无法核实，执行 `node tools/cells-deployment/cli.mjs redeploy-status all <操作ID>` 查询同一操作。重启会结束当前服务进程，在途原生操作按既有持久回执恢复。配置与应用发布保留持久根盘及会话。

Project `_nestos/etc/deployment.json` schema 2 selects the registered service for each management task with `bindings: { "<item-id>": "<service-id>" }` and an optional `defaultServiceId`. Project data selects existing authority only. Existing schema 1 remains compatible. Selection is frozen into each build result; changing the target requires a new build.

Enable `host_log = true` in the installed Cells service definition to mirror startup and runtime output to a private rotating archive on the Firecracker host. Operators and authorized collectors can read the archive when Cells or its VM is offline. See [Firecracker service logging](../fc-server/doc/services.md#停止销毁与日志).
