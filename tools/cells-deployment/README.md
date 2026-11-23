# Cells managed delivery plugin

This external Node module implements `RuntimeServiceControl` for one administrator-selected Firecracker service. NestOS core has no Cells names, Rust build commands or VM restart commands.

Install the runtime files (`index.mjs`, `artifact.mjs`, `guest.mjs`) into a versioned private directory outside the shared project, then register that immutable module in the administrator's `~/.config/nestos/service-modules.json` (0600), or the trusted `NESTOS_SERVICE_MODULES` environment variable. Each entry has an `id`, absolute `module` path and private `options`: `id`, `vm`, `root` (source checkout), `executable` (the existing shared service executable), `identity`, `stateDirectory`, and `server` (Firecracker CLI). Match these to the installed service; no discovery grants authority. Credentials and options are never sent to models.

The public descriptor supplies the task's build command, artifact format and store. Run `node tools/cells-deployment/cli.mjs build` from a clean, integrated source checkout. The build uses a separate `release/cells-build` Cargo target directory so compilation cannot overwrite the running shared executable. It freezes the Git commit, rejects source changes during compilation, and packages an immutable binary plus a hash manifest under `release/cells`.

Artifact verification persists the manifest digest outside the project. Replacement rechecks the same artifact, the actual running process executable hash inside the bound VM, the retained root and the expected service/version. A SQLite OS lock serializes switches; pending/unknown requests cannot be resubmitted under another identity. The existing shared executable is replaced atomically and the registered Firecracker workload unit restarted. No service package, credentials, persistent root or Session data are rewritten. Success requires the original VM binding to be ready and its actual process binary hash to match the verified artifact. Interrupted controllers reconcile saved requests without replaying the restart.

在宿主机的干净检出中，`pnpm cells:redeploy` 默认更新 `cells-x1` 和本机 Cells。可传 `cells-x1` 或 `local` 只更新一个目标，也可显式传 `all`。命令先核对目标，再构建一次，并用同一制品依次核验、替换、重启和检查运行进程。两者共用二进制时只替换一次。目标必须处于运行状态。本机目标要求 `nestos-cells-local.service` 的运行进程使用当前检出的 `tools/svr`，并要求执行账号能读取该进程的可执行文件及通过 `sudo -n` 重启服务。

替换前的磁盘二进制保存在目标的私有状态目录。输出包含操作 ID 和各目标的状态。若重启后的运行版本暂时无法核实，执行 `node tools/cells-deployment/cli.mjs redeploy-status all <操作ID>` 可继续核对原操作，查询不会重复重启。需要单独核对时将 `all` 换成目标名称。

Project `_nestos/etc/deployment.json` schema 2 selects the registered service for each management task with `bindings: { "<item-id>": "<service-id>" }` and an optional `defaultServiceId`. Project data selects existing authority only. Existing schema 1 remains compatible. Selection is frozen into each build result; changing the target requires a new build.

Enable `host_log = true` in the installed Cells service definition to mirror startup and runtime output to a private rotating archive on the Firecracker host. Operators and authorized collectors can read the archive when Cells or its VM is offline. See [Firecracker service logging](../fc-server/doc/services.md#停止销毁与日志).
