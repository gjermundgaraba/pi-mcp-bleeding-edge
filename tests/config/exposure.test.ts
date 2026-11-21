import { describe, expect, it } from "vite-plus/test";

import { configuredExposures, toolExposure } from "../../config/exposure.ts";

describe("toolExposure", () => {
  const settings = {
    exposure: "hidden" as const,
    toolExposure: {
      "get_*": "codemode" as const,
      get_secret: "hidden" as const,
      "*": "deferred" as const,
    },
  };

  it("prefers an exact name, then the first matching pattern, then the server's exposure", () => {
    expect(toolExposure(settings, "get_secret")).toBe("hidden");
    expect(toolExposure(settings, "get_issue")).toBe("codemode");
    expect(toolExposure(settings, "delete")).toBe("deferred");
    expect(toolExposure({}, "anything")).toBe("codemode");
  });

  it("treats pattern characters other than * literally", () => {
    expect(toolExposure({ toolExposure: { "a.b": "direct" } }, "axb")).toBe(
      "codemode"
    );
  });

  it("collects every configured exposure", () => {
    expect([...configuredExposures(settings)].toSorted()).toStrictEqual([
      "codemode",
      "deferred",
      "hidden",
    ]);
  });
});
