# Temporary process scopes

A generic Linux/Node tool for bounded validation commands and temporary preview servers. No Kanban, Session, Vite or port-specific code is embedded. Requires `/usr/bin/bwrap` with unprivileged user/PID namespace support. Missing containment fails the command; there is no uncontained fallback.

```bash
node tools/temporary-process/node/cli.mjs run --scope task-validation --timeout-ms 600000 -- bash -c 'node preview.mjs & node browser-check.mjs'
node tools/temporary-process/node/cli.mjs recover
```

The validation driver determines when the scope ends; every preview and watcher started by that command stays within its PID namespace, including descendants that call `setsid`. The guardian first terminates the worker group, escalates if needed, and confirms no live owned group members before returning its receipt. Killing the worker also ends the PID namespace and its descendants. A declared production service or resumable Agent Session must never be started through this temporary execution tool.

Node callers may import `withTemporaryScope` and start several resources in a `try/finally` scope. Await each `scope.start()` and the validation callback. `scope.close()` is idempotent and waits for admitted starts and cleanup. `AbortSignal`, thrown callbacks and deadlines use the same cleanup path. The external NestOS tool `temporary.run` wraps one command in this scope; Tool disposal closes its active scopes. The existing tool-package mechanism preinstalls the package with per-user execution disabled; enable it explicitly when appropriate; registration does not grant undeclared process privileges.

The owner, guardian and group-leader worker have separate lifetimes. IPC disconnects drive cleanup after owner/guardian crashes, without relying on the crashed process's `finally`. The worker is registered durably **before** the actual command is allowed to start. Each record includes an opaque scope ID, canonical working directory, boot identity, PID start time and private ownership marker. Tool operation IDs have immutable admission receipts with a request digest and the original resource ID; retries reconcile that resource and never spawn the command again. Unknown admission or cleanup requires diagnosis or a new explicitly authorized operation. Commands, arguments and environment values are not stored in the receipt or diagnostic events. Output is capped at 4 MiB (overflow terminates the scope) and kept in a private log; Tool/CLI results return its last 64 KiB with truncation metadata.

Receipts live under `$XDG_STATE_HOME/nestos/temporary-process` (default `~/.local/state/nestos/temporary-process`), directory mode 0700 and files 0600. A fresh host runs recovery before serving. Recovery preserves live owners with valid deadlines, closes expired or orphaned scopes, and checks boot/start/group/ownership identity before signaling. Reused or unproven identities produce `unknown` and remain available for diagnosis; the tool never kills by a port or command-name match. Old-boot processes are already gone and cannot authorize signals to a newly reused PID. The repository `pnpm httpd` launcher and an installed package's factory both run this recovery.

Raw processes launched outside this tool are not silently adopted. Native Agent integrations must use an available managed entry point, a bounded foreground command, or report the missing capability. Existing frozen task prompts remain immutable; the default policy migration applies only to known default templates for new work.

Tests: `node --test tools/temporary-process/tests/lifecycle.test.mjs` (also in `pnpm test:tooling`). They start real listeners, include a descendant in a new session, inject `SIGKILL` and simultaneous supervisor failures, recover from a fresh process, and verify unrelated identities are left alive.
