/** What a server asked for when it rejected a request: from its `WWW-Authenticate` challenge. */
export interface OAuthChallenge {
  readonly resourceMetadataUrl?: string | undefined;
  readonly scope?: string | undefined;
}

/** The server needs the user to sign in: no stored credentials, or they could not be refreshed. */
export class SignInRequiredError extends Error {
  readonly challenge: OAuthChallenge | undefined;

  constructor(challenge?: OAuthChallenge, options?: ErrorOptions) {
    super("The MCP server requires sign-in", options);
    this.name = "SignInRequiredError";
    this.challenge = challenge;
  }
}

/** The user cancelled a sign-in, or the session ended during it. */
export class SignInCancelledError extends Error {
  constructor() {
    super("Sign-in cancelled.");
    this.name = "SignInCancelledError";
  }
}
