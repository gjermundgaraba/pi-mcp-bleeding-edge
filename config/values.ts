import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const REFERENCE =
  /\$\$|\$!|\$\{(?<braced>[A-Za-z_]\w*)\}|\$(?<bare>[A-Za-z_]\w*)/gu;

const COMMAND_TIMEOUT_MS = 10_000;

const runCommand = (command: string): string | undefined => {
  try {
    const output = execSync(command, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return output === "" ? undefined : output;
  } catch {
    return undefined;
  }
};

/**
 * Resolve a configured value the way pi resolves credentials: `!command` runs the command and uses
 * its output, `$NAME` and `${NAME}` read environment variables, and `$$` and `$!` escape a literal
 * `$` and `!`. Throws naming `description` when the command fails or a variable is unset.
 */
export const resolveConfigValue = (
  value: string,
  description: string
): string => {
  if (value.startsWith("!")) {
    const output = runCommand(value.slice(1));

    if (output === undefined) {
      throw new Error(
        `Failed to resolve ${description} from shell command: ${value.slice(1)}`
      );
    }

    return output;
  }

  const missing = new Set<string>();
  let resolved = "";
  let index = 0;

  for (const match of value.matchAll(REFERENCE)) {
    resolved += value.slice(index, match.index);
    index = match.index + match[0].length;

    const name = match.groups?.["braced"] ?? match.groups?.["bare"];

    if (name === undefined) {
      resolved += match[0].slice(1);
      continue;
    }

    const env = process.env[name] ?? "";

    if (env === "") {
      missing.add(name);
    }

    resolved += env;
  }

  if (missing.size > 0) {
    const noun = missing.size === 1 ? "variable" : "variables";

    throw new Error(
      `Failed to resolve ${description} from environment ${noun}: ${[...missing].join(", ")}`
    );
  }

  return resolved + value.slice(index);
};

/** Resolve every value of a header or environment map with {@link resolveConfigValue}. */
export const resolveConfigValues = (
  values: Readonly<Record<string, string>> | undefined,
  describe: (key: string) => string
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [
      key,
      resolveConfigValue(value, describe(key)),
    ])
  );

/** `~` and a leading `~/` name the home directory, as in a shell. */
export const expandHome = (value: string): string => {
  if (value === "~") {
    return os.homedir();
  }

  if (
    value.startsWith("~/") ||
    (process.platform === "win32" && value.startsWith("~\\"))
  ) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
};
