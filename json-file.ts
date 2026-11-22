import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** A file's text without a byte order mark, or `undefined` when it does not exist. */
export const readTextFile = (file: string): string | undefined =>
  existsSync(file)
    ? readFileSync(file, "utf8").replace(/^\uFEFF/u, "")
    : undefined;

/** A file's parsed JSON, or `undefined` when it is missing or empty. Throws on invalid JSON. */
export const readJsonFile = (file: string): unknown => {
  const text = readTextFile(file);

  return text === undefined || text.trim() === ""
    ? undefined
    : JSON.parse(text);
};

/**
 * Write one of this extension's data files: readable only by the user, and replaced atomically,
 * since other pi processes read it at any time.
 */
export const writePrivateJsonFile = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  const temporary = `${file}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
};
