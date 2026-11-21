# Configuration

The extension registers `/mcp`, which makes pi skip its built-in MCP support in sessions. It reads the same files with the same `mcpServers` entries: `~/.pi/agent/mcp.json`, and `.pi/mcp.json` once the project is trusted. Exposure, `toolExposure`, `description`, `timeout`, `enabled`, OAuth settings, `auth.provider`, project overrides, `pi.registerMcpServer()` registrations, the resource tools, and the `mcp_servers` prompt section work as described in pi's `docs/mcp.md`.

## Protocol

Every server entry accepts `protocol`:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Probe with `server/discover`; speak 2026-07-28 when the server offers it, otherwise the 2025 `initialize` handshake. |
| `modern` | 2026-07-28 only. Servers that do not offer it fail to connect. |
| `legacy` | The 2025 `initialize` handshake, without a probe. |

`auto` remembers each server's answer for a day in `<agent dir>/data/mcp-bleeding-edge/protocol.json`, so later connections skip the probe. A remembered 2026-07-28 answer that no longer holds is probed again at once. On stdio the SDK probes on a short-lived second process; a 2025 server that ignores the probe costs up to ten seconds once a day. Set `legacy` for such servers.

`/mcp`, and its plain-text status outside the TUI, show the negotiated protocol version of each connected server.

On 2026-07-28 connections, tool list changes arrive on a `subscriptions/listen` stream, which the extension reopens when it drops and then lists the tools again. Requests carry the per-request `_meta` envelope, list results honor the server's cache hints, and servers that need the session's root get it inside the request that asks (multi round-trip requests).

## Sign-in

`/mcp` → Sign in, or `/mcp login <server>`, runs the OAuth sign-in through the SDK: protected resource and authorization server discovery, pi's Client ID Metadata Document or dynamic client registration, PKCE, RFC 9207 `iss` validation, and a loopback callback or a pasted redirect URL. A server that asks for more scope (`insufficient_scope`) asks for a new sign-in.

Credentials are stored in `<agent dir>/data/mcp-bleeding-edge/auth.json`, not in the built-in support's `mcp-auth.json`, so each server needs one new sign-in. Refreshes are shared between pi processes through a lock file.

## Logs

`<agent dir>/data/mcp-bleeding-edge/mcp.log` receives the log messages of 2025-era servers and what stdio servers write to stderr, which is where 2026-07-28 moves server logging. The file moves to `mcp.log.1` past 5 MB.

## Differences from the built-in support

- `pi mcp add`, `list`, `login`, and `logout` are shell commands of pi's built-in support: they edit the same `mcp.json`, but `pi mcp login` stores credentials this extension does not read. Sign in with `/mcp` instead.
- Stopping a stdio server closes its stdin, then sends SIGTERM and SIGKILL to the server process, as the SDK does, rather than to its whole process group.
- Elicitation and sampling requests are not offered to servers, as in the built-in support.
