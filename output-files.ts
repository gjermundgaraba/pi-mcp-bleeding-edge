import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Write output the model was not shown in full, such as truncated text or a binary resource, to a new
 * temporary file only the user can read, and return its path. `extension` includes the dot.
 */
export const writeOutputFile = async (
  extension: string,
  data: string | Uint8Array
): Promise<string> => {
  const file = path.join(
    os.tmpdir(),
    `pi-mcp-${randomBytes(8).toString("hex")}${extension}`
  );

  await writeFile(file, data, { mode: 0o600, flag: "wx" });

  return file;
};
