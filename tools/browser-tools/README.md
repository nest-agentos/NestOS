# Managed browser for a Harness session

Run `server.mjs` as a Linux host service outside the Cells project namespace. Install its dependencies with `npm ci --ignore-scripts`. Chrome and Linux bubblewrap must be available on the service host. Keep the service source, its config, the bearer token and the user's mTLS files outside the project exports.

The service accepts a private JSON configuration with `port`, `tokenFile`, `target`, `readySelector`, `chrome`, `cert` and `key`. It listens only on loopback. The configured target uses the local NestOS HTTPS origin on port 2000. Supply the application CA via `NODE_EXTRA_CA_CERTS`. Use the current user's registered certificate. Do not substitute a shared administrator identity.

Register the HTTP MCP server at `http://127.0.0.1:<port>/mcp` through Cells `agents/mcp_save` using the owner credential. Set `tools` to `["browser_operate"]` and `sessionId` to the intended native Harness session. The broker bearer credential is separate from the certificate. Use a new, dedicated token for each registration. The selected Harness receives the registration when its native context refreshes.

Each tool call starts an isolated browser, opens the configured route, runs up to eight click or fill steps, and returns an accessibility snapshot. An empty call reads the page. The optional `path` accepts `/` for the workbench home or a NestOS hash route starting with `/#/`. Click and fill take an exact accessible name and role. Pass related actions in one call, since browser state is released after each call. The tool does not retry actions that may have completed before an error. Use a read call to verify the outcome before submitting another action.

For a site approval, register both `browser_read` and `browser_operate` under the same origin-bound registration. Include `site: { origin, readTool: "browser_read", writeTool: "browser_operate" }`. Use the configured site origin or its trusted public alias. `browser_read` does not accept steps and limits network requests to the NestOS read protocol.

The four choices are decline, allow once, remember read access, and remember read and write access. A read grant declines a pending write while allowing later reads. Remembered permissions apply to the exact owner, session, and registration. Revoke through `agents/mcp_revoke_site` using the server ID and current revision returned by `agents/mcp_list`. Updating the registration also invalidates its grant. Revocation applies to new requests. It cannot undo a browser operation already accepted.
