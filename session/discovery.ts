import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { McpExposure } from "../config/exposure.ts";

const CODEMODE_TOOL = "codemode";
const TOOL_SEARCH_TOOL = "tool_search";

/**
 * Activates the tool that reaches MCP tools not declared to the model: `codemode` for `codemode`
 * exposure (unless `autoEnableCodemode` is false), `tool_search` for `deferred`. Only a tool of
 * that name that declares `reachesTools` qualifies. Warns once per session when neither is active.
 */
export class DiscoveryActivator {
  private readonly pi: ExtensionAPI;
  private warned = false;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  reset(): void {
    this.warned = false;
  }

  ensure(
    ctx: ExtensionContext,
    exposures: ReadonlySet<McpExposure>,
    autoEnableCodemode: boolean
  ): void {
    const needsCodemode = exposures.has("codemode");
    const needsToolSearch = exposures.has("deferred");

    if (!needsCodemode && !needsToolSearch) {
      return;
    }

    const tools = this.pi.getAllTools();

    const reaches = (name: string) =>
      tools.some(
        (tool) => tool.name === name && tool.reachesTools !== undefined
      );

    const hasCodemode = reaches(CODEMODE_TOOL);
    const hasToolSearch = reaches(TOOL_SEARCH_TOOL);
    const active = this.pi.getActiveTools();
    const activate: string[] = [];

    if (
      needsCodemode &&
      hasCodemode &&
      autoEnableCodemode &&
      !active.includes(CODEMODE_TOOL)
    ) {
      activate.push(CODEMODE_TOOL);
    }

    if (
      needsToolSearch &&
      hasToolSearch &&
      !active.includes(TOOL_SEARCH_TOOL)
    ) {
      activate.push(TOOL_SEARCH_TOOL);
    }

    if (activate.length > 0) {
      this.pi.setActiveTools([...active, ...activate]);
    }

    const reachable = new Set([...active, ...activate]);

    if (
      (hasCodemode && reachable.has(CODEMODE_TOOL)) ||
      (hasToolSearch && reachable.has(TOOL_SEARCH_TOOL))
    ) {
      return;
    }

    if (this.warned) {
      return;
    }

    this.warned = true;

    const reason =
      needsCodemode && hasCodemode && !autoEnableCodemode
        ? " (autoEnableCodemode is false)"
        : "";

    ctx.ui.notify(
      `MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
      "warning"
    );
  }
}
