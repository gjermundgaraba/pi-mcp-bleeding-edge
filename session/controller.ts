import {
  setImmediate as nextTurn,
  setTimeout as delay,
} from "node:timers/promises";

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { updateServerConfig } from "../config/edit.ts";
import type { ServerConfigPatch } from "../config/edit.ts";
import {
  configuredExposures,
  serverExposure,
  toolExposure,
} from "../config/exposure.ts";
import type { McpExposure } from "../config/exposure.ts";
import { loadConfig } from "../config/load.ts";
import type { LoadedConfig, ServerEntry } from "../config/load.ts";
import { isHttpConfig, parseServerConfig } from "../config/schema.ts";
import type { ServerConnection } from "../connection/connection.ts";
import type { TransportFactory } from "../connection/transport.ts";
import { SignInCancelledError } from "../oauth/errors.ts";
import type { SignInPrompt } from "../oauth/sign-in.ts";
import { mcpPaths } from "../paths.ts";
import type { McpPaths } from "../paths.ts";
import { mcpNamespace } from "../tools/naming.ts";
import { RESOURCE_TOOL_NAMES } from "../tools/resources.ts";
import type { SessionAuth } from "./auth.ts";
import { ToolCatalog } from "./catalog.ts";
import { DiscoveryActivator } from "./discovery.ts";
import { MCP_SERVERS_SECTION, renderServersSection } from "./prompt-section.ts";
import { describeState, isEnabled } from "./status.ts";

const DEFAULT_STARTUP_WAIT_MS = 10_000;

type Runtime = typeof import("./runtime.ts");

let runtimeModule: Promise<Runtime> | undefined;

const loadRuntime = async (): Promise<Runtime> => {
  runtimeModule ??= import("./runtime.ts");

  return await runtimeModule;
};

interface Services {
  readonly runtime: Runtime;
  readonly auth: SessionAuth;
  readonly verdicts: InstanceType<Runtime["ProtocolVerdicts"]>;
  readonly log: InstanceType<Runtime["ServerLog"]>;
}

/** A configured server and its connection. Disabled servers have none. */
export interface ServerSlot {
  entry: ServerEntry;
  connection?: ServerConnection | undefined;
  /** For servers extensions registered: the config as registered, to notice re-registrations. */
  registeredConfig?: string | undefined;
  /** The failure of the last `/mcp` action, shown in the manager. */
  message?: string | undefined;
  /** The current connection attempt; disabling or replacing the server invalidates earlier work. */
  attempt?: symbol | undefined;
  /** Settles when the current attempt connected or failed. */
  ready?: Promise<void> | undefined;
  /** Cleanup of a detached connection, which a new one waits for. */
  closing?: Promise<void> | undefined;
}

/** What tests and embedders may replace. */
export interface McpSessionOptions {
  readonly paths?: McpPaths | undefined;
  readonly createTransport?: TransportFactory | undefined;
  /** How long the first prompt waits for servers with `direct` tools. Default: 10 seconds. */
  readonly startupWaitMs?: number | undefined;
}

/** Servers extensions registered, and lines about the registrations that cannot be used. */
interface RegisteredServers {
  readonly slots: ServerSlot[];
  readonly overridden: string[];
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

/** Identifies a server's era verdict: its name and how it is reached. */
const verdictKey = (entry: ServerEntry): string => {
  const { config } = entry;

  return JSON.stringify(
    isHttpConfig(config)
      ? [entry.name, config.url]
      : [entry.name, config.command, config.args ?? [], config.cwd ?? ""]
  );
};

/** Resolves when `signal` aborts; `release` stops listening. */
const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/** A wait for an abort, and how to stop waiting. */
interface Abortion {
  readonly aborted: Promise<void>;
  readonly release: () => void;
}

const abortion = (signal: AbortSignal | undefined): Abortion => {
  const { promise, resolve } = Promise.withResolvers<undefined>();

  const onAbort = (): void => {
    resolve(undefined);
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    aborted: promise,
    release: () => {
      signal?.removeEventListener("abort", onAbort);
    },
  };
};

/** Whether the server signs in with OAuth. */
export const usesOAuth = (slot: ServerSlot): boolean =>
  slot.connection?.oauthUrl !== undefined;

/** Connect a server again. Resolves to an error message on failure. */
export const reconnectServer = async (
  slot: ServerSlot
): Promise<string | undefined> => {
  const { connection } = slot;

  if (connection === undefined) {
    return `MCP server "${slot.entry.name}" is disabled.`;
  }

  const previous = slot.ready;

  const ready = (async () => {
    await previous;
    await connection.reconnect();
  })();

  slot.ready = ready.catch(() => undefined);

  try {
    await ready;

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const abortedController = (): AbortController => {
  const controller = new AbortController();
  controller.abort();

  return controller;
};

/** Whether a call that reaches `reach` (see `reachesTools`) needs the server. */
const reachesServer = (
  reach: "all" | readonly string[],
  server: string
): boolean => {
  if (reach === "all") {
    return true;
  }

  const namespace = mcpNamespace(server);

  return reach.some((word) => word.includes(namespace));
};

/**
 * MCP for one pi session: the servers of `mcp.json` and of `pi.registerMcpServer()`, their
 * connections in the background, their tools in pi, and the `/mcp` actions. A server in
 * `mcp.json` takes precedence over a registered one of the same name.
 */
export class McpSession {
  readonly paths: McpPaths;
  private readonly pi: ExtensionAPI;
  private readonly options: McpSessionOptions;
  private readonly catalog: ToolCatalog;
  private readonly discovery: DiscoveryActivator;
  private slots: ServerSlot[] = [];
  private configured: readonly ServerEntry[] = [];
  private configErrors: readonly string[] = [];
  private overridden: readonly string[] = [];
  private autoEnableCodemode = true;
  private pending: Promise<unknown> | undefined;
  private waitedForStartup = false;
  private cwd = process.cwd();
  private modelRegistry: ExtensionContext["modelRegistry"] | undefined;
  private services: Promise<Services> | undefined;
  /** Aborted on shutdown; work started in a session drops its results once it aborted. */
  private session = abortedController();
  private readonly background = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  /** Stored tokens of servers that need a sign-in, as they were then; a sign-in elsewhere changes them. */
  private readonly tokensAtSignIn = new Map<ServerConnection, string>();
  /** The trusted project's `mcp.json`. */
  projectConfig: string | undefined;

  constructor(pi: ExtensionAPI, options: McpSessionOptions = {}) {
    this.pi = pi;
    this.options = options;
    this.paths = options.paths ?? mcpPaths();
    this.discovery = new DiscoveryActivator(pi);
    this.catalog = new ToolCatalog(pi, {
      caller: async (server, tool) => await this.caller(server, tool),
      readableResources: (server) =>
        this.resourceSlots().some((slot) => slot.entry.name === server),
      resourceServers: () =>
        this.resourceSlots().flatMap((slot) =>
          slot.connection ? [slot.connection] : []
        ),
    });
  }

  get servers(): readonly ServerSlot[] {
    return this.slots;
  }

  find(name: string): ServerSlot | undefined {
    return this.slots.find((slot) => slot.entry.name === name);
  }

  /** Config errors and overridden registrations, for `/mcp`. */
  notices(): string[] {
    return [
      ...this.configErrors.map((error) => `config: ${error}`),
      ...this.overridden.map((line) => `overridden: ${line}`),
    ];
  }

  /** Resolves once the servers that were starting finished connecting or failed. */
  async whenStarted(): Promise<void> {
    await this.pending;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  // Lifecycle

  start(ctx: ExtensionContext): void {
    const loaded = loadConfig(this.paths, ctx.cwd, ctx.isProjectTrusted());
    this.applyConfig(loaded);
    this.cwd = ctx.cwd;
    this.modelRegistry = ctx.modelRegistry;
    this.waitedForStartup = false;
    this.discovery.reset();
    this.session = new AbortController();
    const { signal } = this.session;
    const registered = this.registeredServers();
    this.overridden = registered.overridden;
    this.slots = [
      ...loaded.servers.map((entry) => ({ entry })),
      ...registered.slots,
    ];
    this.emitChange();
    this.ensureDiscoveryActive(ctx);
    const enabled = this.slots.filter((slot) => isEnabled(slot.entry));

    if (enabled.length === 0) {
      this.reportProblems(ctx);

      return;
    }

    const after = nextTurn().then(async () => await this.loadServices());

    this.pending = (async () => {
      try {
        await Promise.all(
          enabled.map(async (slot) => {
            await this.startConnection(slot, after);
          })
        );
      } catch (error) {
        notify(ctx, `MCP failed to load: ${errorMessage(error)}`, "error");

        return;
      }

      if (!signal.aborted) {
        this.reportProblems(ctx);
      }
    })();
  }

  async shutdown(): Promise<void> {
    this.session.abort();

    const closing = this.slots.flatMap((slot) =>
      slot.connection ? [slot.connection.close()] : []
    );

    this.slots = [];
    this.emitChange();
    await Promise.all([...this.background, ...closing]);
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
    const section = renderServersSection(this.slots);

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

    if (!tool) {
      return;
    }

    const ready = this.slots.filter(
      (slot) => isEnabled(slot.entry) && slot.ready !== undefined
    );

    if (ready.length === 0) {
      return;
    }

    const reach = tool.reachesTools?.(event.input);
    const owner = this.catalog.ownerOf(event.toolName);

    if (reach !== undefined) {
      await this.waitForServers(
        ready.filter((slot) => reachesServer(reach, slot.entry.name)),
        ctx.signal
      );
    } else if (RESOURCE_TOOL_NAMES.has(tool.name)) {
      await this.waitForServers(ready, ctx.signal);
    } else {
      await this.waitForServers(
        ready.filter((slot) => slot.entry.name === owner),
        ctx.signal
      );
    }
  }

  /** Reconnect servers waiting for a sign-in whose credentials were stored since, for example by another pi. */
  async pickUpSignIns(ctx: ExtensionContext): Promise<void> {
    if (this.tokensAtSignIn.size === 0) {
      return;
    }

    const { auth } = await this.loadServices();

    const signedIn = [...this.tokensAtSignIn].filter(
      ([connection, tokens]) => auth.storedTokens(connection.entry) !== tokens
    );

    if (signedIn.length === 0) {
      return;
    }

    for (const [connection] of signedIn) {
      this.tokensAtSignIn.delete(connection);
    }

    await Promise.allSettled(
      signedIn.map(async ([connection]) => {
        await connection.reconnect();
      })
    );
    this.ensureDiscoveryActive(ctx);
  }

  /** Connect servers registered during the session, and disconnect unregistered ones. */
  async syncRegisteredServers(ctx: ExtensionContext): Promise<void> {
    const { signal } = this.session;

    if (signal.aborted) {
      return;
    }

    const registered = this.registeredServers();
    this.overridden = registered.overridden;

    const next = new Map(
      registered.slots.map((slot) => [slot.entry.name, slot])
    );

    const removed = this.slots.filter(
      (slot) =>
        slot.entry.scope === "extension" &&
        next.get(slot.entry.name)?.registeredConfig !== slot.registeredConfig
    );

    this.slots = this.slots.filter((slot) => !removed.includes(slot));

    for (const slot of removed) {
      this.catalog.hide(slot.entry.name);
    }

    const added = registered.slots.filter(
      (slot) =>
        !this.slots.some((existing) => existing.entry.name === slot.entry.name)
    );

    this.slots.push(...added);
    this.syncResources();
    this.emitChange();
    this.ensureDiscoveryActive(ctx);
    await Promise.all(
      removed.map(async (slot) => await slot.connection?.close())
    );
    const connecting = added.filter((slot) => isEnabled(slot.entry));

    if (signal.aborted || connecting.length === 0) {
      return;
    }

    try {
      await Promise.all(
        connecting.map(async (slot) => {
          await this.startConnection(slot);
        })
      );
    } catch (error) {
      notify(ctx, `MCP failed to load: ${errorMessage(error)}`, "error");

      return;
    }

    if (signal.aborted) {
      await Promise.all(
        connecting.map(async (slot) => await slot.connection?.close())
      );

      return;
    }

    this.reportProblems(ctx, connecting);
  }

  // Actions of /mcp

  /** Enable or disable a server, saved to its config. Resolves to an error message when saving failed. */
  async setEnabled(
    slot: ServerSlot,
    enabled: boolean,
    inProject = false
  ): Promise<string | undefined> {
    const failed = await this.saveConfig(slot, { enabled }, inProject);

    if (failed !== undefined) {
      return failed;
    }

    if (enabled) {
      await this.startConnection(slot, slot.closing);

      return undefined;
    }

    const { connection } = slot;
    slot.attempt = undefined;
    slot.connection = undefined;

    if (connection) {
      slot.closing = Promise.all([connection.close(), slot.ready]).then(
        () => undefined
      );
    }

    const { closing } = slot;
    this.catalog.hide(slot.entry.name);
    this.syncResources();
    this.emitChange();

    try {
      await closing;
    } finally {
      if (slot.closing === closing) {
        slot.closing = undefined;
      }
    }

    return undefined;
  }

  /** Change a server's exposure, saved to its config. Resolves to an error message when saving failed. */
  async setExposure(
    slot: ServerSlot,
    exposure: McpExposure
  ): Promise<string | undefined> {
    const failed = await this.saveConfig(slot, { exposure });

    if (failed !== undefined) {
      return failed;
    }

    if (slot.connection?.state === "connected") {
      this.catalog.register(slot.entry, slot.connection);
    }

    this.syncResources();

    const indirect = new Set(
      this.pi
        .getAllTools()
        .filter((tool) => tool.exposure !== "direct")
        .map((tool) => tool.name)
    );

    const tools = this.catalog.toolsOf(slot.entry.name);
    this.pi.setActiveTools(
      this.pi
        .getActiveTools()
        .filter((name) => !tools.has(name) || !indirect.has(name))
    );
    this.emitChange();

    return undefined;
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

    const { auth } = await this.loadServices();

    const signal =
      cancel === undefined
        ? this.session.signal
        : AbortSignal.any([this.session.signal, cancel]);

    try {
      await this.track(
        auth.signIn(slot.entry, connection.challenge, prompt, signal)
      );
    } catch (error) {
      if (error instanceof SignInCancelledError || signal.aborted) {
        return "Sign-in cancelled.";
      }

      return `Sign-in failed: ${errorMessage(error)}`;
    }

    connection.clearChallenge();

    try {
      await connection.reconnect();
    } catch (error) {
      return `Signed in, but ${errorMessage(error)}`;
    }

    return undefined;
  }

  /** Delete the stored credentials and disconnect. Resolves to whether there were any. */
  async signOut(slot: ServerSlot): Promise<boolean> {
    const { connection } = slot;

    if (connection?.oauthUrl === undefined) {
      return false;
    }

    const { auth } = await this.loadServices();
    const removed = await auth.signOut(slot.entry);
    await connection.signOut();

    return removed;
  }

  /** Run an action in the background, keeping its failure as the server's message. */
  runInBackground(
    ctx: ExtensionContext,
    slot: ServerSlot,
    operation: () => Promise<string | undefined>
  ): void {
    const ready = operation();
    const { attempt } = slot;
    const { signal } = this.session;

    const finish = (message: string | undefined) => {
      if (
        signal.aborted ||
        slot.attempt !== attempt ||
        !this.slots.includes(slot)
      ) {
        return;
      }

      slot.message = message;
      this.ensureDiscoveryActive(ctx);
      this.emitChange();
    };

    void this.track(
      ready.then(finish).catch((error: unknown) => {
        finish(errorMessage(error));
      })
    );
  }

  /** Keep an action's message, unless the session ended meanwhile. */
  settleAction(
    ctx: ExtensionContext,
    slot: ServerSlot,
    message: string | undefined
  ): void {
    if (this.session.signal.aborted) {
      return;
    }

    slot.message = message;
    this.ensureDiscoveryActive(ctx);
    this.emitChange();
  }

  get sessionSignal(): AbortSignal {
    return this.session.signal;
  }

  ensureDiscoveryActive(ctx: ExtensionContext): void {
    const exposures = new Set<McpExposure>();

    for (const slot of this.slots) {
      if (isEnabled(slot.entry)) {
        for (const exposure of configuredExposures(slot.entry.config)) {
          exposures.add(exposure);
        }
      }
    }

    this.discovery.ensure(ctx, exposures, this.autoEnableCodemode);
  }

  // Internals

  private applyConfig(loaded: LoadedConfig): void {
    this.configured = loaded.servers;
    this.configErrors = loaded.errors;
    this.projectConfig = loaded.projectConfig;
    this.autoEnableCodemode = loaded.autoEnableCodemode;
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async track<T>(work: Promise<T>): Promise<T> {
    const task = work.then(() => undefined).catch(() => undefined);

    this.background.add(task);
    void task.finally(() => {
      this.background.delete(task);
    });

    return await work;
  }

  private async loadServices(): Promise<Services> {
    this.services ??= loadRuntime().then((runtime) => ({
      runtime,
      auth: new runtime.SessionAuth(this.paths.credentials),
      verdicts: new runtime.ProtocolVerdicts(this.paths.protocolVerdicts),
      log: new runtime.ServerLog(this.paths.log),
    }));

    return await this.services;
  }

  /** Servers extensions registered, except names `mcp.json` defines. */
  private registeredServers(): RegisteredServers {
    const slots: ServerSlot[] = [];
    const overridden: string[] = [];

    for (const { name, config, extensionPath } of this.pi.getMcpServers()) {
      const configured = this.configured.find(
        (entry) => mcpNamespace(entry.name) === mcpNamespace(name)
      );

      if (configured) {
        overridden.push(
          `"${name}" registered by ${extensionPath} is overridden by "${configured.name}" in ${configured.source}`
        );
        continue;
      }

      const parsed = parseServerConfig(name, config);

      if (parsed.error !== undefined) {
        overridden.push(
          `"${name}" registered by ${extensionPath} is invalid: ${parsed.error}`
        );
        continue;
      }

      slots.push({
        entry: {
          name,
          config: parsed.value,
          source: extensionPath,
          scope: "extension",
        },
        registeredConfig: JSON.stringify(config),
      });
    }

    return { slots, overridden };
  }

  private resourceSlots(): ServerSlot[] {
    return this.slots.filter(
      (slot) =>
        slot.connection?.hasResources === true &&
        isEnabled(slot.entry) &&
        serverExposure(slot.entry.config) !== "hidden"
    );
  }

  private syncResources(): void {
    this.catalog.syncResources(this.resourceSlots());
  }

  private async caller(
    server: string,
    tool: string
  ): Promise<ServerConnection> {
    const slot = this.find(server);

    if (!slot || !isEnabled(slot.entry)) {
      throw new Error(`MCP server "${server}" is disabled.`);
    }

    const { connection } = slot;

    if (!connection) {
      throw new Error(`MCP server "${server}" is still starting.`);
    }

    const withdrawn =
      toolExposure(slot.entry.config, tool) === "hidden" ||
      (connection.state === "connected" &&
        !connection.tools.some((offered) => offered.name === tool));

    if (withdrawn) {
      throw new Error(`MCP tool "${server}/${tool}" is no longer available.`);
    }

    return connection;
  }

  private async createConnection(
    slot: ServerSlot,
    isCurrent: () => boolean
  ): Promise<ServerConnection | undefined> {
    const services = await this.loadServices();

    if (!isCurrent()) {
      return undefined;
    }

    services.auth.useModelRegistry(this.modelRegistry);

    const connection = new services.runtime.ServerConnection({
      entry: slot.entry,
      cwd: this.cwd,
      verdictKey: verdictKey(slot.entry),
      createTransport:
        this.options.createTransport ?? services.runtime.createTransport,
      auth: services.auth.connectionAuth(slot.entry),
      verdicts: services.verdicts,
      log: services.log,
      onTools: (current) => {
        if (!isCurrent()) {
          return;
        }

        this.catalog.register(slot.entry, current);
        this.syncResources();
      },
      onChange: (current) => {
        if (isCurrent()) {
          this.connectionChanged(current, services.auth);
        } else {
          this.tokensAtSignIn.delete(current);
        }
      },
    });

    slot.connection = connection;
    this.emitChange();

    return connection;
  }

  private connectionChanged(
    connection: ServerConnection,
    auth: SessionAuth
  ): void {
    if (connection.state !== "needs-auth") {
      this.tokensAtSignIn.delete(connection);
    } else if (!this.tokensAtSignIn.has(connection)) {
      this.tokensAtSignIn.set(connection, auth.storedTokens(connection.entry));
    }

    this.emitChange();
  }

  /**
   * Connect the server in the background, after `after`, unless it was disabled, replaced, or the
   * session ended meanwhile. `slot.ready` settles when it connected or failed; failures show in its
   * state. Rejects only when the runtime cannot be loaded.
   */
  private async startConnection(
    slot: ServerSlot,
    after?: Promise<unknown>
  ): Promise<void> {
    const { signal } = this.session;
    const attempt = Symbol("attempt");
    slot.attempt = attempt;

    const isCurrent = () =>
      !signal.aborted &&
      slot.attempt === attempt &&
      isEnabled(slot.entry) &&
      this.slots.includes(slot);

    const ready = (async () => {
      await after;

      if (!isCurrent()) {
        return;
      }

      const connection = await this.createConnection(slot, isCurrent);

      if (!connection || !isCurrent()) {
        return;
      }

      await connection.getClient().catch(() => undefined);
    })();

    slot.ready = ready.catch(() => undefined);

    await ready;
  }

  /** Wait for the latest connection attempts, including ones started while waiting, or an abort. */
  private async waitForServers(
    waiting: readonly ServerSlot[],
    signal: AbortSignal | undefined
  ): Promise<void> {
    for (;;) {
      const attempts = waiting.flatMap((slot) =>
        isEnabled(slot.entry) &&
        this.slots.includes(slot) &&
        slot.ready !== undefined
          ? [{ slot, ready: slot.ready }]
          : []
      );

      if (attempts.length === 0 || isAborted(signal)) {
        return;
      }

      const { aborted, release } = abortion(signal);

      try {
        await Promise.race([
          Promise.all(
            attempts.map(async (attempt) => {
              await attempt.ready;
            })
          ),
          aborted,
        ]);
      } finally {
        release();
      }

      const settled = attempts.every(
        ({ slot, ready }) =>
          !isEnabled(slot.entry) ||
          !this.slots.includes(slot) ||
          ready === slot.ready
      );

      if (isAborted(signal) || settled) {
        return;
      }
    }
  }

  private async waitForDirectServers(ctx: ExtensionContext): Promise<void> {
    if (this.waitedForStartup) {
      return;
    }

    this.waitedForStartup = true;

    const ready = this.slots.flatMap((slot) =>
      isEnabled(slot.entry) &&
      configuredExposures(slot.entry.config).has("direct") &&
      slot.ready !== undefined
        ? [slot.ready]
        : []
    );

    if (ready.length === 0) {
      return;
    }

    const timer = new AbortController();

    const finished = await Promise.race([
      Promise.all(ready).then(() => true),
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

  /** One message for everything that needs the user, or only for `only`, servers connected later. */
  private reportProblems(
    ctx: ExtensionContext,
    only?: readonly ServerSlot[]
  ): void {
    const lines =
      only === undefined
        ? this.configErrors.map((error) => `config: ${error}`)
        : [];

    for (const slot of only ?? this.slots) {
      const state = slot.connection?.state;

      if (state === "needs-auth" || state === "failed") {
        lines.push(`${slot.entry.name}: ${describeState(slot)}`);
      }
    }

    if (lines.length === 0) {
      return;
    }

    notify(
      ctx,
      `MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
      "warning"
    );
  }

  /**
   * Save a change to the file that defines the server, or with `inProject` to a project override.
   * Changes to registered servers apply to the session only. Resolves to an error message on failure.
   */
  private async saveConfig(
    slot: ServerSlot,
    patch: ServerConfigPatch,
    inProject = false
  ): Promise<string | undefined> {
    const override = inProject ? this.projectConfig : slot.entry.override;

    const entry =
      override === undefined ? slot.entry : { ...slot.entry, override };

    if (entry.scope !== "extension") {
      const path = entry.override ?? entry.source;

      try {
        await updateServerConfig(path, entry.name, patch, {
          override: entry.override !== undefined,
        });
      } catch (error) {
        return `Could not update ${path}: ${errorMessage(error)}`;
      }
    }

    slot.entry = { ...entry, config: { ...entry.config, ...patch } };

    return undefined;
  }
}
