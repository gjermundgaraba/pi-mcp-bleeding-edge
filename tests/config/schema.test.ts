import { describe, expect, it } from "vite-plus/test";

import { isServerOverride, parseServerConfig } from "../../config/schema.ts";

describe("parseServerConfig", () => {
  it("accepts stdio and HTTP servers and resolves exposure aliases", () => {
    expect(
      parseServerConfig("files", {
        command: "npx",
        args: ["-y", "server"],
        exposure: "codemode-deferred",
        toolExposure: { "get_*": "direct" },
      })
    ).toStrictEqual({
      value: {
        command: "npx",
        args: ["-y", "server"],
        exposure: "codemode",
        toolExposure: { "get_*": "direct" },
      },
    });
    expect(
      parseServerConfig("docs", {
        url: "https://example.com/mcp",
        protocol: "modern",
      }).value
    ).toStrictEqual({ url: "https://example.com/mcp", protocol: "modern" });
  });

  it("names the field and the server of an invalid entry", () => {
    expect(
      parseServerConfig("files", { command: "x", timeout: -1 }).error
    ).toBe('server "files": timeout must be a positive number of seconds');
    expect(
      parseServerConfig("files", { command: "x", protocol: "2025" }).error
    ).toBe('server "files": protocol: must be "auto", "modern", or "legacy"');
    expect(parseServerConfig("bad name", { command: "x" }).error).toContain(
      "invalid server name"
    );
  });

  it("rejects the legacy SSE transport and entries without a transport", () => {
    expect(
      parseServerConfig("old", { type: "sse", url: "https://x/sse" }).error
    ).toContain("legacy SSE transport is not supported");
    expect(parseServerConfig("none", { description: "x" }).error).toContain(
      'needs either "command"'
    );
  });

  it("requires https or a loopback host for a provider's credential", () => {
    expect(
      parseServerConfig("web", {
        url: "http://example.com/mcp",
        auth: { provider: "radius" },
      }).error
    ).toContain("auth requires an https URL");
    expect(
      parseServerConfig("local", {
        url: "http://localhost:8080/mcp",
        auth: { provider: "radius" },
      }).error
    ).toBeUndefined();
  });

  it("checks Client ID Metadata Document settings against pi's documents", () => {
    expect(
      parseServerConfig("a", {
        url: "https://x/mcp",
        oauth: { clientRegistration: "cimd", clientName: "Other" },
      }).error
    ).toContain("cannot be combined");
    expect(
      parseServerConfig("a", {
        url: "https://x/mcp",
        oauth: {
          clientRegistration: "cimd",
          callbackUrl: "http://127.0.0.1/oauth",
        },
      }).error
    ).toContain("with path /callback");
    expect(
      parseServerConfig("a", {
        url: "https://x/mcp",
        oauth: {
          callbackUrl: "http://127.0.0.1:9000/callback",
          callbackPort: 9001,
        },
      }).error
    ).toContain("name different ports");
  });
});

describe("isServerOverride", () => {
  it("is true only for entries without command, url, or type", () => {
    expect(isServerOverride({ enabled: false })).toBe(true);
    expect(isServerOverride({ command: "x" })).toBe(false);
    expect(isServerOverride({ type: "stdio" })).toBe(false);
    expect(isServerOverride("x")).toBe(false);
  });
});
