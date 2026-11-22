import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import { readTextFile } from "../json-file.ts";
import type { McpExposure } from "./exposure.ts";
import { isServerOverride } from "./schema.ts";

/** The settings `/mcp` changes. */
export interface ServerConfigPatch {
  readonly enabled?: boolean;
  readonly exposure?: McpExposure;
}

const jsonObject = z.record(z.string(), z.json());

type JsonObjectValue = z.infer<typeof jsonObject>;

/** `object` with `key` set to `value` in its place, or removed when `value` is undefined. */
const withSetting = (
  object: JsonObjectValue,
  key: string,
  value: boolean | string | undefined
): JsonObjectValue => {
  if (value === undefined) {
    return Object.fromEntries(
      Object.entries(object).filter(([name]) => name !== key)
    );
  }

  return { ...object, [key]: value };
};

const applyPatch = (
  server: JsonObjectValue,
  patch: ServerConfigPatch,
  keepDefaults: boolean
): JsonObjectValue => {
  let next = server;

  if (patch.enabled !== undefined) {
    const dropped = patch.enabled && !keepDefaults;

    next = withSetting(next, "enabled", dropped ? undefined : patch.enabled);
  }

  if (patch.exposure !== undefined) {
    const dropped = patch.exposure === "codemode" && !keepDefaults;

    next = withSetting(next, "exposure", dropped ? undefined : patch.exposure);
  }

  return next;
};

const indentOf = (text: string): string =>
  /^(?<indent>[ \t]+)\S/mu.exec(text)?.groups?.["indent"] ?? "  ";

/**
 * Change one server's settings in the `mcp.json` that defines or overrides it, keeping other content,
 * the order of keys, and the file's indentation. With `override`, a missing entry is added as a
 * project override. Defaults (`enabled: true`, `exposure: "codemode"`) remove the key, except in
 * overrides, which replace the global server's values.
 */
export const updateServerConfig = async (
  file: string,
  name: string,
  patch: ServerConfigPatch,
  options: { readonly override?: boolean } = {}
): Promise<void> => {
  await withFileMutationQueue(file, async () => {
    const text = readTextFile(file) ?? "";
    const json: unknown = text.trim() === "" ? {} : JSON.parse(text);
    const parsed = jsonObject.safeParse(json);

    const servers = jsonObject.safeParse(
      parsed.success ? (parsed.data["mcpServers"] ?? {}) : undefined
    );

    if (!parsed.success || !servers.success) {
      throw new Error(
        `${file}: expected an object with an "mcpServers" object`
      );
    }

    const existing =
      servers.data[name] ?? (options.override === true ? {} : undefined);

    const server = jsonObject.safeParse(existing);

    if (!server.success) {
      throw new Error(`${file} does not define MCP server "${name}"`);
    }

    const updated = applyPatch(server.data, patch, isServerOverride(existing));

    const next = {
      ...parsed.data,
      mcpServers: { ...servers.data, [name]: updated },
    };

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, indentOf(text))}\n`);
  });
};
