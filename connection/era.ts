import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  PriorDiscovery,
  VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import type { ProtocolPreference } from "../config/schema.ts";

/** The 2026-07-28 revision, the first of the stateless era. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

const VERDICT_HORIZON_MS = 24 * 60 * 60 * 1000;
const STDIO_PROBE_TIMEOUT_MS = 10_000;

const verdictKinds = z.union([
  z.object({ kind: z.literal("legacy") }),
  z.object({
    kind: z.literal("modern"),
    discover: z.looseObject({ supportedVersions: z.array(z.string()) }),
  }),
]);

/** Whether a stored value is a verdict; the SDK validates the rest when it adopts it. */
const isPriorDiscovery = (value: unknown): value is PriorDiscovery =>
  verdictKinds.safeParse(value).success;

const verdictFile = z.record(
  z.string(),
  z.object({
    verdict: z.custom<PriorDiscovery>(isPriorDiscovery),
    storedAt: z.number(),
  })
);

type Verdicts = z.infer<typeof verdictFile>;

/**
 * How `connect()` picks the protocol era. `auto` probes with `server/discover` and falls back to
 * the 2025 `initialize` handshake; `modern` accepts 2026-07-28 only; `legacy` skips the probe. On
 * stdio, a 2025 server that ignores the probe only costs a short wait.
 */
export const versionNegotiation = (
  preference: ProtocolPreference,
  stdio: boolean
): VersionNegotiationOptions | undefined => {
  if (preference === "legacy") {
    return undefined;
  }

  if (preference === "modern") {
    return { mode: { pin: MODERN_PROTOCOL_VERSION } };
  }

  return stdio
    ? { mode: "auto", probe: { timeoutMs: STDIO_PROBE_TIMEOUT_MS } }
    : { mode: "auto" };
};

/**
 * Which era each server spoke when last probed, so later connections skip the probe. A verdict is
 * trusted for a day: a stale modern verdict fails at the first request and is re-probed, but a stale
 * legacy one would keep an upgraded server on the 2025 era, which only its age retires. Writes are
 * best effort; a lost one costs a probe.
 */
export class ProtocolVerdicts {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  prior(key: string): PriorDiscovery | undefined {
    const stored = this.readAll()[key];

    return stored !== undefined &&
      Date.now() - stored.storedAt < VERDICT_HORIZON_MS
      ? stored.verdict
      : undefined;
  }

  record(key: string, verdict: PriorDiscovery): void {
    this.write({ ...this.readAll(), [key]: { verdict, storedAt: Date.now() } });
  }

  forget(key: string): void {
    this.write(
      Object.fromEntries(
        Object.entries(this.readAll()).filter(([stored]) => stored !== key)
      )
    );
  }

  private readAll(): Verdicts {
    try {
      if (!existsSync(this.file)) {
        return {};
      }

      const parsed = verdictFile.safeParse(
        JSON.parse(readFileSync(this.file, "utf8"))
      );

      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  private write(verdicts: Verdicts): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });

      const temporary = `${this.file}.${process.pid}.tmp`;

      writeFileSync(temporary, `${JSON.stringify(verdicts, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } catch {
      return;
    }
  }
}
