import { once } from "node:events";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ServerConnection } from "../../connection/connection.ts";
import { ProtocolVerdicts } from "../../connection/era.ts";
import type { SignInPrompt } from "../../oauth/sign-in.ts";
import { SessionAuth } from "../../session/auth.ts";
import { fixtureEntry, temporaryDirectory } from "../fixtures/connection.ts";
import { startOAuthServer } from "../fixtures/oauth-server.ts";
import type { OAuthFixture } from "../fixtures/oauth-server.ts";

const cleanups: Array<() => Promise<void> | void> = [];

const cleanUp = async (): Promise<void> => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
};

/** A browser that approves at once: it follows the authorization redirect to the loopback callback. */
const approvingBrowser = (): SignInPrompt & {
  readonly opened: () => number;
} => {
  let opened = 0;

  return {
    opened: () => opened,
    showAuthorizationUrl: (url) => {
      opened += 1;
      void (async () => {
        const authorize = await fetch(url, { redirect: "manual" });

        await fetch(authorize.headers.get("location") ?? "");
      })();
    },
    promptForRedirectUrl: async (signal) => {
      if (!signal.aborted) {
        await once(signal, "abort");
      }

      return undefined;
    },
  };
};

const setUp = async (): Promise<{
  readonly oauth: OAuthFixture;
  readonly auth: SessionAuth;
  readonly connection: ServerConnection;
  readonly entry: ReturnType<typeof fixtureEntry>;
}> => {
  const { dir, dispose } = temporaryDirectory();
  const oauth = await startOAuthServer();
  const auth = new SessionAuth(path.join(dir, "auth"));
  const entry = fixtureEntry({ url: oauth.url });

  const connection = new ServerConnection({
    entry,
    cwd: dir,
    verdictKey: "fixture",
    auth: auth.connectionAuth(entry),
    verdicts: new ProtocolVerdicts(path.join(dir, "protocol.json")),
    log: undefined,
    onTools: () => undefined,
    onChange: () => undefined,
  });

  cleanups.push(dispose, oauth.close, async () => {
    await connection.close();
  });

  return { oauth, auth, connection, entry };
};

describe("OAuth sign-in", () => {
  afterEach(cleanUp);

  it("needs a sign-in, signs in with dynamic registration and PKCE, then connects", async () => {
    const { auth, connection, entry, oauth } = await setUp();

    await expect(connection.getClient()).rejects.toThrow(/requires sign-in/u);
    expect(connection.state).toBe("needs-auth");
    expect(connection.challenge?.resourceMetadataUrl).toBe(
      `${oauth.base}/.well-known/oauth-protected-resource/mcp`
    );

    const browser = approvingBrowser();

    await auth.signIn(
      entry,
      connection.challenge,
      browser,
      new AbortController().signal
    );
    await connection.reconnect();

    expect(browser.opened()).toBe(1);
    expect(connection.state).toBe("connected");
    expect(connection.era).toBe("modern");
    expect(oauth.tokenRequests()).toStrictEqual(["authorization_code"]);
  });

  it("refreshes a rejected access token without a new sign-in", async () => {
    const { auth, connection, entry, oauth } = await setUp();

    await connection.getClient().catch(() => undefined);
    await auth.signIn(
      entry,
      connection.challenge,
      approvingBrowser(),
      new AbortController().signal
    );
    await connection.reconnect();

    const before = auth.storedTokens(entry);

    oauth.expireAccessTokens();

    const result = await connection.callTool(
      "echo",
      { text: "after refresh" },
      {}
    );

    expect(result.content[0]).toMatchObject({ text: "after refresh" });
    expect(oauth.tokenRequests()).toStrictEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(auth.storedTokens(entry)).not.toBe(before);
  });

  it("signs out by deleting the stored credentials", async () => {
    const { auth, connection, entry } = await setUp();

    await connection.getClient().catch(() => undefined);
    await auth.signIn(
      entry,
      connection.challenge,
      approvingBrowser(),
      new AbortController().signal
    );

    await expect(auth.signOut(entry)).resolves.toBe(true);
    expect(auth.storedTokens(entry)).toBe("null");
    await expect(connection.reconnect()).rejects.toThrow(/requires sign-in/u);
  });
});
