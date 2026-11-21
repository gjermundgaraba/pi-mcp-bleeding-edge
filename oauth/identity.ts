import { createHash } from "node:crypto";

import type { AuthorizationServerMetadata } from "@modelcontextprotocol/client";

import { listsMetadataDocumentCallback } from "../config/schema.ts";
import type { McpOAuthConfig } from "../config/schema.ts";

/** The `client_name` pi registers with. */
const PI_CLIENT_NAME = "pi";

/** Pi's Client ID Metadata Documents: `client.json`, and `<callback id>/client.json` per MCP server. */
const METADATA_DOCUMENTS = "https://pi.dev/oauth";

const DEFAULT_CALLBACK_PATH = "/callback";

/** How pi identifies itself to an authorization server. */
export type ClientIdentity =
  | { readonly kind: "configured"; readonly clientId: string }
  | { readonly kind: "document"; readonly url: string }
  | { readonly kind: "registered"; readonly clientName: string };

/** The identity and the path of the redirect URI it needs. */
export interface ClientPlan {
  readonly identity: ClientIdentity;
  readonly callbackPath: string;
}

/** 12 characters identifying an MCP server URL in callback paths, computed like pi and Codex do. */
const callbackId = (serverUrl: string): string => {
  const url = new URL(serverUrl);
  url.hash = "";

  return createHash("sha256")
    .update(url.href)
    .digest()
    .subarray(0, 9)
    .toString("base64url");
};

const supportsPublicDocuments = (
  metadata: AuthorizationServerMetadata | undefined
): boolean =>
  metadata?.client_id_metadata_document_supported === true &&
  (metadata.token_endpoint_auth_methods_supported?.includes("none") ?? false);

const sendsIssuer = (
  metadata: AuthorizationServerMetadata | undefined
): boolean =>
  metadata !== undefined &&
  "authorization_response_iss_parameter_supported" in metadata &&
  metadata.authorization_response_iss_parameter_supported === true;

/**
 * Choose how to identify pi, as pi's built-in MCP support does: a configured `clientId`; pi's
 * Client ID Metadata Document when the authorization server supports documents for public clients;
 * otherwise dynamic client registration. Without RFC 9207 `iss` in authorization responses, the
 * document and the redirect path are specific to the MCP server, so responses cannot be mixed up
 * between authorization servers.
 */
export const planClient = (
  settings: McpOAuthConfig | undefined,
  metadata: AuthorizationServerMetadata | undefined,
  serverUrl: string
): ClientPlan => {
  const callbackUrl = settings?.callbackUrl;

  const configuredPath =
    callbackUrl === undefined
      ? DEFAULT_CALLBACK_PATH
      : new URL(callbackUrl).pathname;

  const clientId = settings?.clientId;

  if (clientId !== undefined && clientId !== "") {
    return {
      identity: { kind: "configured", clientId },
      callbackPath: configuredPath,
    };
  }

  const registration = settings?.clientRegistration ?? "auto";

  const wantsDocument =
    registration === "cimd" ||
    (registration === "auto" &&
      settings?.clientName === undefined &&
      listsMetadataDocumentCallback(settings?.callbackUrl));

  if (wantsDocument && supportsPublicDocuments(metadata)) {
    if (sendsIssuer(metadata)) {
      return {
        identity: {
          kind: "document",
          url: `${METADATA_DOCUMENTS}/client.json`,
        },
        callbackPath: DEFAULT_CALLBACK_PATH,
      };
    }

    const id = callbackId(serverUrl);

    return {
      identity: {
        kind: "document",
        url: `${METADATA_DOCUMENTS}/${id}/client.json`,
      },
      callbackPath: `${DEFAULT_CALLBACK_PATH}/${id}`,
    };
  }

  if (registration === "cimd") {
    throw new Error(
      'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"'
    );
  }

  return {
    identity: {
      kind: "registered",
      clientName: settings?.clientName ?? PI_CLIENT_NAME,
    },
    callbackPath: configuredPath,
  };
};
