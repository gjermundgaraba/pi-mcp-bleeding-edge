import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { z } from "zod";

const PREVIEW_LINES = 5;
const COLLAPSED_ARGS_CHARS = 160;
const CONTROL = /[^\P{Cc}\n]/gu;
const MCP_TOOL_NAME = /^mcp__(?<server>.+?)__(?<tool>.+)$/u;

const savedOutput = z.object({ fullOutputPath: z.string() });

/** Text from a server, made safe to draw: tabs become spaces and control characters are dropped. */
const sanitizeText = (text: string): string =>
  text.replaceAll("\t", "  ").replaceAll(CONTROL, "");

const formatArgs = (args: unknown, expanded: boolean): string => {
  const compact = JSON.stringify(args) ?? "";

  if (compact === "" || compact === "{}") {
    return "";
  }

  const json = sanitizeText(
    expanded ? (JSON.stringify(args, null, 2) ?? compact) : compact
  );

  return expanded || json.length <= COLLAPSED_ARGS_CHARS
    ? json
    : `${json.slice(0, COLLAPSED_ARGS_CHARS - 1)}…`;
};

const textOutput = (
  content: ReadonlyArray<{ type: "text"; text: string } | { type: "image" }>,
  showImages: boolean
): string =>
  content
    .flatMap((block) => {
      if (block.type === "text") {
        return [block.text];
      }

      return showImages ? [] : ["[image]"];
    })
    .join("\n")
    .trim();

/** The first lines of output, measured in wrapped lines, with a hint of how many were left out. */
class OutputPreview implements Component {
  private readonly text: string;
  private readonly hint: (hidden: number) => string;
  private cache:
    | { readonly width: number; readonly lines: string[] }
    | undefined;

  constructor(text: string, hint: (hidden: number) => string) {
    this.text = text;
    this.hint = hint;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) {
      return this.cache.lines;
    }

    const { visualLines, skippedCount } = truncateToVisualLines(
      this.text,
      PREVIEW_LINES,
      width,
      0,
      "start"
    );

    const lines =
      skippedCount > 0
        ? [...visualLines, this.hint(skippedCount)]
        : [...visualLines];

    this.cache = { width, lines };

    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

/** Renderers of calls to an MCP tool labeled `server/tool`, also used before the tool is registered. */
export const mcpToolRenderers = (label: string): ToolRenderers => ({
  renderCall(args, theme, context) {
    const component =
      context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);

    const formatted = formatArgs(args, context.expanded);
    const title = theme.fg("toolTitle", theme.bold(label));

    component.setText(
      formatted === "" ? title : `${title} ${theme.fg("muted", formatted)}`
    );

    return component;
  },
  renderResult(result, options, theme, context) {
    const component =
      context.lastComponent instanceof Container
        ? context.lastComponent
        : new Container();

    component.clear();

    const output = sanitizeText(textOutput(result.content, context.showImages));

    if (output === "") {
      return component;
    }

    const color = context.isError ? "error" : "toolOutput";

    const styled = output
      .split("\n")
      .map((line) => theme.fg(color, line))
      .join("\n");

    component.addChild(new Spacer(1));

    if (options.expanded) {
      component.addChild(new Text(styled, 0, 0));

      return component;
    }

    component.addChild(
      new OutputPreview(
        styled,
        (hidden) =>
          `${theme.fg("muted", `... (${hidden} more lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
      )
    );

    const saved = savedOutput.safeParse(result.details);

    if (saved.success) {
      component.addChild(
        new Text(
          theme.fg("muted", `Full output: ${saved.data.fullOutputPath}`),
          0,
          0
        )
      );
    }

    return component;
  },
});

/** Renderers for calls to `mcp__<server>__<tool>` tools whose server is not connected (yet). */
export const renderUnregisteredMcpTool = (
  toolName: string,
  next: () => ToolRenderers | undefined
): ToolRenderers | undefined => {
  const groups = MCP_TOOL_NAME.exec(toolName)?.groups;
  const server = groups?.["server"];
  const tool = groups?.["tool"];

  return (
    next() ??
    (server === undefined || tool === undefined
      ? undefined
      : mcpToolRenderers(`${server}/${tool}`))
  );
};
