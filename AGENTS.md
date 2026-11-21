# AGENTS

This repository is a pi extension that replaces pi's built-in MCP support with a client on the official MCP TypeScript SDK v2 (`@modelcontextprotocol/client`). You own its design.

## Layout

- `index.ts` registers the extension: `createMcpExtension(options)`, and the default export pi loads.
- `config/` reads, validates (zod), and edits `mcp.json` entries.
- `connection/` owns one server's SDK client: transports, protocol era negotiation and the verdict cache, error classification.
- `oauth/` holds the credential store, client identity choice, loopback callback, sign-in through the SDK's `auth()`, and the refresh-only auth of connections.
- `tools/` turns MCP tools, results, and resources into pi tools and renderers.
- `session/` coordinates one pi session: server slots, the tool catalog, codemode and tool_search activation, the `mcp_servers` prompt section. `session/runtime.ts` is loaded lazily, so sessions without servers never load the SDK.
- `manager/` is the `/mcp` command and its TUI.

## Conventions

- Behavior follows pi's built-in MCP extension unless the 2026-07-28 specification calls for something else; `docs/configuration.md` lists the differences. Keep it current.
- Parse external data (config files, stored state, server payloads) with zod at the boundary; do not add type assertions or `typeof` checks.
- JSDoc goes on exported declarations; comments elsewhere only for links to upstream issues or specs.

## Commands

- `vp install` installs dependencies.
- `vp check` formats, lints, and type-checks; `vp check --fix` applies fixes. Review what `vp lint --fix-suggestions` changes before keeping it: it has rewritten behavior here before.
- `vp test` runs the `unit` and `integration` projects; `vp test --project unit` for one.

## Tests

Unit tests sit under `tests/` mirroring the source. Integration tests (`*.integration.test.ts`) run real servers from `tests/fixtures/`: the v2 SDK server over stdio and HTTP for both eras, v1 SDK servers for 2025-only behavior, a fake OAuth authorization server, and a real pi `AgentSession` with the faux provider.

## References

- pi: `~/.cache/checkouts/github.com/earendil-works/pi` at the tag matching `@earendil-works/pi-coding-agent` in `package.json`; the built-in MCP extension is `packages/coding-agent/src/extensions/mcp/`, and its documentation `packages/coding-agent/docs/mcp.md` and `docs/extensions.md`.
- MCP SDK: `~/.cache/checkouts/github.com/modelcontextprotocol/typescript-sdk` at the tag of the installed `@modelcontextprotocol/client`; start with `docs/protocol-versions.md` and `docs/clients/`.
