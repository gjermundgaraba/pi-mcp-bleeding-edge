# pi-mcp-bleeding-edge

Replaces pi's built-in MCP support with a client on the official MCP TypeScript SDK v2, speaking protocol 2026-07-28 and falling back to 2025-era servers.

> [!CAUTION] **Experimental:** Not published to npm. Breaking changes may happen without notice.

## Install

Run `vp install` in this directory, then add its path to `packages` in `~/.pi/agent/settings.json`.

## Usage

- Servers in `~/.pi/agent/mcp.json` and a trusted project's `.pi/mcp.json` connect when a session starts, as with pi's built-in support.
- Use `/mcp` to inspect servers, see the protocol each negotiated, sign in, reconnect, and change exposure.

## Configuration

See [configuration](docs/configuration.md) for the `protocol` setting, where credentials and logs live, and how this differs from the built-in support.
