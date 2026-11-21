import type { AuthorizationServerMetadata } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vite-plus/test";

import { planClient } from "../../oauth/identity.ts";

const metadata = (
  fields: Partial<AuthorizationServerMetadata>
): AuthorizationServerMetadata => ({
  issuer: "https://as.example",
  authorization_endpoint: "https://as.example/authorize",
  token_endpoint: "https://as.example/token",
  response_types_supported: ["code"],
  ...fields,
});

const supportsDocuments = {
  client_id_metadata_document_supported: true,
  token_endpoint_auth_methods_supported: ["none"],
};

describe("planClient", () => {
  it("uses a configured client as given", () => {
    expect(
      planClient(
        { clientId: "mine", callbackUrl: "http://localhost:8080/oauth" },
        undefined,
        "https://x/mcp"
      )
    ).toStrictEqual({
      identity: { kind: "configured", clientId: "mine" },
      callbackPath: "/oauth",
    });
  });

  it("uses pi's document when the authorization server sends iss and supports documents", () => {
    expect(
      planClient(
        undefined,
        metadata({
          ...supportsDocuments,
          authorization_response_iss_parameter_supported: true,
        }),
        "https://x/mcp"
      )
    ).toStrictEqual({
      identity: { kind: "document", url: "https://pi.dev/oauth/client.json" },
      callbackPath: "/callback",
    });
  });

  it("uses a document and callback specific to the server when the authorization server does not send iss", () => {
    const plan = planClient(
      undefined,
      metadata(supportsDocuments),
      "https://x/mcp"
    );

    expect(plan.identity).toMatchObject({ kind: "document" });
    expect(plan.identity.kind === "document" && plan.identity.url).toMatch(
      /^https:\/\/pi\.dev\/oauth\/[\w-]{12}\/client\.json$/u
    );
    expect(plan.callbackPath).toMatch(/^\/callback\/[\w-]{12}$/u);
  });

  it("registers when asked to, when a client name is set, or without document support", () => {
    expect(
      planClient(
        { clientRegistration: "dcr" },
        metadata(supportsDocuments),
        "https://x/mcp"
      ).identity
    ).toStrictEqual({
      kind: "registered",
      clientName: "pi",
    });
    expect(
      planClient(
        { clientName: "Claude Code" },
        metadata(supportsDocuments),
        "https://x/mcp"
      ).identity
    ).toStrictEqual({
      kind: "registered",
      clientName: "Claude Code",
    });
    expect(
      planClient(undefined, metadata({}), "https://x/mcp").identity.kind
    ).toBe("registered");
  });

  it("fails cimd against an authorization server without document support", () => {
    expect(() =>
      planClient({ clientRegistration: "cimd" }, metadata({}), "https://x/mcp")
    ).toThrow("does not support Client ID Metadata Documents");
  });
});
