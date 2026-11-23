# AGENTS

This repository is a pi extension that replaces pi's built-in MCP support with a client on the official MCP TypeScript SDK v2 (`@modelcontextprotocol/client`). You own its design.

## Layout

- `index.ts` registers the extension: `createMcpExtension(options)`, and the default export pi loads.
- `client.ts` is the `/client` entry for hosts outside pi's session: `ServerConnection` and result conversion. It must not import pi-coding-agent or pi-tui; `vp pack` builds it to `dist/`, which the published package exports.
- `config/` reads and edits `mcp.json`. pi-mcp's `validateMcpServerConfig` checks the shared `mcpServers` fields, as pi does; zod checks this extension's own (`exposure`, `toolExposure`, `protocol`, `auth`).
- `connection/` owns one server's SDK client: connecting with era negotiation and the verdict cache, readiness (`start`, `settled`, `reconnect`), paged resource listing, error classification.
- `oauth/` holds the per-server credential files, client identity choice, loopback callback, sign-in through the SDK's `auth()`, and the refresh-only auth of connections.
- `tools/` turns MCP tools, results, and resources into pi tools and renderers. Naming, output truncation, and input-schema normalization come from pi-mcp, so they match pi exactly.
- `session/registry.ts` owns a session's servers: slots, connections, the tool catalog, and the enable, exposure, and reconnect actions. `session/controller.ts` holds the pi hooks: startup, waiting for servers, the `mcp_servers` prompt section, sign-ins.
- `manager/` is the `/mcp` command and its TUI.

## Conventions

- Behavior follows pi's built-in MCP extension unless the 2026-07-28 specification calls for something else; `docs/configuration.md` lists the differences. Keep it current.
- `@earendil-works/pi-mcp` is pinned to the version of `@earendil-works/pi-coding-agent`; bump them together. Use it for what must match pi, not for the client.
- Parse data that crosses a trust boundary (config files, stored files, configured documents) with zod. Inside the extension plain `typeof` checks and records are fine. `tools/json.ts` is the one place an MCP value is typed as the JSON it was parsed from.
- Write this extension's data files with `writePrivateJsonFile` (`json-file.ts`); never rewrite the user's `mcp.json` atomically, which would replace a symlink.
- JSDoc goes on exported declarations; comments elsewhere say why code is unusual, or link upstream.

## Commands

- `vp install` installs dependencies.
- `vp check` formats, lints, and type-checks; `vp check --fix` applies fixes. Review what `vp lint --fix-suggestions` changes before keeping it: it has rewritten behavior here before.
- `vp pack` builds the `/client` entry. Publishing happens on a `v*` tag (`.github/workflows/npm.yml`), after bumping `version`.
- `vp test` runs the `unit` and `integration` projects; `vp test --project unit` for one.

## Tests

Unit tests sit under `tests/` mirroring the source. Integration tests (`*.integration.test.ts`) run real servers from `tests/fixtures/`: the v2 SDK server over stdio and HTTP for both eras, v1 SDK servers for 2025-only behavior and resource paging, a fake OAuth authorization server, and real pi `AgentSession`s with the faux provider. Registry tests give a `ServerRegistry` the extension API of a probe extension in a real session.

## References

- pi: `~/.cache/checkouts/github.com/earendil-works/pi` at the tag matching `@earendil-works/pi-coding-agent` in `package.json`; the built-in MCP extension is `packages/coding-agent/src/extensions/mcp/`, and its documentation `packages/coding-agent/docs/mcp.md` and `docs/extensions.md`.
- MCP SDK: `~/.cache/checkouts/github.com/modelcontextprotocol/typescript-sdk` at the tag of the installed `@modelcontextprotocol/client`; start with `docs/protocol-versions.md` and `docs/clients/`.
