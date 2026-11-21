import { describe, expect, it } from "vite-plus/test";

import {
  limitContent,
  MCP_OUTPUT_MAX_BYTES,
  toModelContent,
} from "../../tools/content.ts";

describe("limitContent", () => {
  it("keeps content within the limit unchanged", async () => {
    const content = [{ type: "text" as const, text: "short" }];

    await expect(limitContent(content)).resolves.toStrictEqual({ content });
  });

  it("cuts the middle of long text, saves the whole text, and keeps images", async () => {
    const saved: string[] = [];
    const text = `${"a".repeat(MCP_OUTPUT_MAX_BYTES)}${"é".repeat(100)}${"z".repeat(MCP_OUTPUT_MAX_BYTES)}`;

    const image = {
      type: "image" as const,
      data: "AAAA",
      mimeType: "image/png",
    };

    const limited = await limitContent(
      [{ type: "text", text }, image],
      async (data) => {
        saved.push(String(data));

        return "/tmp/full.txt";
      }
    );

    const [first, second] = limited.content;

    expect(saved).toStrictEqual([text]);
    expect(limited.fullOutputPath).toBe("/tmp/full.txt");
    expect(second).toStrictEqual(image);
    expect(first?.type === "text" && first.text).toMatch(
      /^Warning: truncated output/u
    );
    expect(first?.type === "text" && first.text).toMatch(
      /a…\d+ chars truncated…z/u
    );
    expect(first?.type === "text" && first.text).toContain(
      "[Full output: /tmp/full.txt"
    );
  });
});

describe("toModelContent", () => {
  it("names resource links and the tool that reads them", async () => {
    const content = await toModelContent(
      "docs",
      [
        {
          type: "resource_link",
          uri: "docs://a",
          name: "a",
          mimeType: "text/plain",
          size: 2048,
        },
      ],
      { readableResources: true }
    );

    expect(content).toStrictEqual([
      {
        type: "text",
        text: '[Resource docs://a "a" (text/plain, 2.0KB). Read it with read_mcp_resource (server "docs")]',
      },
    ]);
  });

  it("shows text blobs as text and saves other binary resources", async () => {
    const content = await toModelContent(
      "docs",
      [
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
      ],
      { save: async (_data, extension) => `/tmp/saved${extension}` }
    );

    expect(content).toStrictEqual([
      { type: "text", text: "{}" },
      {
        type: "text",
        text: "[Binary resource docs://b.pdf (application/pdf, 3B) saved to /tmp/saved.pdf]",
      },
    ]);
  });
});
