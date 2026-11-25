import { McpServer } from "@modelcontextprotocol/server";
import type { RegisteredTool } from "@modelcontextprotocol/server";
import {
  SkillsExtension,
  skillEntry,
} from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";

/** Changes made at runtime, shared by the instances of one server process. */
export interface FixtureState {
  readonly addedTools: string[];
  readonly removedTools: string[];
  /** The files of the skill `greet`, by path under its folder. */
  readonly skillFiles: Record<string, string>;
}

const SKILL_ROOT = "skill://greet/";

export const fixtureState = (): FixtureState => ({
  addedTools: [],
  removedTools: [],
  skillFiles: {
    "SKILL.md":
      "---\nname: greet\ndescription: Greet people\n---\nGreet in the tone of refs/tone.md.\n",
    "refs/tone.md": "Warm.",
  },
});

/** Serves the skill `greet` from `state`, so its entry follows the files as they change. */
const greetSkill = (state: FixtureState): SkillsExtension => {
  const entry = async () => await skillEntry("greet", state.skillFiles);

  return new SkillsExtension({
    source: {
      list: async () => ({ skills: [await entry()] }),
      get: async (uri) => {
        const skill = await entry();

        return skill.uri === uri ? skill : undefined;
      },
      read: async (uri) => {
        const text = uri.startsWith(SKILL_ROOT)
          ? state.skillFiles[uri.slice(SKILL_ROOT.length)]
          : undefined;

        return text === undefined ? undefined : { text };
      },
    },
  });
};

/**
 * The test server on the v2 SDK, which serves 2026-07-28 and 2025-era clients: `echo`, `fail`,
 * `count` (with progress), `dash-name` and `dash_name` (whose pi names collide), `add-tool`,
 * `remove-tool`, `edit-skill`, the resource `notes://first`, and the skill `greet` with the file
 * `refs/tone.md`. Adding and removing a tool changes this instance, which notifies its own client,
 * and `state` for later instances; `toolsChanged` publishes the change for servers whose instances
 * are per request. `edit-skill` changes `refs/tone.md` without telling clients.
 */
export const buildModernServer = (
  state: FixtureState,
  toolsChanged: () => void
): McpServer => {
  const server = new McpServer(
    { name: "fixture", version: "1.0.0" },
    { instructions: "Fixture tools for tests.\nSecond line." }
  );

  const tools = new Map<string, RegisteredTool>();

  const register = (name: string, tool: () => RegisteredTool): void => {
    if (!state.removedTools.includes(name)) {
      tools.set(name, tool());
    }
  };

  register("echo", () =>
    server.registerTool(
      "echo",
      {
        description: "Echo the text back",
        inputSchema: z.object({ text: z.string() }),
        annotations: { readOnlyHint: true },
      },
      ({ text }) => ({ content: [{ type: "text", text }] })
    )
  );
  register("fail", () =>
    server.registerTool("fail", { description: "Always fails" }, () => ({
      content: [{ type: "text", text: "it failed" }],
      isError: true,
    }))
  );
  register("count", () =>
    server.registerTool(
      "count",
      {
        description: "Count to n with progress",
        inputSchema: z.object({ to: z.number() }),
      },
      async ({ to }, ctx) => {
        const token = ctx.mcpReq._meta?.progressToken;

        for (let step = 1; step <= to; step += 1) {
          if (token !== undefined) {
            await ctx.mcpReq.notify({
              method: "notifications/progress",
              params: { progressToken: token, progress: step, total: to },
            });
          }
        }

        return { content: [{ type: "text", text: `counted to ${to}` }] };
      }
    )
  );

  for (const name of ["dash-name", "dash_name"]) {
    register(name, () =>
      server.registerTool(name, { description: `The tool ${name}` }, () => ({
        content: [{ type: "text", text: name }],
      }))
    );
  }

  const addTool = (name: string): void => {
    register(name, () =>
      server.registerTool(name, { description: "Added at runtime" }, () => ({
        content: [{ type: "text", text: name }],
      }))
    );
  };

  server.registerTool(
    "add-tool",
    { description: "Add a tool", inputSchema: z.object({ name: z.string() }) },
    ({ name }) => {
      state.addedTools.push(name);
      addTool(name);
      toolsChanged();

      return { content: [{ type: "text", text: `added ${name}` }] };
    }
  );
  server.registerTool(
    "remove-tool",
    {
      description: "Remove a tool",
      inputSchema: z.object({ name: z.string() }),
    },
    ({ name }) => {
      state.removedTools.push(name);
      tools.get(name)?.remove();
      toolsChanged();

      return { content: [{ type: "text", text: `removed ${name}` }] };
    }
  );

  server.registerTool(
    "edit-skill",
    {
      description: "Change the skill's bundled file",
      inputSchema: z.object({ tone: z.string() }),
    },
    ({ tone }) => {
      state.skillFiles["refs/tone.md"] = tone;

      return { content: [{ type: "text", text: `tone is ${tone}` }] };
    }
  );

  for (const name of state.addedTools) {
    addTool(name);
  }

  server.registerResource(
    "first",
    "notes://first",
    { mimeType: "text/plain", description: "The first note" },
    (uri) => ({ contents: [{ uri: uri.href, text: "hello from a resource" }] })
  );

  greetSkill(state).attach(server);

  return server;
};
