import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { toModelContent } from "../../tools/content.ts";

describe("toModelContent", () => {
  it("names resource links, and the tool that reads them when it can", async () => {
    const link = {
      type: "resource_link" as const,
      uri: "docs://a",
      name: "a",
      mimeType: "text/plain",
      size: 2048,
    };

    await expect(toModelContent("docs", [link], true)).resolves.toStrictEqual([
      {
        type: "text",
        text: '[Resource docs://a "a" (text/plain, 2.0KB). Read it with read_mcp_resource (server "docs")]',
      },
    ]);
    await expect(toModelContent("docs", [link])).resolves.toStrictEqual([
      { type: "text", text: '[Resource docs://a "a" (text/plain, 2.0KB)]' },
    ]);
  });

  it("shows text blobs as text and saves other binary resources with their extension", async () => {
    const [json, pdf] = await toModelContent("docs", [
      {
        type: "resource",
        resource: {
          uri: "docs://a.json",
          mimeType: "application/json",
          blob: Buffer.from("{}").toString("base64"),
        },
      },
      {
        type: "resource",
        resource: {
          uri: "docs://b.pdf",
          mimeType: "application/pdf",
          blob: "AAAA",
        },
      },
    ]);

    const saved =
      /saved to (?<file>\S+\.pdf)\]$/u.exec(
        pdf?.type === "text" ? pdf.text : ""
      )?.groups?.["file"] ?? "";

    expect(json).toStrictEqual({ type: "text", text: "{}" });
    expect(pdf?.type === "text" ? pdf.text : "").toMatch(
      /^\[Binary resource docs:\/\/b\.pdf \(application\/pdf, 3B\) saved to /u
    );
    expect(readFileSync(saved)).toStrictEqual(Buffer.from("AAAA", "base64"));
  });
});
