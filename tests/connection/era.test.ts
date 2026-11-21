import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ProtocolVerdicts, versionNegotiation } from "../../connection/era.ts";
import { temporaryDirectory } from "../fixtures/connection.ts";

const cleanups: Array<() => void> = [];

const cleanUp = (): void => {
  vi.useRealTimers();

  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
};

const verdicts = (): ProtocolVerdicts => {
  const { dir, dispose } = temporaryDirectory();

  cleanups.push(dispose);

  return new ProtocolVerdicts(path.join(dir, "protocol.json"));
};

describe("versionNegotiation", () => {
  afterEach(cleanUp);

  it("probes in auto mode, pins modern, and skips the probe for legacy", () => {
    expect(versionNegotiation("auto", false)).toStrictEqual({ mode: "auto" });
    expect(versionNegotiation("auto", true)).toStrictEqual({
      mode: "auto",
      probe: { timeoutMs: 10_000 },
    });
    expect(versionNegotiation("modern", false)).toStrictEqual({
      mode: { pin: "2026-07-28" },
    });
    expect(versionNegotiation("legacy", true)).toBeUndefined();
  });
});

describe("ProtocolVerdicts", () => {
  afterEach(cleanUp);

  it("remembers a verdict for a day", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T00:00:00Z"));

    const store = verdicts();

    store.record("a", { kind: "legacy" });

    expect(store.prior("a")).toStrictEqual({ kind: "legacy" });

    vi.setSystemTime(new Date("2026-11-22T00:00:01Z"));

    expect(store.prior("a")).toBeUndefined();
  });

  it("forgets one verdict and keeps the others", () => {
    const store = verdicts();

    store.record("a", { kind: "legacy" });
    store.record("b", { kind: "legacy" });
    store.forget("a");

    expect(store.prior("a")).toBeUndefined();
    expect(store.prior("b")).toStrictEqual({ kind: "legacy" });
  });
});
