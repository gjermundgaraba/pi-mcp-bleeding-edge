import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import type { LoggingMessageNotificationParams } from "@modelcontextprotocol/client";
import { z } from "zod";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

const formatData = (data: unknown): string => {
  const text = z.string().safeParse(data);

  if (text.success) {
    return text.data;
  }

  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
};

/** One `notifications/message` as a log line: `<time> [<server>] <level> <logger>: <message>`. */
const formatLogLine = (
  server: string,
  params: LoggingMessageNotificationParams,
  now: Date = new Date()
): string => {
  const logger =
    params.logger === undefined || params.logger === ""
      ? ""
      : ` ${params.logger}:`;

  const text = formatData(params.data).replaceAll(/\r?\n/gu, "\n    ");

  return `${now.toISOString()} [${server}] ${params.level}${logger} ${text}\n`;
};

const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * Appends server log messages to one file, rotated to `<file>.1` past 5 MB. Every line is one
 * synchronous append, since several pi processes share the file; write errors are ignored.
 */
export class ServerLog {
  private readonly file: string;
  private size: number | undefined;

  constructor(file: string) {
    this.file = file;
  }

  write(server: string, params: LoggingMessageNotificationParams): void {
    this.append(formatLogLine(server, params));
  }

  /** Append lines a stdio server wrote to stderr, where MCP 2026-07-28 moves server logging. */
  writeStderr(server: string, text: string): void {
    const now = new Date().toISOString();

    const lines = text
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "")
      .map((line) => `${now} [${server}] stderr ${line}\n`);

    if (lines.length > 0) {
      this.append(lines.join(""));
    }
  }

  private append(line: string): void {
    try {
      if (this.size === undefined) {
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        this.size = sizeOf(this.file);
      }

      if (this.size > MAX_LOG_BYTES) {
        if (sizeOf(this.file) > MAX_LOG_BYTES) {
          renameSync(this.file, `${this.file}.1`);
        }

        this.size = sizeOf(this.file);
      }

      appendFileSync(this.file, line);
      this.size += Buffer.byteLength(line);
    } catch {
      this.size = undefined;
    }
  }
}
