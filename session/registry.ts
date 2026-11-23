import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mcpNamespace } from "@earendil-works/pi-mcp";

import { updateServerConfig } from "../config/edit.ts";
import type { ServerConfigPatch } from "../config/edit.ts";
import {
  configuredExposures,
  serverExposure,
  toolExposure,
} from "../config/exposure.ts";
import type { McpExposure } from "../config/exposure.ts";
import { loadConfig } from "../config/load.ts";
import type { ServerEntry } from "../config/load.ts";
import { isHttpConfig, parseServerConfig } from "../config/schema.ts";
import { ServerConnection } from "../connection/connection.ts";
import { ProtocolVerdicts } from "../connection/era.ts";
import { errorMessage } from "../connection/errors.ts";
import { ServerLog } from "../log.ts";
import type { McpPaths } from "../paths.ts";
import type { SessionAuth } from "./auth.ts";
import { ToolCatalog } from "./catalog.ts";
import { isEnabled } from "./status.ts";

/** A configured server and its connection. Disabled servers have none. */
export interface ServerSlot {
  entry: ServerEntry;
  connection?: ServerConnection | undefined;
  /** The failure of the last `/mcp` action, shown in the manager. */
  message?: string | undefined;
  /** For servers extensions registered: the config as registered, to notice re-registrations. */
  registeredConfig?: string | undefined;
  /** A disabled connection still closing, which a new one waits for. */
  closing?: Promise<void> | undefined;
}

/** What a session's servers need from outside. */
export interface RegistryOptions {
  readonly pi: ExtensionAPI;
  readonly paths: McpPaths;
  readonly auth: SessionAuth;
  /** Called when a current connection's state, error, or tools change. */
  readonly onConnectionChange: (connection: ServerConnection) => void;
}

/** Identifies a server's era verdict: its name and how it is reached. */
const verdictKey = (entry: ServerEntry): string => {
  const { config } = entry;

  return JSON.stringify(
    isHttpConfig(config)
      ? [entry.name, config.url]
      : [entry.name, config.command, config.args ?? [], config.cwd ?? ""]
  );
};

/**
 * The servers of one session: those of `mcp.json` and of `pi.registerMcpServer()`, with one
 * connection each and their tools in pi. A server in `mcp.json` takes precedence over a registered
 * one of the same name. Settings changed through `/mcp` are saved to the file that defines the
 * server; changes to registered servers last for the session.
 */
export class ServerRegistry {
  private readonly options: RegistryOptions;
  private readonly catalog: ToolCatalog;
  private readonly verdicts: ProtocolVerdicts;
  private readonly log: ServerLog;
  private readonly listeners = new Set<() => void>();
  private slots: ServerSlot[] = [];
  private configured: readonly ServerEntry[] = [];
  private overridden: readonly string[] = [];
  private cwd = process.cwd();
  /** Config errors of the loaded files. */
  configErrors: readonly string[] = [];
  /** The trusted project's `mcp.json`, where project overrides are saved. */
  projectConfig: string | undefined;
  autoEnableCodemode = true;

  constructor(options: RegistryOptions) {
    this.options = options;
    this.verdicts = new ProtocolVerdicts(options.paths.protocolVerdicts);
    this.log = new ServerLog(options.paths.log);
    this.catalog = new ToolCatalog(options.pi, {
      caller: async (server, tool) => await this.caller(server, tool),
      readableResources: (server) =>
        this.resourceSlots().some((slot) => slot.entry.name === server),
      resourceServers: () =>
        this.resourceSlots().flatMap((slot) =>
          slot.connection ? [slot.connection] : []
        ),
    });
  }

  get paths(): McpPaths {
    return this.options.paths;
  }

  get servers(): readonly ServerSlot[] {
    return this.slots;
  }

  find(name: string): ServerSlot | undefined {
    return this.slots.find((slot) => slot.entry.name === name);
  }

  includes(slot: ServerSlot): boolean {
    return this.slots.includes(slot);
  }

  /** Config errors and overridden registrations, for `/mcp`. */
  notices(): string[] {
    return [
      ...this.configErrors.map((error) => `config: ${error}`),
      ...this.overridden.map((line) => `overridden: ${line}`),
    ];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Every exposure the enabled servers' tools can have. */
  exposures(): ReadonlySet<McpExposure> {
    return new Set(
      this.slots.flatMap((slot) =>
        isEnabled(slot.entry) ? [...configuredExposures(slot.entry.config)] : []
      )
    );
  }

  /** Load the configuration of `cwd` and connect every enabled server in the background. */
  load(cwd: string, projectTrusted: boolean): void {
    const loaded = loadConfig(this.options.paths, cwd, projectTrusted);
    const registered = this.registered(loaded.servers);

    this.cwd = cwd;
    this.configured = loaded.servers;
    this.configErrors = loaded.errors;
    this.projectConfig = loaded.projectConfig;
    this.autoEnableCodemode = loaded.autoEnableCodemode;
    this.overridden = registered.overridden;
    this.slots = [
      ...loaded.servers.map((entry) => ({ entry })),
      ...registered.slots,
    ];

    for (const slot of this.slots) {
      if (isEnabled(slot.entry)) {
        this.connect(slot);
      }
    }

    this.emitChange();
  }

  /**
   * Connect servers registered since, and disconnect unregistered ones and ones registered again with
   * another config. Resolves to the servers that started connecting.
   */
  async syncRegistered(): Promise<ServerSlot[]> {
    const registered = this.registered(this.configured);

    const next = new Map(
      registered.slots.map((slot) => [slot.entry.name, slot])
    );

    const removed = this.slots.filter(
      (slot) =>
        slot.entry.scope === "extension" &&
        next.get(slot.entry.name)?.registeredConfig !== slot.registeredConfig
    );

    const added = registered.slots.filter(
      (slot) =>
        !this.slots.some((existing) => existing.entry.name === slot.entry.name)
    );

    this.overridden = registered.overridden;
    this.slots = [
      ...this.slots.filter((slot) => !removed.includes(slot)),
      ...added,
    ];

    for (const slot of removed) {
      this.catalog.hide(slot.entry.name);
    }

    this.syncResources();

    for (const slot of added) {
      if (isEnabled(slot.entry)) {
        this.connect(slot);
      }
    }

    this.emitChange();
    await Promise.all(
      removed.map(async (slot) => await slot.connection?.close())
    );

    return added.filter((slot) => slot.connection !== undefined);
  }

  /** Close every connection. */
  async close(): Promise<void> {
    const connections = this.slots.flatMap((slot) =>
      slot.connection ? [slot.connection] : []
    );

    this.slots = [];
    this.emitChange();
    await Promise.all(
      connections.map(async (connection) => {
        await connection.close();
      })
    );
  }

  /** Connect again. Resolves to an error message on failure. */
  async reconnect(slot: ServerSlot): Promise<string | undefined> {
    if (slot.connection === undefined || !this.includes(slot)) {
      return `MCP server "${slot.entry.name}" is disabled.`;
    }

    try {
      await slot.connection.reconnect();

      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /** Enable or disable a server, saved to its config. Resolves to an error message when saving failed. */
  async setEnabled(
    slot: ServerSlot,
    enabled: boolean,
    inProject = false
  ): Promise<string | undefined> {
    const failed = await this.save(slot, { enabled }, inProject);

    if (failed !== undefined) {
      return failed;
    }

    if (enabled) {
      await slot.closing;

      if (
        slot.connection === undefined &&
        isEnabled(slot.entry) &&
        this.includes(slot)
      ) {
        await this.connect(slot).settled();
      }

      return undefined;
    }

    const { connection } = slot;

    slot.connection = undefined;
    this.catalog.hide(slot.entry.name);
    this.syncResources();
    this.emitChange();

    if (connection !== undefined) {
      const closing = connection.close();

      slot.closing = closing;
      await closing;

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
    const failed = await this.save(slot, { exposure });

    if (failed !== undefined) {
      return failed;
    }

    if (slot.connection?.state === "connected") {
      this.catalog.register(slot.entry, slot.connection);
    }

    this.syncResources();

    const { pi } = this.options;

    const indirect = new Set(
      pi
        .getAllTools()
        .flatMap((tool) => (tool.exposure === "direct" ? [] : [tool.name]))
    );

    const tools = this.catalog.toolsOf(slot.entry.name);

    pi.setActiveTools(
      pi
        .getActiveTools()
        .filter((name) => !tools.has(name) || !indirect.has(name))
    );
    this.emitChange();

    return undefined;
  }

  /** The server whose tool has this pi name. */
  ownerOf(toolName: string): string | undefined {
    return this.catalog.ownerOf(toolName);
  }

  private connect(slot: ServerSlot): ServerConnection {
    const isCurrent = (connection: ServerConnection): boolean =>
      slot.connection === connection && this.includes(slot);

    const connection = new ServerConnection({
      entry: slot.entry,
      clientInfo: { name: "pi", version: VERSION },
      cwd: this.cwd,
      auth: this.options.auth.connectionAuth(slot.entry),
      verdicts: { store: this.verdicts, key: verdictKey(slot.entry) },
      log: this.log,
      onTools: (current) => {
        if (isCurrent(current)) {
          this.catalog.register(slot.entry, current);
          this.syncResources();
        }
      },
      onChange: (current) => {
        if (isCurrent(current)) {
          this.options.onConnectionChange(current);
          this.emitChange();
        }
      },
    });

    slot.connection = connection;
    connection.start();

    return connection;
  }

  /** Servers extensions registered, except names `configured` defines. */
  private registered(configured: readonly ServerEntry[]): {
    slots: ServerSlot[];
    overridden: string[];
  } {
    const slots: ServerSlot[] = [];
    const overridden: string[] = [];

    for (const {
      name,
      config,
      extensionPath,
    } of this.options.pi.getMcpServers()) {
      const shadowing = configured.find(
        (entry) => mcpNamespace(entry.name) === mcpNamespace(name)
      );

      const parsed = parseServerConfig(name, config);

      if (shadowing !== undefined) {
        overridden.push(
          `"${name}" registered by ${extensionPath} is overridden by "${shadowing.name}" in ${shadowing.source}`
        );
      } else if (parsed.error === undefined) {
        slots.push({
          entry: {
            name,
            config: parsed.value,
            source: extensionPath,
            scope: "extension",
          },
          registeredConfig: JSON.stringify(config),
        });
      } else {
        overridden.push(
          `"${name}" registered by ${extensionPath} is invalid: ${parsed.error}`
        );
      }
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

    if (slot === undefined || !isEnabled(slot.entry)) {
      throw new Error(`MCP server "${server}" is disabled.`);
    }

    const { connection } = slot;

    if (connection === undefined) {
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

  /**
   * Save a change to the file that defines the server, or with `inProject` to a project override.
   * Changes to registered servers apply to the session only. Resolves to an error message on failure.
   */
  private async save(
    slot: ServerSlot,
    patch: ServerConfigPatch,
    inProject = false
  ): Promise<string | undefined> {
    const override = inProject ? this.projectConfig : slot.entry.override;

    const entry =
      override === undefined ? slot.entry : { ...slot.entry, override };

    if (entry.scope !== "extension") {
      const file = entry.override ?? entry.source;

      try {
        await updateServerConfig(file, entry.name, patch, {
          override: entry.override !== undefined,
        });
      } catch (error) {
        return `Could not update ${file}: ${errorMessage(error)}`;
      }
    }

    slot.entry = { ...entry, config: { ...entry.config, ...patch } };

    return undefined;
  }
}
