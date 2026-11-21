import { spawn } from "node:child_process";

const browserCommand = (url: string): [string, string[]] => {
  if (process.platform === "darwin") {
    return ["open", [url]];
  }

  if (process.platform === "win32") {
    return ["cmd", ["/c", "start", "", url]];
  }

  return ["xdg-open", [url]];
};

const ignore = (): void => undefined;

/** Open `url` in the platform browser without waiting for it. Failures are ignored: the URL is also shown. */
export const openUrl = (url: string): void => {
  const [command, args] = browserCommand(url);

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", ignore);
    child.unref();
  } catch {
    ignore();
  }
};
