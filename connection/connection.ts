import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  Client,
  METHOD_NOT_FOUND,
  ProtocolError,
} from "@modelcontextprotocol/client";
import type {
  AuthProvider,
  CallToolRequestParams,
  CallToolResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  McpSubscription,
  PriorDiscovery,
  Progress,
  ProtocolEra,
  ReadResourceResult,
  RequestOptions,
  Resource,
  Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { ServerEntry } from "../config/load.ts";
import { isHttpConfig } from "../config/schema.ts";
import type { ServerLog } from "../log.ts";
import type { OAuthConnectionAuth } from "../oauth/connection-auth.ts";
import type { OAuthChallenge } from "../oauth/errors.ts";
import { versionNegotiation } from "./era.ts";
import type { ProtocolVerdicts } from "./era.ts";
import {
  errorMessage,
  isSessionExpired,
  isTransientError,
  signInChallenge,
} from "./errors.ts";
import type { TransportFactory } from "./transport.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2000;
const CONNECT_RETRY_DELAYS_MS = [250, 1000];
const RELISTEN_DELAYS_MS = [1000, 5000, 30_000];

/** A resource template as servers list it. */
export type ResourceTemplate =
  ListResourceTemplatesResult["resourceTemplates"][number];

/** Arguments of a tool call. */
export type ToolArguments = NonNullable<CallToolRequestParams["arguments"]>;

/**
 * - `disconnected`: the connection dropped, for example the stdio server exited; the next call reconnects.
 * - `needs-auth`: the server rejected the stored credentials and the user has to sign in.
 */
export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "needs-auth"
  | "failed"
  | "closed";

/** How a connection authenticates, when it does. */
export interface ConnectionAuth {
  readonly provider: AuthProvider;
  /** Set for servers that sign in with OAuth. */
  readonly oauth?: OAuthConnectionAuth | undefined;
  /** What the user runs to sign in: `/mcp`, or `/login <provider>`. */
  readonly signInCommand: string;
}

/** Options of a request to a server. */
export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: Progress) => void) | undefined;
}

export interface ConnectionOptions {
  readonly entry: ServerEntry;
  readonly cwd: string;
  readonly verdictKey: string;
  readonly createTransport: TransportFactory;
  readonly auth: ConnectionAuth | undefined;
  readonly verdicts: ProtocolVerdicts;
  readonly log: ServerLog | undefined;
  /** Called when the server's tools were listed, at connect and after it announced a change. */
  readonly onTools: (connection: ServerConnection) => void;
  /** Called when `state`, `error`, or `tools` change. */
  readonly onChange: (connection: ServerConnection) => void;
}

const EMPTY_TEMPLATES: ListResourceTemplatesResult = { resourceTemplates: [] };

/** Servers that do not implement `resources/templates/list` have no templates. */
const withoutTemplates = async (
  list: () => Promise<ListResourceTemplatesResult>
): Promise<ListResourceTemplatesResult> => {
  try {
    return await list();
  } catch (error) {
    if (error instanceof ProtocolError && error.code === METHOD_NOT_FOUND) {
      return EMPTY_TEMPLATES;
    }

    throw error;
  }
};

const pageParams = (cursor: string | undefined): { cursor?: string } =>
  cursor === undefined ? {} : { cursor };

const hasChallengeDetails = (challenge: OAuthChallenge): boolean =>
  (challenge.scope ?? "") !== "" ||
  (challenge.resourceMetadataUrl ?? "") !== "";

/**
 * One configured server, on the official SDK client. The protocol era is negotiated at connect
 * (`protocol` in the config) and remembered in `verdicts`. A dropped connection reconnects on the
 * next call; on the 2026-07-28 era a dropped subscription stream is opened again.
 */
export class ServerConnection {
  readonly entry: ServerEntry;
  state: ConnectionState = "connecting";
  error: string | undefined;
  tools: Tool[] = [];
  /** Whether the server offers resources. They are listed on demand, since listing can take long. */
  hasResources = false;
  /** The server's instructions, describing its tools as a group. */
  instructions: string | undefined;
  era: ProtocolEra | undefined;
  protocolVersion: string | undefined;
  private client: Client | undefined;
  private opening: Promise<Client> | undefined;
  private readonly shutdown = new AbortController();
  private stderrTail = "";
  private readonly options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.entry = options.entry;
  }

  get name(): string {
    return this.entry.name;
  }

  get timeoutMs(): number {
    return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  /** The server URL when the server signs in with OAuth. */
  get oauthUrl(): string | undefined {
    return this.options.auth?.oauth !== undefined &&
      isHttpConfig(this.entry.config)
      ? this.entry.config.url
      : undefined;
  }

  get challenge(): OAuthChallenge | undefined {
    return this.options.auth?.oauth?.challenge;
  }

  /** Forget the challenge a sign-in answered. */
  clearChallenge(): void {
    this.options.auth?.oauth?.setChallenge(undefined);
  }

  private get closed(): boolean {
    return this.shutdown.signal.aborted;
  }

  async getClient(): Promise<Client> {
    if (this.closed) {
      throw new Error(`MCP server "${this.name}" is shut down`);
    }

    if (this.client !== undefined) {
      return this.client;
    }

    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });

    return await this.opening;
  }

  async callTool(
    name: string,
    args: ToolArguments,
    options: CallOptions
  ): Promise<CallToolResult> {
    return await this.withClient(
      async (client) =>
        await client.callTool(
          { name, arguments: args },
          {
            ...this.requestOptions(options),
            resetTimeoutOnProgress: true,
            ...(options.onProgress === undefined
              ? {}
              : { onprogress: options.onProgress }),
          }
        )
    );
  }

  async readResource(
    uri: string,
    options: CallOptions
  ): Promise<ReadResourceResult> {
    return await this.withClient(
      async (client) =>
        await client.readResource({ uri }, this.requestOptions(options)),
      true
    );
  }

  async resourcesPage(
    cursor: string | undefined,
    options: CallOptions
  ): Promise<ListResourcesResult> {
    return await this.withClient(
      async (client) =>
        await client.listResources(
          pageParams(cursor),
          this.requestOptions(options)
        ),
      true
    );
  }

  async resourceTemplatesPage(
    cursor: string | undefined,
    options: CallOptions
  ): Promise<ListResourceTemplatesResult> {
    return await this.withClient(
      async (client) =>
        await withoutTemplates(
          async () =>
            await client.listResourceTemplates(
              pageParams(cursor),
              this.requestOptions(options)
            )
        ),
      true
    );
  }

  async allResources(options: CallOptions): Promise<Resource[]> {
    const result = await this.withClient(
      async (client) =>
        await client.listResources(undefined, this.requestOptions(options)),
      true
    );

    return result.resources;
  }

  async allResourceTemplates(
    options: CallOptions
  ): Promise<ResourceTemplate[]> {
    const result = await this.withClient(
      async (client) =>
        await withoutTemplates(
          async () =>
            await client.listResourceTemplates(
              undefined,
              this.requestOptions(options)
            )
        ),
      true
    );

    return result.resourceTemplates;
  }

  /** Connect again, for example after a sign-in. */
  async reconnect(): Promise<void> {
    await this.opening?.catch(() => undefined);

    if (this.client !== undefined) {
      await this.dropClient(this.client);
    }

    await this.getClient();
  }

  /** Disconnect after the stored credentials were removed. */
  async signOut(): Promise<void> {
    await this.opening?.catch(() => undefined);

    if (this.client !== undefined) {
      await this.dropClient(this.client);
    }

    if (!this.closed) {
      this.markNeedsAuth(undefined);
    }
  }

  /** Resolves once no transport of this server is open, and refreshed tokens are saved. */
  async close(): Promise<void> {
    this.shutdown.abort();
    this.state = "closed";
    this.changed();

    const { client } = this;

    this.client = undefined;
    await Promise.all([
      client?.close().catch(() => undefined),
      this.opening?.catch(() => undefined),
    ]);
    await this.options.auth?.oauth?.settled();
  }

  private requestOptions(options: CallOptions): RequestOptions {
    return {
      timeout: this.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  }

  /**
   * Run a request, connecting when needed. Read-only requests are retried once after a transient
   * HTTP error; tool calls are not, since they may have run. A 2025-era HTTP session the server
   * forgot did not run the request, so it is retried once on a new session.
   */
  private async withClient<T>(
    run: (client: Client) => Promise<T>,
    readOnly = false
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const client = await this.getClient();

      try {
        return await run(client);
      } catch (error) {
        if (attempt === 1 && readOnly && isTransientError(error)) {
          await sleep(CONNECT_RETRY_DELAYS_MS[0]);
          continue;
        }

        if (attempt === 1 && this.era === "legacy" && isSessionExpired(error)) {
          if (this.client === client) {
            this.client = undefined;
          }

          continue;
        }

        const challenge = this.signInChallenge(error);

        if (challenge === undefined) {
          throw error;
        }

        await this.dropClient(client);
        this.markNeedsAuth(challenge);

        throw new Error(this.signInRequiredMessage(), { cause: error });
      }
    }
  }

  private signInChallenge(error: unknown): OAuthChallenge | undefined {
    return this.options.auth === undefined ? undefined : signInChallenge(error);
  }

  private signInRequiredMessage(): string {
    const command = this.options.auth?.signInCommand ?? "/mcp";

    return `MCP server "${this.name}" requires sign-in. Run ${command} to sign in.`;
  }

  private markNeedsAuth(challenge: OAuthChallenge | undefined): void {
    if (challenge !== undefined && hasChallengeDetails(challenge)) {
      this.options.auth?.oauth?.setChallenge(challenge);
    }

    this.state = "needs-auth";
    this.error = undefined;
    this.changed();
  }

  private changed(): void {
    this.options.onChange(this);
  }

  private async dropClient(client: Client): Promise<void> {
    if (this.client === client) {
      this.client = undefined;
    }

    await client.close().catch(() => undefined);
  }

  private async open(): Promise<Client> {
    this.state = "connecting";
    this.changed();

    const retries = isHttpConfig(this.entry.config)
      ? CONNECT_RETRY_DELAYS_MS
      : [];

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.connectWithVerdict();
      } catch (error) {
        const delay = retries[attempt];

        if (this.closed || delay === undefined || !isTransientError(error)) {
          throw this.connectFailed(error);
        }

        await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(
          () => undefined
        );

        if (this.closed) {
          throw this.connectFailed(error);
        }
      }
    }
  }

  /** Connect with the remembered era verdict; when that fails, probe again. */
  private async connectWithVerdict(): Promise<Client> {
    const preference = this.entry.config.protocol ?? "auto";

    const prior =
      preference === "auto"
        ? this.options.verdicts.prior(this.options.verdictKey)
        : undefined;

    if (prior === undefined) {
      return await this.connectOnce(undefined);
    }

    try {
      return await this.connectOnce(prior);
    } catch (error) {
      if (this.closed || this.signInChallenge(error) !== undefined) {
        throw error;
      }

      this.options.verdicts.forget(this.options.verdictKey);

      return await this.connectOnce(undefined);
    }
  }

  private createClient(): Client {
    const preference = this.entry.config.protocol ?? "auto";

    const negotiation = versionNegotiation(
      preference,
      !isHttpConfig(this.entry.config)
    );

    const client: Client = new Client(
      { name: "pi", version: VERSION },
      {
        capabilities: { roots: {} },
        ...(negotiation === undefined
          ? {}
          : { versionNegotiation: negotiation }),
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              this.toolsChanged(client, error, tools);
            },
          },
        },
      }
    );

    const root = {
      uri: pathToFileURL(this.options.cwd).href,
      name: path.basename(this.options.cwd),
    };

    client.setRequestHandler("roots/list", () => ({ roots: [root] }));

    const { log } = this.options;

    if (log !== undefined) {
      client.setNotificationHandler("notifications/message", (notification) => {
        log.write(this.name, notification.params);
      });
    }

    return client;
  }

  private rememberVerdict(client: Client): void {
    const discover = client.getDiscoverResult();

    this.options.verdicts.record(
      this.options.verdictKey,
      discover === undefined ? { kind: "legacy" } : { kind: "modern", discover }
    );
  }

  private connected(client: Client, tools: Tool[]): void {
    const instructions = client.getInstructions()?.trim() ?? "";

    this.client = client;
    this.tools = tools;
    this.hasResources = client.getServerCapabilities()?.resources !== undefined;
    this.instructions = instructions === "" ? undefined : instructions;
    this.era = client.getProtocolEra();
    this.protocolVersion = client.getNegotiatedProtocolVersion();
    this.state = "connected";
    this.error = undefined;
    this.options.onTools(this);
    this.changed();
  }

  private async listTools(client: Client): Promise<Tool[]> {
    if (client.getServerCapabilities()?.tools === undefined) {
      return [];
    }

    const result = await client.listTools(undefined, {
      timeout: this.timeoutMs,
      signal: this.shutdown.signal,
    });

    return result.tools;
  }

  private async connectOnce(
    prior: PriorDiscovery | undefined
  ): Promise<Client> {
    const client = this.createClient();
    let closing: Promise<void> | undefined;

    const closeClient = (): void => {
      closing ??= client.close().catch(() => undefined);
    };

    this.shutdown.signal.addEventListener("abort", closeClient, { once: true });
    this.stderrTail = "";

    try {
      const transport = this.options.createTransport(
        this.entry,
        this.options.cwd,
        this.options.auth?.provider
      );

      if (transport instanceof StdioClientTransport) {
        this.collectStderr(transport);
      }

      await client.connect(transport, {
        signal: this.shutdown.signal,
        timeout: this.timeoutMs,
        ...(prior === undefined ? {} : { prior }),
      });
      client.onclose = () => {
        this.handleClose(client);
      };

      const tools = await this.listTools(client);

      if (this.closed) {
        throw new Error("shut down while connecting");
      }

      if (
        prior === undefined &&
        (this.entry.config.protocol ?? "auto") === "auto"
      ) {
        this.rememberVerdict(client);
      }

      this.connected(client, tools);

      if (this.era === "modern") {
        void this.watchSubscription(client, client.autoOpenedSubscription);
      }

      return client;
    } catch (error) {
      closeClient();
      await closing;

      throw error;
    } finally {
      this.shutdown.signal.removeEventListener("abort", closeClient);
    }
  }

  private collectStderr(transport: StdioClientTransport): void {
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();

      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      this.options.log?.writeStderr(this.name, text);
    });
  }

  private withStderr(message: string): string {
    const tail = this.stderrTail.trim();

    return tail === "" ? message : `${message}\n${tail}`;
  }

  private connectFailed(error: unknown): Error {
    const challenge = this.signInChallenge(error);

    if (challenge !== undefined && !this.closed) {
      this.markNeedsAuth(challenge);

      return new Error(this.signInRequiredMessage(), { cause: error });
    }

    this.state = this.closed ? "closed" : "failed";
    this.error = this.withStderr(errorMessage(error));
    this.changed();

    return new Error(
      `MCP server "${this.name}" failed to connect: ${this.error}`,
      {
        cause: error,
      }
    );
  }

  private handleClose(client: Client): void {
    if (this.client !== client || this.closed) {
      return;
    }

    this.client = undefined;
    this.state = "disconnected";
    this.error = this.withStderr("Connection closed");
    this.changed();
  }

  private toolsChanged(
    client: Client,
    error: Error | null,
    tools: Tool[] | null
  ): void {
    if (this.client !== client || this.closed) {
      return;
    }

    if (error !== null) {
      this.error = `Failed to refresh tools: ${error.message}`;
    } else if (tools !== null) {
      this.tools = tools;
      this.options.onTools(this);
    }

    this.changed();
  }

  /**
   * On the 2026-07-28 era change notifications arrive on a `subscriptions/listen` stream, which
   * the SDK does not reopen when it drops; reopen it, then list the tools to catch missed changes.
   */
  private async watchSubscription(
    client: Client,
    subscription: McpSubscription | undefined
  ): Promise<void> {
    if (
      subscription === undefined ||
      (await subscription.closed) !== "remote"
    ) {
      return;
    }

    for (const delay of RELISTEN_DELAYS_MS) {
      await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(
        () => undefined
      );

      if (this.client !== client || this.closed) {
        return;
      }

      try {
        const next = await client.listen(
          { toolsListChanged: true },
          { signal: this.shutdown.signal }
        );

        const { tools } = await client.listTools(undefined, {
          cacheMode: "refresh",
          timeout: this.timeoutMs,
        });

        this.toolsChanged(client, null, tools);
        void this.watchSubscription(client, next);

        return;
      } catch {
        continue;
      }
    }
  }
}
