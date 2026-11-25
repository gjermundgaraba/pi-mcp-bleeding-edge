# pi-mcp-bleeding-edge

Replaces pi's built-in MCP support with a client on the official MCP TypeScript SDK v2, speaking protocol 2026-07-28 and falling back to 2025-era servers.

> [!CAUTION] **Experimental:** Breaking changes may happen without notice.

## Install

Run `pi install npm:@gjermundgaraba/pi-mcp-bleeding-edge`. To run a checkout instead, run `vp install` in it, then add its path to `packages` in `~/.pi/agent/settings.json`.

## Usage

- Servers in `~/.pi/agent/mcp.json` and a trusted project's `.pi/mcp.json` connect when a session starts, as with pi's built-in support.
- Use `/mcp` to inspect servers, see the protocol each negotiated, sign in, reconnect, and change exposure.

## Use outside pi

`@gjermundgaraba/pi-mcp-bleeding-edge/client` exports one server's connection (`ServerConnection`), with its tools, resources, and skills (the MCP Skills extension: `skills`, `onSkills`, and `readSkill`, which verifies each file against the server's entry), and the conversion of tool results to model content, for hosts that manage their own servers and credentials. It needs neither pi-coding-agent nor pi-tui.

## Configuration

See [configuration](docs/configuration.md) for the `protocol` setting, where credentials and logs live, and how this differs from the built-in support.
