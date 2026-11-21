import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { FauxResponseStep, JsonObject } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { createMcpExtension } from "../../index.ts";
import { mcpPaths } from "../../paths.ts";

/** A real pi session with this extension and codemode, answering with scripted responses. */
export interface SessionUnderTest {
  readonly session: AgentSession;
  readonly agentDir: string;
  readonly respond: (responses: FauxResponseStep[]) => void;
  readonly dispose: () => Promise<void>;
}

export const startSession = async (
  dir: string,
  mcpServers: JsonObject
): Promise<SessionUnderTest> => {
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "project");

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers }, null, 2)
  );

  const faux = fauxProvider();

  faux.setResponses([]);

  const model = faux.getModel();

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });

  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");

  const settingsManager = SettingsManager.inMemory();

  const resourceLoader = new DefaultResourceLoader({
    agentDir,
    cwd,
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      createMcpExtension({ paths: mcpPaths(agentDir), startupWaitMs: 20_000 }),
    ],
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });

  await resourceLoader.reload();

  const { session } = await createAgentSession({
    agentDir,
    cwd,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });

  await session.bindExtensions({});

  return {
    session,
    agentDir,
    respond: (responses) => {
      faux.setResponses(responses);
    },
    dispose: async () => {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
      modelRuntime.unregisterProvider(faux.provider.id);
    },
  };
};
