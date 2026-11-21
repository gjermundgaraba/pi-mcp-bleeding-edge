import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";

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
});
