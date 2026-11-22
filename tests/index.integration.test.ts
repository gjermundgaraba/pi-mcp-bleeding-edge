import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { startSession } from "./fixtures/agent-session.ts";
import type { SessionUnderTest } from "./fixtures/agent-session.ts";
import { stdioFixture, temporaryDirectory } from "./fixtures/connection.ts";

const cleanups: Array<() => Promise<void> | void> = [];

const cleanUp = async (): Promise<void> => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
};

const start = async (servers: JsonObject): Promise<SessionUnderTest> => {
  const { dir, dispose } = temporaryDirectory();

  cleanups.push(dispose);

  const subject = await startSession(dir, servers);

  cleanups.push(subject.dispose);

  return subject;
};

const listing = z.object({ resources: z.array(z.object({ uri: z.string() })) });

const uris = (text: string): string[] =>
  listing.parse(JSON.parse(text)).resources.map((resource) => resource.uri);

const toolResultTexts = (subject: SessionUnderTest): string[] =>
  subject.session.messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        ]
      : []
  );

describe("the extension in a pi session", () => {
  afterEach(cleanUp);

  it("declares direct tools, reaches codemode tools from scripts, and lists codemode servers", async () => {
    const subject = await start({
      direct: { ...stdioFixture("stdio-modern.ts"), exposure: "direct" },
      scripted: {
        ...stdioFixture("stdio-legacy.ts"),
        description: "Legacy fixture",
      },
    });

    subject.respond([
      fauxAssistantMessage(
        fauxToolCall("mcp__direct__echo", { text: "direct hi" })
      ),
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: "const result = await tools.mcp__scripted__echo({ text: 'from script' }); return result.content[0].text;",
        })
      ),
      fauxAssistantMessage("done"),
    ]);

    await subject.session.prompt("go");

    const texts = toolResultTexts(subject);

    expect(texts[0]).toBe("direct hi");
    expect(texts[1]).toContain("from script");
    expect(subject.session.getActiveToolNames()).toContain("codemode");
    expect(subject.session.getActiveToolNames()).toContain("mcp__direct__echo");

    const scripted = subject.session
      .getAllTools()
      .find((tool) => tool.name === "mcp__scripted__echo");

    expect(scripted?.exposure).toBe("deferred");
    expect(scripted?.namespace?.name).toBe("mcp__scripted");
    expect(
      JSON.stringify([subject.session.systemPrompt, subject.session.messages])
    ).toContain("- mcp__scripted (codemode): Legacy fixture");
  });

  it("reports a tool the server marks as an error as an error result", async () => {
    const subject = await start({
      direct: { ...stdioFixture("stdio-modern.ts"), exposure: "direct" },
    });

    subject.respond([
      fauxAssistantMessage(fauxToolCall("mcp__direct__fail", {})),
      fauxAssistantMessage("done"),
    ]);

    await subject.session.prompt("go");

    const result = subject.session.messages.find(
      (message) => message.role === "toolResult"
    );

    expect(result?.role === "toolResult" && result.isError).toBe(true);
    expect(toolResultTexts(subject)[0]).toBe("it failed");
  });

  it("lists resources a page at a time, continues with the cursor, and walks every page without a server", async () => {
    const subject = await start({
      paged: { ...stdioFixture("stdio-paging.ts"), exposure: "direct" },
    });

    subject.respond([
      fauxAssistantMessage(
        fauxToolCall("list_mcp_resources", { server: "paged" })
      ),
      fauxAssistantMessage(
        fauxToolCall("list_mcp_resources", { server: "paged", cursor: "2" })
      ),
      fauxAssistantMessage(fauxToolCall("list_mcp_resources", {})),
      fauxAssistantMessage(
        fauxToolCall("read_mcp_resource", { server: "paged", uri: "paged://c" })
      ),
      fauxAssistantMessage("done"),
    ]);

    await subject.session.prompt("go");

    const [first = "", second = "", all = "", read] = toolResultTexts(subject);

    expect(uris(first)).toStrictEqual(["paged://a", "paged://b"]);
    expect(JSON.parse(first)).toMatchObject({
      server: "paged",
      nextCursor: "2",
    });
    expect(uris(second)).toStrictEqual(["paged://c", "paged://d"]);
    expect(uris(all)).toStrictEqual([
      "paged://a",
      "paged://b",
      "paged://c",
      "paged://d",
      "paged://e",
    ]);
    expect(JSON.parse(all)).not.toHaveProperty("nextCursor");
    expect(read).toBe("content of paged://c");
  });
});
