import type { ToolExposure } from "@earendil-works/pi-coding-agent";

/**
 * How the model reaches a server's tools.
 *
 * - `codemode`: callable from codemode scripts, which find them with `searchTools()`.
 * - `deferred`: declared once `tool_search` loads them.
 * - `direct`: declared to the model like built-in tools.
 * - `hidden`: registered but unreachable.
 */
export const MCP_EXPOSURES = [
  "codemode",
  "deferred",
  "direct",
  "hidden",
] as const;

export type McpExposure = (typeof MCP_EXPOSURES)[number];

/** Older exposure names accepted in configs. */
export const MCP_EXPOSURE_ALIASES: ReadonlyMap<string, McpExposure> = new Map([
  ["codemode-deferred", "codemode"],
]);

/** The exposure fields of a server config. */
export interface ExposureSettings {
  readonly exposure?: McpExposure | undefined;
  readonly toolExposure?: Readonly<Record<string, McpExposure>> | undefined;
}

const patternRegExp = (pattern: string): RegExp => {
  const source = pattern
    .split("*")
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join(".*");

  return new RegExp(`^${source}$`, "u");
};

/** The server's exposure, `codemode` when unset. */
export const serverExposure = (settings: ExposureSettings): McpExposure =>
  settings.exposure ?? "codemode";

/**
 * Exposure of one tool: an exact `toolExposure` key, else the first matching `*` pattern, else the
 * server's exposure.
 */
export const toolExposure = (
  settings: ExposureSettings,
  tool: string
): McpExposure => {
  const overrides = settings.toolExposure ?? {};
  const exact = overrides[tool];

  if (exact !== undefined) {
    return exact;
  }

  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes("*") && patternRegExp(pattern).test(tool)) {
      return exposure;
    }
  }

  return serverExposure(settings);
};

/** Every exposure the server's tools can have, known before it connects. */
export const configuredExposures = (
  settings: ExposureSettings
): ReadonlySet<McpExposure> =>
  new Set([
    serverExposure(settings),
    ...Object.values(settings.toolExposure ?? {}),
  ]);

/**
 * Pi's tool exposure for an MCP exposure. MCP `codemode` tools stay out of the codemode tool's
 * listing, which is pi's `deferred`; the two MCP exposures differ in which tool gets activated.
 */
export const toPiExposure = (exposure: McpExposure): ToolExposure =>
  exposure === "codemode" ? "deferred" : exposure;
