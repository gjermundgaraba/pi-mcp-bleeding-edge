import {
  copyToClipboard,
  DynamicBorder,
  getSelectListTheme,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  hyperlink,
  Input,
  SelectList,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  Component,
  Focusable,
  SelectItem,
  TUI,
} from "@earendil-works/pi-tui";

/** One screen of the manager. */
export interface McpMenu {
  readonly title: string;
  /** Shown below the title. */
  readonly details?: string | undefined;
  /** Shown below the details in the error color. */
  readonly error?: string | undefined;
  readonly items: readonly SelectItem[];
  /** Shown when there are no items. */
  readonly empty?: string | undefined;
  /** The item selected when the menu opens. */
  readonly selected?: string | undefined;
  /** What the confirm and cancel keys do, for the key hints. */
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

/** The manager as its flows see it. */
export interface McpUi {
  /**
   * Show a menu; resolves to the chosen item's value, or `undefined` when cancelled. With
   * `subscribe`, the menu rebuilds on every change and keeps the selected item.
   */
  readonly menu: (
    build: () => McpMenu,
    subscribe?: (listener: () => void) => () => void
  ) => Promise<string | undefined>;
  /** Show a message while an operation runs. With `onCancel`, the cancel key calls it. */
  readonly status: (
    title: string,
    message: string,
    onCancel?: () => void
  ) => void;
  /**
   * Show the authorization URL and wait for a pasted redirect URL. Resolves to `undefined` when
   * cancelled or when `signal` aborts because the browser reached the callback.
   */
  readonly redirectUrl: (
    title: string,
    authorizationUrl: string,
    signal: AbortSignal
  ) => Promise<string | undefined>;
}

const MAX_VISIBLE_ITEMS = 12;

type InputHandler = Pick<Component, "handleInput">;

const isShown = (text: string | undefined): text is string =>
  text !== undefined && text !== "";

const frame = (
  theme: Theme,
  title: string,
  body: readonly Component[],
  footer?: string
): Container => {
  const container = new Container();

  container.addChild(
    new DynamicBorder((text: string) => theme.fg("accent", text))
  );
  container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

  for (const child of body) {
    container.addChild(child);
  }

  if (isShown(footer)) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", footer), 1, 0));
  }

  container.addChild(
    new DynamicBorder((text: string) => theme.fg("accent", text))
  );

  return container;
};

/** Settles a pending answer once; later answers are ignored. */
class Answer<T> {
  readonly promise: Promise<T>;
  private readonly resolveAnswer: (value: T) => void;
  private settledValue = false;

  constructor() {
    const { promise, resolve } = Promise.withResolvers<T>();

    this.promise = promise;
    this.resolveAnswer = resolve;
  }

  get settled(): boolean {
    return this.settledValue;
  }

  settle(value: T): void {
    if (this.settledValue) {
      return;
    }

    this.settledValue = true;
    this.resolveAnswer(value);
  }
}

/** A sign-in URL with a click hint and a copy hint, since a wrapped URL is hard to select. */
class AuthorizationLink extends Container {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly url: string;
  private readonly hint = new Text("", 1, 0);

  constructor(tui: TUI, theme: Theme, url: string) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.url = url;
    this.addChild(new Text(theme.fg("accent", hyperlink(url, url)), 1, 0));
    this.addChild(this.hint);
    this.setHint(keyHint("app.message.copy", "to copy"));
  }

  async copy(): Promise<void> {
    try {
      await copyToClipboard(this.url);
      this.setHint(this.theme.fg("success", "Copied URL to clipboard"));
    } catch (error) {
      this.setHint(
        this.theme.fg(
          "error",
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }

  private setHint(suffix: string): void {
    const click =
      process.platform === "darwin"
        ? "Cmd+click to open"
        : "Ctrl+click to open";

    this.hint.setText(
      `${this.theme.fg("dim", hyperlink(click, this.url))} ${this.theme.fg("dim", "•")} ${suffix}`
    );
    this.tui.requestRender();
  }
}

/** The `/mcp` view: menus that rebuild while servers connect, status screens, and the sign-in screen. */
class McpManagerView implements McpUi, Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private content: Container;
  private inputHandler: InputHandler | undefined;
  private inputTarget: Focusable | undefined;
  private isFocused = false;

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.content = frame(theme, "MCP servers", [
      new Text(theme.fg("muted", "Loading…"), 1, 1),
    ]);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;

    if (this.inputTarget !== undefined) {
      this.inputTarget.focused = value;
    }
  }

  readonly menu = async (
    build: () => McpMenu,
    subscribe?: (listener: () => void) => () => void
  ): Promise<string | undefined> => {
    const answer = new Answer<string | undefined>();

    let selected: string | undefined;

    const render = (): void => {
      const menu = build();
      const body: Component[] = [];

      if (isShown(menu.details)) {
        body.push(new Text(this.theme.fg("muted", menu.details), 1, 0));
      }

      if (isShown(menu.error)) {
        body.push(new Text(this.theme.fg("error", menu.error), 1, 0));
      }

      body.push(new Spacer(1));

      if (menu.items.length === 0) {
        body.push(
          new Text(
            this.theme.fg("muted", menu.empty ?? "Nothing to show."),
            1,
            0
          )
        );
        this.setContent(
          frame(
            this.theme,
            menu.title,
            body,
            keyHint("tui.select.cancel", menu.cancelLabel)
          ),
          {
            handleInput: (data) => {
              if (this.keybindings.matches(data, "tui.select.cancel")) {
                answer.settle(undefined);
              }
            },
          }
        );

        return;
      }

      const list = new SelectList(
        [...menu.items],
        Math.min(menu.items.length, MAX_VISIBLE_ITEMS),
        getSelectListTheme()
      );

      const index = menu.items.findIndex(
        (item) => item.value === (selected ?? menu.selected)
      );

      if (index !== -1) {
        list.setSelectedIndex(index);
      }

      selected = list.getSelectedItem()?.value;
      list.onSelectionChange = (item) => {
        selected = item.value;
      };

      list.onSelect = (item) => {
        answer.settle(item.value);
      };

      list.onCancel = () => {
        answer.settle(undefined);
      };

      body.push(list);

      const footer = `${keyHint("tui.select.confirm", menu.confirmLabel)} • ${keyHint("tui.select.cancel", menu.cancelLabel)}`;

      this.setContent(frame(this.theme, menu.title, body, footer), list);
    };

    render();

    const unsubscribe = subscribe?.(() => {
      if (!answer.settled) {
        render();
      }
    });

    try {
      return await answer.promise;
    } finally {
      unsubscribe?.();
    }
  };

  readonly status = (
    title: string,
    message: string,
    onCancel?: () => void
  ): void => {
    const body = [
      new Spacer(1),
      new Text(this.theme.fg("muted", message), 1, 0),
    ];

    if (onCancel === undefined) {
      this.setContent(frame(this.theme, title, body));

      return;
    }

    this.setContent(
      frame(this.theme, title, body, keyHint("tui.select.cancel", "cancel")),
      {
        handleInput: (data) => {
          if (this.keybindings.matches(data, "tui.select.cancel")) {
            onCancel();
          }
        },
      }
    );
  };

  readonly redirectUrl = async (
    title: string,
    authorizationUrl: string,
    signal: AbortSignal
  ): Promise<string | undefined> => {
    if (signal.aborted) {
      return undefined;
    }

    const answer = new Answer<string | undefined>();

    const onAbort = (): void => {
      answer.settle(undefined);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    const input = new Input();
    const link = new AuthorizationLink(this.tui, this.theme, authorizationUrl);

    const body: Component[] = [
      new Spacer(1),
      new Text(
        this.theme.fg(
          "muted",
          "Approve access in your browser. If it did not open, visit:"
        ),
        1,
        0
      ),
      link,
      new Spacer(1),
      new Text(
        this.theme.fg(
          "muted",
          "If the browser runs on another machine, paste the URL it was redirected to:"
        ),
        1,
        0
      ),
      input,
    ];

    const footer = `${keyHint("tui.select.confirm", "submit")} • ${keyHint("tui.select.cancel", "cancel")}`;

    this.setContent(
      frame(this.theme, title, body, footer),
      {
        handleInput: (data) => {
          if (this.keybindings.matches(data, "tui.select.confirm")) {
            const value = input.getValue().trim();

            if (value !== "") {
              answer.settle(value);
            }

            return;
          }

          if (this.keybindings.matches(data, "tui.select.cancel")) {
            answer.settle(undefined);

            return;
          }

          if (this.keybindings.matches(data, "app.message.copy")) {
            void link.copy();

            return;
          }

          input.handleInput(data);
        },
      },
      input
    );

    try {
      return await answer.promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  handleInput(data: string): void {
    this.inputHandler?.handleInput?.(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.content
      .render(width)
      .map((line) =>
        visibleWidth(line) > width ? truncateToWidth(line, width, "") : line
      );
  }

  invalidate(): void {
    this.content.invalidate();
  }

  private setContent(
    content: Container,
    inputHandler?: InputHandler,
    inputTarget?: Focusable
  ): void {
    if (this.inputTarget !== undefined) {
      this.inputTarget.focused = false;
    }

    this.content = content;
    this.inputHandler = inputHandler;
    this.inputTarget = inputTarget;

    if (this.inputTarget !== undefined) {
      this.inputTarget.focused = this.isFocused;
    }

    this.tui.requestRender();
  }
}

/** Run `manage` in the manager view until it returns. */
export const showMcpManager = async (
  ctx: ExtensionCommandContext,
  manage: (ui: McpUi) => Promise<void>
): Promise<void> => {
  await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
    const view = new McpManagerView(tui, theme, keybindings);

    void (async () => {
      try {
        await manage(view);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error"
        );
      } finally {
        done(undefined);
      }
    })();

    return view;
  });
};
