import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { mcpNamespace } from "@earendil-works/pi-mcp";

import { configuredExposures } from "../config/exposure.ts";
import type { ServerConnection } from "../connection/connection.ts";
import { errorMessage } from "../connection/errors.ts";
import { SignInCancelledError } from "../oauth/errors.ts";
import type { SignInPrompt } from "../oauth/sign-in.ts";
import { mcpPaths } from "../paths.ts";
import type { McpPaths } from "../paths.ts";
import { RESOURCE_TOOL_NAMES } from "../tools/resources.ts";
import { SessionAuth } from "./auth.ts";
import { DiscoveryActivator } from "./discovery.ts";
import { MCP_SERVERS_SECTION, renderServersSection } from "./prompt-section.ts";
import { ServerRegistry } from "./registry.ts";
import type { ServerSlot } from "./registry.ts";
import { describeState, isEnabled } from "./status.ts";

export type { ServerSlot } from "./registry.ts";

const DEFAULT_STARTUP_WAIT_MS = 10_000;

/** What tests and embedders may replace. */
export interface McpSessionOptions {
  readonly paths?: McpPaths | undefined;
  /** How long the first prompt waits for servers with `direct` tools. Default: 10 seconds. */
  readonly startupWaitMs?: number | undefined;
}

const ignore = (): undefined => undefined;

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const notify = (
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error"
): void => {
  try {
    ctx.ui.notify(message, type);
  } catch {
    return;
  }
};

/** Whether a call that reaches `reach` (see `reachesTools`) needs the server. */
const reachesServer = (
  reach: "all" | readonly string[],
  server: string
): boolean =>
  reach === "all" || reach.some((word) => word.includes(mcpNamespace(server)));

/** Whether the server signs in with OAuth. */
export const usesOAuth = (slot: ServerSlot): boolean =>
  slot.connection?.oauthUrl !== undefined;

/**
 * MCP in one pi session: loads and connects the servers when the session starts, waits for the
 * servers a prompt or tool call needs, lists the servers in the system prompt, and runs sign-ins.
 */
export class McpSession {
  readonly registry: ServerRegistry;
  private readonly pi: ExtensionAPI;
  private readonly options: McpSessionOptions;
  private readonly auth: SessionAuth;
  private readonly discovery: DiscoveryActivator;
  private readonly background = new Set<Promise<unknown>>();
  /** Stored tokens of connections that need a sign-in, as they were then; a sign-in elsewhere changes them. */
  private readonly tokensAtSignIn = new Map<ServerConnection, string>();
  /** Aborted on shutdown, which cancels sign-ins and drops results of work that outlived the session. */
  private session = new AbortController();
  private started: Promise<void> | undefined;
  private waitedForStartup = false;

  constructor(pi: ExtensionAPI, options: McpSessionOptions = {}) {
    const paths = options.paths ?? mcpPaths();

    this.pi = pi;
    this.options = options;
    this.auth = new SessionAuth(paths.credentials);
    this.discovery = new DiscoveryActivator(pi);
    this.registry = new ServerRegistry({
      pi,
      paths,
      auth: this.auth,
      onConnectionChange: (connection) => {
        this.noteSignInState(connection);
      },
    });
  }

  get sessionSignal(): AbortSignal {
    return this.session.signal;
  }

  /** Resolves once the servers that were starting connected or failed. */
  async whenStarted(): Promise<void> {
    await this.started;
  }

  start(ctx: ExtensionContext): void {
    this.session = new AbortController();
    this.waitedForStartup = false;
    this.discovery.reset();
    this.auth.useModelRegistry(ctx.modelRegistry);
    this.registry.load(ctx.cwd, ctx.isProjectTrusted());
    this.ensureDiscoveryActive(ctx);

    const { signal } = this.session;
    const slots = this.registry.servers;

    this.started = (async () => {
      await Promise.all(
        slots.map(async (slot) => await slot.connection?.settled())
      );

      if (!signal.aborted) {
        this.reportProblems(ctx, slots, true);
      }
    })();
  }

  async shutdown(): Promise<void> {
    this.session.abort();
    await Promise.all([...this.background, this.registry.close()]);
  }

  /**
   * The first prompt waits for servers with `direct` tools, so they are declared in its request,
   * but not past the startup wait. Every prompt lists the servers in the `mcp_servers` section.
   */
  async beforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Promise<void> {
    await this.waitForDirectServers(ctx);

    const { sections } = event.systemPromptOptions;
    const section = renderServersSection(this.registry.servers);

    if (section === undefined) {
      Reflect.deleteProperty(sections, MCP_SERVERS_SECTION);
    } else {
      sections[MCP_SERVERS_SECTION] = section;
    }
  }

  /**
   * A tool that reaches other tools waits for the servers it may reach: a codemode script for the
   * servers it names, or all when it searches; tool_search and the resource tools for all. A direct
   * MCP call waits for its own server.
   */
  async beforeToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext
  ): Promise<void> {
    const tool = this.pi
      .getAllTools()
      .find((candidate) => candidate.name === event.toolName);

    const reach = tool?.reachesTools?.(event.input);
    const owner = this.registry.ownerOf(event.toolName);

    const waiting = this.registry.servers.filter((slot) => {
      if (reach !== undefined) {
        return reachesServer(reach, slot.entry.name);
      }

      return (
        RESOURCE_TOOL_NAMES.has(event.toolName) || slot.entry.name === owner
      );
    });

    await this.waitForServers(waiting, ctx.signal);
  }

  /** Reconnect servers waiting for a sign-in whose credentials were stored since, for example by another pi. */
  async pickUpSignIns(ctx: ExtensionContext): Promise<void> {
    const signedIn = [...this.tokensAtSignIn].filter(
      ([connection, tokens]) =>
        this.auth.storedTokens(connection.entry) !== tokens
    );

    for (const [connection] of signedIn) {
      this.tokensAtSignIn.delete(connection);
    }

    if (signedIn.length > 0) {
      await Promise.allSettled(
        signedIn.map(async ([connection]) => {
          await connection.reconnect();
        })
      );
      this.ensureDiscoveryActive(ctx);
    }
  }

  /** Connect servers registered during the session, and disconnect unregistered ones. */
  async syncRegisteredServers(ctx: ExtensionContext): Promise<void> {
    if (this.session.signal.aborted) {
      return;
    }

    const { signal } = this.session;
    const added = await this.registry.syncRegistered();

    this.ensureDiscoveryActive(ctx);
    await Promise.all(
      added.map(async (slot) => await slot.connection?.settled())
    );

    if (!signal.aborted) {
      this.reportProblems(ctx, added, false);
    }
  }

  /** Sign in, then reconnect. Resolves to an error message on failure. */
  async signIn(
    slot: ServerSlot,
    prompt: SignInPrompt,
    cancel?: AbortSignal
  ): Promise<string | undefined> {
    const { connection } = slot;

    if (connection?.oauthUrl === undefined) {
      return `MCP server "${slot.entry.name}" does not use OAuth.`;
    }

    const signal =
      cancel === undefined
        ? this.session.signal
        : AbortSignal.any([this.session.signal, cancel]);

    try {
      await this.track(
        this.auth.signIn(slot.entry, connection.challenge, prompt, signal)
      );
    } catch (error) {
      if (error instanceof SignInCancelledError || signal.aborted) {
        return "Sign-in cancelled.";
      }

      return `Sign-in failed: ${errorMessage(error)}`;
    }

    connection.clearChallenge();

    const failed = await this.registry.reconnect(slot);

    return failed === undefined ? undefined : `Signed in, but ${failed}`;
  }

  /** Delete the stored credentials and disconnect. Resolves to whether there were any. */
  async signOut(slot: ServerSlot): Promise<boolean> {
    const { connection } = slot;

    if (connection?.oauthUrl === undefined) {
      return false;
    }

    const removed = await this.auth.signOut(slot.entry);

    await connection.signOut();

    return removed;
  }

  /** Show the outcome of a `/mcp` action on its server, unless the session or the server is gone. */
  report(
    ctx: ExtensionContext,
    slot: ServerSlot,
    message: string | undefined
  ): void {
    if (this.session.signal.aborted || !this.registry.includes(slot)) {
      return;
    }

    slot.message = message;
    this.ensureDiscoveryActive(ctx);
    this.registry.emitChange();
  }

  /** Run a `/mcp` action in the background and report its outcome. */
  runInBackground(
    ctx: ExtensionContext,
    slot: ServerSlot,
    action: () => Promise<string | undefined>
  ): void {
    void this.track(
      (async () => {
        try {
          this.report(ctx, slot, await action());
        } catch (error) {
          this.report(ctx, slot, errorMessage(error));
        }
      })()
    );
  }

  ensureDiscoveryActive(ctx: ExtensionContext): void {
    this.discovery.ensure(
      ctx,
      this.registry.exposures(),
      this.registry.autoEnableCodemode
    );
  }

  private async track<T>(work: Promise<T>): Promise<T> {
    const settled = work.catch(ignore);

    this.background.add(settled);
    void settled.finally(() => {
      this.background.delete(settled);
    });

    return await work;
  }

  private noteSignInState(connection: ServerConnection): void {
    if (connection.state !== "needs-auth") {
      this.tokensAtSignIn.delete(connection);
    } else if (!this.tokensAtSignIn.has(connection)) {
      this.tokensAtSignIn.set(
        connection,
        this.auth.storedTokens(connection.entry)
      );
    }

    for (const tracked of this.tokensAtSignIn.keys()) {
      if (!this.registry.servers.some((slot) => slot.connection === tracked)) {
        this.tokensAtSignIn.delete(tracked);
      }
    }
  }

  /** Wait for the servers' connections to settle, including ones that replaced them meanwhile, or an abort. */
  private async waitForServers(
    slots: readonly ServerSlot[],
    signal: AbortSignal | undefined
  ): Promise<void> {
    for (;;) {
      const current = slots.flatMap((slot) =>
        this.registry.includes(slot) && isEnabled(slot.entry) && slot.connection
          ? [slot.connection]
          : []
      );

      if (current.length === 0 || isAborted(signal)) {
        return;
      }

      const stop = new AbortController();

      await Promise.race([
        Promise.all(
          current.map(async (connection) => {
            await connection.settled();
          })
        ),
        ...(signal === undefined
          ? []
          : [once(signal, "abort", { signal: stop.signal }).catch(ignore)]),
      ]);
      stop.abort();

      const replaced = slots.some(
        (slot) =>
          slot.connection !== undefined && !current.includes(slot.connection)
      );

      if (!replaced || isAborted(signal)) {
        return;
      }
    }
  }

  private async waitForDirectServers(ctx: ExtensionContext): Promise<void> {
    if (this.waitedForStartup) {
      return;
    }

    this.waitedForStartup = true;

    const direct = this.registry.servers.flatMap((slot) =>
      isEnabled(slot.entry) &&
      configuredExposures(slot.entry.config).has("direct") &&
      slot.connection
        ? [slot.connection]
        : []
    );

    if (direct.length === 0) {
      return;
    }

    const timer = new AbortController();

    const finished = await Promise.race([
      Promise.all(
        direct.map(async (connection) => {
          await connection.settled();
        })
      ).then(() => true),
      delay(this.options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS, false, {
        signal: timer.signal,
      }).catch(() => false),
    ]);

    timer.abort();

    if (!finished) {
      notify(
        ctx,
        "MCP servers are still connecting; their tools become available once connected.",
        "info"
      );
    }
  }

  /** One message for everything that needs the user: config errors (when `withConfig`) and failed servers. */
  private reportProblems(
    ctx: ExtensionContext,
    slots: readonly ServerSlot[],
    withConfig: boolean
  ): void {
    const lines = withConfig
      ? this.registry.configErrors.map((error) => `config: ${error}`)
      : [];

    for (const slot of slots) {
      const state = slot.connection?.state;

      if (state === "needs-auth" || state === "failed") {
        lines.push(`${slot.entry.name}: ${describeState(slot)}`);
      }
    }

    if (lines.length > 0) {
      notify(
        ctx,
        `MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
        "warning"
      );
    }
  }
}
