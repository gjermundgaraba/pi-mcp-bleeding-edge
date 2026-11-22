import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

import { serverExposure, toolExposure } from "../config/exposure.ts";
import type { McpExposure } from "../config/exposure.ts";
import { openUrl } from "../open-url.ts";
import type { McpSession, ServerSlot } from "../session/controller.ts";
import {
  attentionRank,
  describeProtocol,
  describeState,
  describeTransport,
  firstLine,
  isEnabled,
} from "../session/status.ts";
import type { McpMenu, McpUi } from "./view.ts";

type ReachableExposure = Exclude<McpExposure, "hidden">;

const EXPOSURE_DESCRIPTIONS: Readonly<Record<ReachableExposure, string>> = {
  codemode: "called from codemode scripts, which find them with searchTools()",
  deferred:
    "not declared until tool_search loads them, then called directly; no codemode needed",
  direct: "declared to the model like built-in tools",
};

const REACHABLE_EXPOSURES: readonly ReachableExposure[] = [
  "codemode",
  "deferred",
  "direct",
];

const IN_PROJECT_SAVED = "saved to the project mcp.json";

const savedWhere = (slot: ServerSlot): string => {
  if (slot.entry.scope === "extension") {
    return "for this session";
  }

  return slot.entry.override === undefined
    ? `saved to the ${slot.entry.scope} mcp.json`
    : IN_PROJECT_SAVED;
};

const serversMenu = (session: McpSession): McpMenu => {
  const { registry } = session;

  return {
    title: "MCP servers",
    error: registry.notices().join("\n") || undefined,
    items: registry.servers
      .toSorted(
        (a, b) =>
          attentionRank(a) - attentionRank(b) ||
          a.entry.name.localeCompare(b.entry.name)
      )
      .map((slot) => ({
        value: slot.entry.name,
        label: slot.entry.name,
        description: `${describeState(slot)} · ${serverExposure(slot.entry.config)} · ${slot.entry.override === undefined ? slot.entry.scope : "global, project override"}`,
      })),
    empty: `No MCP servers configured. Add them to ${registry.paths.globalConfig} or .pi/mcp.json.`,
    confirmLabel: "manage",
    cancelLabel: "close",
  };
};

const actionsOf = (slot: ServerSlot, inProject: boolean): SelectItem[] => {
  const saved = savedWhere(slot);

  if (!isEnabled(slot.entry)) {
    return [
      { value: "enable", label: "Enable", description: saved },
      ...(inProject
        ? [
            {
              value: "enable-project",
              label: "Enable in this project",
              description: IN_PROJECT_SAVED,
            },
          ]
        : []),
    ];
  }

  const { connection } = slot;
  const state = connection?.state;
  const items: SelectItem[] = [];

  if (state === "needs-auth") {
    items.push({
      value: "signin",
      label: "Sign in",
      description: "opens the browser",
    });
  }

  if (state === "connected") {
    items.push({
      value: "tools",
      label: "Tools",
      description: `${connection?.tools.length ?? 0} offered`,
    });
  }

  if (
    state === "failed" ||
    state === "disconnected" ||
    state === "connected" ||
    state === "needs-auth"
  ) {
    items.push({ value: "reconnect", label: "Reconnect" });
  }

  if (state === "connected" && connection?.oauthUrl !== undefined) {
    items.push({
      value: "signout",
      label: "Sign out",
      description: "deletes the stored credentials",
    });
  }

  items.push(
    {
      value: "exposure",
      label: "Exposure",
      description: serverExposure(slot.entry.config),
    },
    { value: "disable", label: "Disable", description: saved }
  );

  if (inProject) {
    items.push({
      value: "disable-project",
      label: "Disable in this project",
      description: IN_PROJECT_SAVED,
    });
  }

  return items;
};

const serverMenu = (session: McpSession, name: string): McpMenu => {
  const slot = session.registry.find(name);

  if (slot === undefined) {
    return {
      title: name,
      items: [],
      empty: "This server is no longer configured.",
      confirmLabel: "",
      cancelLabel: "back",
    };
  }

  const { entry, connection } = slot;

  const inProject =
    entry.scope === "global" &&
    entry.override === undefined &&
    session.registry.projectConfig !== undefined;

  const items = actionsOf(slot, inProject);
  const protocol = describeProtocol(slot);

  const details = [
    describeTransport(entry),
    `${entry.scope}: ${entry.source}`,
    ...(entry.override === undefined
      ? []
      : [`project override: ${entry.override}`]),
    `State: ${describeState(slot, false)}`,
    ...(protocol === undefined ? [] : [`Protocol: ${protocol}`]),
  ];

  const error = [
    slot.message,
    connection?.state === "connected" ? undefined : connection?.error,
  ]
    .filter((line): line is string => line !== undefined && line !== "")
    .join("\n");

  return {
    title: `MCP server ${name}`,
    details: details.join("\n"),
    error: error === "" ? undefined : error,
    items,
    selected: items[0]?.value,
    confirmLabel: "select",
    cancelLabel: "back",
  };
};

const showTools = async (ui: McpUi, slot: ServerSlot): Promise<void> => {
  const exposure = serverExposure(slot.entry.config);

  const overridden =
    Object.keys(slot.entry.config.toolExposure ?? {}).length > 0;

  const reach =
    exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure];

  await ui.menu(() => ({
    title: `Tools of ${slot.entry.name}`,
    details: `Exposure ${exposure}: ${reach}${overridden ? "\nSome tools override it with toolExposure." : ""}`,
    items: (slot.connection?.tools ?? []).map((tool) => {
      const own = toolExposure(slot.entry.config, tool.name);
      const description = firstLine(tool.description ?? "");

      return {
        value: tool.name,
        label: tool.name,
        description: own === exposure ? description : `[${own}] ${description}`,
      };
    }),
    empty: "The server offers no tools.",
    confirmLabel: "back",
    cancelLabel: "back",
  }));
};

const chooseExposure = async (
  ui: McpUi,
  session: McpSession,
  slot: ServerSlot
): Promise<string | undefined> => {
  const current = serverExposure(slot.entry.config);

  const choice = await ui.menu(() => ({
    title: `Exposure of ${slot.entry.name}`,
    details:
      slot.entry.scope === "extension"
        ? `Applies to this session; the server is registered by ${slot.entry.source}.`
        : `Saved to ${slot.entry.override ?? slot.entry.source}.`,
    items: REACHABLE_EXPOSURES.map((exposure) => ({
      value: exposure,
      label: `${exposure === current ? "✓ " : "  "}${exposure}`,
      description: EXPOSURE_DESCRIPTIONS[exposure],
    })),
    selected: current,
    confirmLabel: "save",
    cancelLabel: "back",
  }));

  const exposure = REACHABLE_EXPOSURES.find(
    (candidate) => candidate === choice
  );

  return exposure === undefined || exposure === current
    ? undefined
    : await session.registry.setExposure(slot, exposure);
};

/** Sign in on the manager's sign-in screen, which shows the URL with a copy key and cancels with Esc. */
export const signInWithUi = async (
  ui: McpUi,
  session: McpSession,
  slot: ServerSlot
): Promise<string | undefined> => {
  const title = `Sign in to ${slot.entry.name}`;
  const cancel = new AbortController();

  const status = (message: string): void => {
    ui.status(title, message, () => {
      cancel.abort();
    });
  };

  let authorizationUrl = "";

  status("Contacting the authorization server…");

  return await session.signIn(
    slot,
    {
      showAuthorizationUrl: (url) => {
        authorizationUrl = url.href;
        openUrl(url.href);
      },
      promptForRedirectUrl: async (signal) => {
        const value = await ui.redirectUrl(title, authorizationUrl, signal);

        status("Connecting…");

        return value;
      },
    },
    cancel.signal
  );
};

const runAction = async (
  ui: McpUi,
  ctx: ExtensionContext,
  session: McpSession,
  slot: ServerSlot,
  action: string
): Promise<void> => {
  const { registry } = session;

  switch (action) {
    case "signin": {
      session.report(ctx, slot, await signInWithUi(ui, session, slot));

      return;
    }

    case "reconnect": {
      session.runInBackground(
        ctx,
        slot,
        async () => await registry.reconnect(slot)
      );

      return;
    }

    case "signout": {
      await session.signOut(slot);
      session.report(ctx, slot, undefined);

      return;
    }

    case "tools": {
      await showTools(ui, slot);

      return;
    }

    case "exposure": {
      session.report(ctx, slot, await chooseExposure(ui, session, slot));

      return;
    }

    case "enable":
    case "disable":
    case "enable-project":
    case "disable-project": {
      const enable = action.startsWith("enable");

      session.runInBackground(
        ctx,
        slot,
        async () =>
          await registry.setEnabled(slot, enable, action.endsWith("-project"))
      );

      return;
    }

    default: {
      return;
    }
  }
};

/** The manager's flow: the server list, then one server's actions, until closed. */
export const manageServers = async (
  ui: McpUi,
  ctx: ExtensionContext,
  session: McpSession
): Promise<void> => {
  const subscribe = (listener: () => void) =>
    session.registry.subscribe(listener);

  for (;;) {
    const name = await ui.menu(() => serversMenu(session), subscribe);

    if (name === undefined || name === "") {
      return;
    }

    for (;;) {
      const action = await ui.menu(() => serverMenu(session, name), subscribe);
      const slot = session.registry.find(name);

      if (action === undefined || action === "" || slot === undefined) {
        break;
      }

      await runAction(ui, ctx, session, slot, action);
    }
  }
};
