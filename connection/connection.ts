import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  Client,
  METHOD_NOT_FOUND,
  ProtocolError,
} from "@modelcontextprotocol/client";
import type {
  AuthProvider,
  CallToolRequestParams,
  CallToolResult,
  FetchLike,
  Implementation,
  ListResourcesResult,
  ListResourceTemplatesResult,
  McpSubscription,
  OAuthClientProvider,
  PriorDiscovery,
  Progress,
  ProtocolEra,
  ReadResourceResult,
  RequestOptions,
  Tool,
} from "@modelcontextprotocol/client";
import {
  SkillsClient,
  SkillVerificationError,
} from "@modelcontextprotocol/client/ext/skills";
import type { Skill, SkillFile } from "@modelcontextprotocol/client/ext/skills";
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
import { createTransport } from "./transport.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2000;
const CONNECT_RETRY_DELAYS_MS = [250, 1000];
const RELISTEN_DELAYS_MS = [1000, 5000, 30_000];

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

/** The server a connection reaches: its name and `mcp.json` entry. */
export type ServerTarget = Pick<ServerEntry, "name" | "config">;

/** How a connection authenticates, when it does. */
export interface ConnectionAuth {
  /** Sends credentials; an `OAuthClientProvider` lets the SDK refresh its tokens. */
  readonly provider: AuthProvider | OAuthClientProvider;
  /** Set for servers that sign in with OAuth through this extension. */
  readonly oauth?: OAuthConnectionAuth | undefined;
  /** Tells the user how to sign in, such as "Run /mcp to sign in." */
  readonly signInHint: string;
}

/** Options of a request to a server. */
export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: Progress) => void) | undefined;
}

export interface ConnectionOptions {
  readonly entry: ServerTarget;
  /** How the client introduces itself to the server. */
  readonly clientInfo: Implementation;
  /** Offered to the server as its root, and where stdio servers start. Without it the client offers no roots. */
  readonly cwd?: string | undefined;
  readonly auth: ConnectionAuth | undefined;
  /** Makes the HTTP requests of `url` servers; the global `fetch` without it. */
  readonly fetch?: FetchLike | undefined;
  /** Where the server's protocol era is remembered, under `key`. Without it every connect probes. */
  readonly verdicts?:
    | { readonly store: ProtocolVerdicts; readonly key: string }
    | undefined;
  readonly log: ServerLog | undefined;
  /** Called when the server's tools were listed, at connect and after it announced a change. */
  readonly onTools?: ((connection: ServerConnection) => void) | undefined;
  /** Called when the server's skills were listed, after each tool listing, or an entry was refreshed by `readSkill`. */
  readonly onSkills?: ((connection: ServerConnection) => void) | undefined;
  /** Called when `state`, `error`, `tools`, or `skills` change. */
  readonly onChange?: ((connection: ServerConnection) => void) | undefined;
}

const ignore = (): undefined => undefined;

const hasChallengeDetails = (challenge: OAuthChallenge): boolean =>
  (challenge.scope ?? "") !== "" ||
  (challenge.resourceMetadataUrl ?? "") !== "";

const pageParams = (cursor: string | undefined): { cursor?: string } =>
  cursor === undefined ? {} : { cursor };

/**
 * One configured server, on the official SDK client. The protocol era is negotiated at connect
 * (`protocol` in the config) and remembered in `verdicts`. A dropped connection reconnects on the
 * next call; on the 2026-07-28 era a dropped subscription stream is opened again.
 */
export class ServerConnection {
  readonly entry: ServerTarget;
  state: ConnectionState = "connecting";
  error: string | undefined;
  tools: Tool[] = [];
  /**
   * The server's skills (the MCP Skills extension, SEP-2640), listed with the tools; none when the
   * server does not declare the extension. Entries the SDK finds invalid are left out.
   */
  skills: Skill[] = [];
  /** Whether the server offers resources. They are listed on demand, since listing can take long. */
  hasResources = false;
  /** The server's instructions, describing its tools as a group. */
  instructions: string | undefined;
  era: ProtocolEra | undefined;
  protocolVersion: string | undefined;
  private client: Client | undefined;
  private opening: Promise<Client> | undefined;
  private reconnecting: Promise<void> | undefined;
  private readonly shutdown = new AbortController();
  private stderrTail = "";
  private skillListings = 0;
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

  private get closed(): boolean {
    return this.shutdown.signal.aborted;
  }

  /** Start connecting in the background; the state shows how it went. */
  start(): void {
    this.getClient().catch(ignore);
  }

  /** Resolves once no connect or reconnect is in progress, however it ended. */
  async settled(): Promise<void> {
    for (
      let work = this.reconnecting ?? this.opening;
      work !== undefined;
      work = this.reconnecting ?? this.opening
    ) {
      await work.catch(ignore);
    }
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

  /** Connect again, for example after a sign-in. Concurrent calls share one reconnect. */
  async reconnect(): Promise<void> {
    this.reconnecting ??= (async () => {
      await this.opening?.catch(ignore);

      if (this.client !== undefined) {
        await this.dropClient(this.client);
      }

      await this.getClient();
    })().finally(() => {
      this.reconnecting = undefined;
    });

    await this.reconnecting;
  }

  /** Disconnect after the stored credentials were removed. */
  async signOut(): Promise<void> {
    await this.settled();

    if (this.client !== undefined) {
      await this.dropClient(this.client);
    }

    if (!this.closed) {
      this.markNeedsAuth(undefined);
    }
  }

  /** Forget the challenge a sign-in answered. */
  clearChallenge(): void {
    this.options.auth?.oauth?.setChallenge(undefined);
  }

  /** Resolves once no transport of this server is open, and refreshed tokens are saved. */
  async close(): Promise<void> {
    this.shutdown.abort();
    this.state = "closed";
    this.changed();

    const { client } = this;

    this.client = undefined;
    await Promise.all([client?.close().catch(ignore), this.settled()]);
    await this.options.auth?.oauth?.settled();
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

  /**
   * One page of the server's resources. The SDK's `listResources()` walks every page unless given a
   * cursor, so the first page is requested directly.
   */
  async listResources(
    cursor: string | undefined,
    options: CallOptions
  ): Promise<ListResourcesResult> {
    return await this.withClient(async (client) => {
      if (client.getServerCapabilities()?.resources === undefined) {
        return { resources: [] };
      }

      return await client.request(
        { method: "resources/list", params: pageParams(cursor) },
        this.requestOptions(options)
      );
    }, true);
  }

  /** One page of the server's resource templates; servers without `resources/templates/list` have none. */
  async listResourceTemplates(
    cursor: string | undefined,
    options: CallOptions
  ): Promise<ListResourceTemplatesResult> {
    return await this.withClient(async (client) => {
      if (client.getServerCapabilities()?.resources === undefined) {
        return { resourceTemplates: [] };
      }

      try {
        return await client.request(
          { method: "resources/templates/list", params: pageParams(cursor) },
          this.requestOptions(options)
        );
      } catch (error) {
        if (error instanceof ProtocolError && error.code === METHOD_NOT_FOUND) {
          return { resourceTemplates: [] };
        }

        throw error;
      }
    }, true);
  }

  /**
   * Read the skill's `SKILL.md`, or the file at `ref` (a path under the skill's root or a URI the
   * entry lists), checked against `entry`. When the check fails, the entry is fetched again with
   * `skills/get` and the file read once more; a second failure throws `SkillVerificationError`.
   */
  async readSkill(
    entry: Skill,
    ref?: string,
    options: CallOptions = {}
  ): Promise<SkillFile> {
    return await this.withClient(async (client) => {
      const skills = new SkillsClient(client);
      const request = this.requestOptions(options);

      try {
        return await skills.read(entry, ref, request);
      } catch (error) {
        if (!(error instanceof SkillVerificationError)) {
          throw error;
        }
      }

      const { skill } = await skills.get(entry.uri, request);

      this.skillRefreshed(client, skill);

      return await skills.read(skill, ref, request);
    }, true);
  }

  private requestOptions(options: CallOptions): RequestOptions {
    return {
      timeout: this.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  }

  /**
   * Run a request, connecting when needed. Read-only requests are retried once after a transient
   * HTTP error; tool calls are not, since they may have run.
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
          // A 2025-era server that forgot the session (restart, deploy) did not run the request, so
          // retry once on a new session. The old client is detached, not closed: closing it would
          // fail its other in-flight requests, which get the same 404 and retry the same way.
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
    const hint = this.options.auth?.signInHint;
    const message = `MCP server "${this.name}" requires sign-in.`;

    return hint === undefined ? message : `${message} ${hint}`;
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
    this.options.onChange?.(this);
  }

  private async dropClient(client: Client): Promise<void> {
    if (this.client === client) {
      this.client = undefined;
    }

    await client.close().catch(ignore);
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
          ignore
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

    const { verdicts } = this.options;

    const prior =
      preference === "auto" ? verdicts?.store.prior(verdicts.key) : undefined;

    if (prior === undefined) {
      return await this.connectOnce(undefined);
    }

    try {
      return await this.connectOnce(prior);
    } catch (error) {
      if (this.closed || this.signInChallenge(error) !== undefined) {
        throw error;
      }

      verdicts?.store.forget(verdicts.key);

      return await this.connectOnce(undefined);
    }
  }

  private createClient(): Client {
    const negotiation = versionNegotiation(
      this.entry.config.protocol ?? "auto",
      !isHttpConfig(this.entry.config)
    );

    const { cwd } = this.options;

    const client: Client = new Client(this.options.clientInfo, {
      ...(cwd === undefined ? {} : { capabilities: { roots: {} } }),
      ...(negotiation === undefined ? {} : { versionNegotiation: negotiation }),
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            this.toolsChanged(client, error, tools);
          },
        },
      },
    });

    if (cwd !== undefined) {
      const root = { uri: pathToFileURL(cwd).href, name: path.basename(cwd) };

      client.setRequestHandler("roots/list", () => ({ roots: [root] }));
    }

    const { log } = this.options;

    if (log !== undefined) {
      client.setNotificationHandler("notifications/message", (notification) => {
        log.write(this.name, notification.params);
      });
    }

    return client;
  }

  private async listTools(client: Client): Promise<Tool[]> {
    // The SDK returns no tools for servers without the tools capability too, but logs to the
    // console, which pi's terminal would show.
    if (client.getServerCapabilities()?.tools === undefined) {
      return [];
    }

    const result = await client.listTools(undefined, {
      timeout: this.timeoutMs,
      signal: this.shutdown.signal,
    });

    return result.tools;
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
    this.options.onTools?.(this);
    this.changed();
  }

  private async connectOnce(
    prior: PriorDiscovery | undefined
  ): Promise<Client> {
    const client = this.createClient();
    let closing: Promise<void> | undefined;

    const closeClient = (): void => {
      closing ??= client.close().catch(ignore);
    };

    this.shutdown.signal.addEventListener("abort", closeClient, { once: true });
    this.stderrTail = "";

    try {
      const transport = createTransport(this.entry, {
        cwd: this.options.cwd,
        auth: this.options.auth?.provider,
        fetch: this.options.fetch,
      });

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
        const discover = client.getDiscoverResult();

        this.options.verdicts?.store.record(
          this.options.verdicts.key,
          discover === undefined
            ? { kind: "legacy" }
            : { kind: "modern", discover }
        );
      }

      this.connected(client, tools);
      await this.listSkills(client);

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
      { cause: error }
    );
  }

  /** The client stopped serving: the next call reconnects; until then the state shows why. */
  private disconnected(client: Client, reason: string): void {
    if (this.client !== client || this.closed) {
      return;
    }

    this.client = undefined;
    this.state = "disconnected";
    this.error = this.withStderr(reason);
    this.changed();
  }

  private handleClose(client: Client): void {
    this.disconnected(client, "Connection closed");
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
      this.options.onTools?.(this);
      void this.listSkills(client);
    }

    this.changed();
  }

  /**
   * List the skills on `client`. A failure leaves the last listing in place and does not fail the
   * connection, since its tools still work; a listing that a newer one overtook is dropped.
   */
  private async listSkills(client: Client): Promise<void> {
    this.skillListings += 1;

    const listing = this.skillListings;
    let listed: Skill[] | undefined;
    let failure = "";

    try {
      ({ skills: listed } = await new SkillsClient(client, {
        skipInvalid: true,
      }).list(undefined, {
        timeout: this.timeoutMs,
        signal: this.shutdown.signal,
      }));
    } catch (error) {
      failure = errorMessage(error);
    }

    if (
      listing !== this.skillListings ||
      this.client !== client ||
      this.closed
    ) {
      return;
    }

    if (listed === undefined) {
      this.error = `Failed to list skills: ${failure}`;
    } else {
      this.skills = listed;
      this.options.onSkills?.(this);
    }

    this.changed();
  }

  /** Put an entry `readSkill` fetched again in place of the listed one. */
  private skillRefreshed(client: Client, skill: Skill): void {
    const index = this.skills.findIndex((listed) => listed.uri === skill.uri);

    if (index === -1 || this.client !== client || this.closed) {
      return;
    }

    this.skills = this.skills.with(index, skill);
    this.options.onSkills?.(this);
    this.changed();
  }

  /**
   * On the 2026-07-28 era change notifications arrive on a `subscriptions/listen` stream, which
   * the SDK does not reopen when it drops; reopen it, then list the tools to catch missed changes.
   * When it cannot be reopened, the connection counts as dropped, so the next call reconnects.
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

    let failure = "";

    for (const delay of RELISTEN_DELAYS_MS) {
      await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(
        ignore
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
      } catch (error) {
        failure = errorMessage(error);
      }
    }

    this.disconnected(client, `Change notifications stopped: ${failure}`);
    await client.close().catch(ignore);
  }
}
