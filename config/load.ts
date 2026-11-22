import { mcpNamespace } from "@earendil-works/pi-mcp";
import { z } from "zod";

import { errorMessage } from "../connection/errors.ts";
import { readJsonFile } from "../json-file.ts";
import type { McpPaths } from "../paths.ts";
import {
  configFileSchema,
  isHttpConfig,
  isServerOverride,
  parseServerConfig,
  parseServerOverride,
} from "./schema.ts";
import type { McpServerConfig } from "./schema.ts";

/** Where a server entry comes from. Changes to `extension` servers apply to the session only. */
export type ServerScope = "global" | "project" | "extension";

/** A configured server. */
export interface ServerEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  /** The `mcp.json` that defines the server, or the path of the extension that registered it. */
  readonly source: string;
  readonly scope: ServerScope;
  /** The project `mcp.json` overriding `enabled`, `exposure`, or `toolExposure` of this global server. */
  readonly override?: string | undefined;
}

/** The servers of the global and the trusted project's `mcp.json`. */
export interface LoadedConfig {
  readonly servers: readonly ServerEntry[];
  /** Activate the codemode tool for `codemode` servers. Default: true. */
  readonly autoEnableCodemode: boolean;
  readonly errors: readonly string[];
  /** The trusted project's `mcp.json`, where `/mcp` saves project overrides. */
  readonly projectConfig?: string | undefined;
}

interface LoadState {
  readonly servers: Map<string, ServerEntry>;
  readonly errors: string[];
  autoEnableCodemode?: boolean;
}

const readOverride = (
  file: string,
  name: string,
  value: unknown,
  state: LoadState
): void => {
  const base = state.servers.get(name);

  if (base === undefined) {
    state.errors.push(
      `${file}: server "${name}" needs "command" or "url", or a global server to override`
    );

    return;
  }

  const override = parseServerOverride(name, value);

  if (override.error !== undefined) {
    state.errors.push(`${file}: ${override.error}`);

    return;
  }

  const parsed = parseServerConfig(name, { ...base.config, ...override.value });

  if (parsed.error === undefined) {
    state.servers.set(name, { ...base, config: parsed.value, override: file });
  } else {
    state.errors.push(`${file}: ${parsed.error}`);
  }
};

const readServer = (
  file: string,
  scope: ServerScope,
  name: string,
  value: unknown,
  state: LoadState
): void => {
  const parsed = parseServerConfig(name, value);

  if (parsed.error !== undefined) {
    state.errors.push(`${file}: ${parsed.error}`);

    return;
  }

  const clash = [...state.servers.keys()].find(
    (other) => other !== name && mcpNamespace(other) === mcpNamespace(name)
  );

  if (clash !== undefined) {
    state.errors.push(`${file}: server "${name}" conflicts with "${clash}"`);

    return;
  }

  if (
    scope === "project" &&
    isHttpConfig(parsed.value) &&
    parsed.value.auth !== undefined
  ) {
    state.errors.push(
      `${file}: server "${name}": auth is only allowed in the global mcp.json`
    );

    return;
  }

  state.servers.set(name, { name, config: parsed.value, source: file, scope });
};

const readConfigFile = (
  file: string,
  scope: "global" | "project",
  state: LoadState
): void => {
  let json: unknown;

  try {
    json = readJsonFile(file);
  } catch (error) {
    state.errors.push(`${file}: ${errorMessage(error)}`);

    return;
  }

  if (json === undefined) {
    return;
  }

  const parsed = configFileSchema.safeParse(json);

  if (!parsed.success) {
    state.errors.push(
      `${file}: expected an object with an "mcpServers" object`
    );

    return;
  }

  const auto = z.boolean().optional().safeParse(parsed.data.autoEnableCodemode);

  if (!auto.success) {
    state.errors.push(`${file}: autoEnableCodemode must be a boolean`);
  } else if (auto.data !== undefined) {
    state.autoEnableCodemode = auto.data;
  }

  for (const [name, value] of Object.entries(parsed.data.mcpServers ?? {})) {
    if (scope === "project" && isServerOverride(value)) {
      readOverride(file, name, value, state);
    } else {
      readServer(file, scope, name, value, state);
    }
  }
};

/**
 * Read the global and, for trusted projects, the project `mcp.json`. A project entry replaces the
 * global one of the same name; one without `command`, `url`, or `type` only overrides
 * `enabled`, `exposure`, and `toolExposure`. Disabled servers are included.
 */
export const loadConfig = (
  paths: McpPaths,
  cwd: string,
  projectTrusted: boolean
): LoadedConfig => {
  const state: LoadState = { servers: new Map(), errors: [] };

  readConfigFile(paths.globalConfig, "global", state);

  const projectConfig = projectTrusted ? paths.projectConfig(cwd) : undefined;

  if (projectConfig !== undefined) {
    readConfigFile(projectConfig, "project", state);
  }

  return {
    servers: [...state.servers.values()],
    autoEnableCodemode: state.autoEnableCodemode ?? true,
    errors: state.errors,
    projectConfig,
  };
};
