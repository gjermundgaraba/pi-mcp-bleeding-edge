import type {
  PriorDiscovery,
  VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import type { ProtocolPreference } from "../config/schema.ts";
import { readJsonFile, writePrivateJsonFile } from "../json-file.ts";

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

const storedVerdict = z.object({
  verdict: z.custom<PriorDiscovery>(isPriorDiscovery),
  storedAt: z.number(),
});

type StoredVerdict = z.infer<typeof storedVerdict>;

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
 * legacy one would keep an upgraded server on the 2025 era, which only its age retires. Entries that
 * do not parse are skipped, and writes are best effort: a lost verdict costs a probe.
 */
export class ProtocolVerdicts {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  prior(key: string): PriorDiscovery | undefined {
    const stored = this.readAll().get(key);

    return stored !== undefined &&
      Date.now() - stored.storedAt < VERDICT_HORIZON_MS
      ? stored.verdict
      : undefined;
  }

  record(key: string, verdict: PriorDiscovery): void {
    this.write(
      new Map(this.readAll()).set(key, { verdict, storedAt: Date.now() })
    );
  }

  forget(key: string): void {
    const verdicts = this.readAll();

    verdicts.delete(key);
    this.write(verdicts);
  }

  private readAll(): Map<string, StoredVerdict> {
    const verdicts = new Map<string, StoredVerdict>();

    try {
      const stored = z
        .record(z.string(), z.unknown())
        .safeParse(readJsonFile(this.file));

      for (const [key, value] of Object.entries(
        stored.success ? stored.data : {}
      )) {
        const verdict = storedVerdict.safeParse(value);

        if (verdict.success) {
          verdicts.set(key, verdict.data);
        }
      }
    } catch {
      return verdicts;
    }

    return verdicts;
  }

  private write(verdicts: Map<string, StoredVerdict>): void {
    try {
      writePrivateJsonFile(this.file, Object.fromEntries(verdicts));
    } catch {
      return;
    }
  }
}
