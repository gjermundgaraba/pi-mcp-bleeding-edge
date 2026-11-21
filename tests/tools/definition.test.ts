import { describe, expect, it } from "vite-plus/test";

import {
  convertResult,
  normalizeInputSchema,
  resultSchema,
} from "../../tools/definition.ts";

describe("resultSchema", () => {
  it("places the tool's output schema at structuredContent and keeps its local references working", () => {
    const schema = resultSchema({
      type: "object",
      properties: {
        item: { $ref: "#/$defs/Item" },
        enum: { const: { $ref: "#/not-a-ref" } },
      },
      $defs: { Item: { type: "string" } },
    });

    expect(schema).toMatchObject({
      properties: {
        structuredContent: {
          properties: {
            item: { $ref: "#/properties/structuredContent/$defs/Item" },
            enum: { const: { $ref: "#/not-a-ref" } },
          },
        },
      },
    });
  });
});

describe("normalizeInputSchema", () => {
  it("adds properties to object schemas without them", () => {
    expect(normalizeInputSchema({ type: "object" })).toStrictEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("convertResult", () => {
  it("gives scripts the whole result without _meta and the model an error text when an error has none", async () => {
    const converted = await convertResult("docs", "search", {
      content: [],
      structuredContent: [1, 2],
      isError: true,
      _meta: { trace: "x" },
    });

    expect(converted.isError).toBe(true);
    expect(converted.structuredContent).toStrictEqual({
      content: [],
      structuredContent: [1, 2],
      isError: true,
    });
    expect(converted.content).toStrictEqual([
      { type: "text", text: "[\n  1,\n  2\n]" },
    ]);
  });

  it("names the tool when an error result has no text", async () => {
    const converted = await convertResult("docs", "search", {
      content: [],
      isError: true,
    });

    expect(converted.content).toStrictEqual([
      { type: "text", text: "MCP tool docs/search returned an error" },
    ]);
  });
});
