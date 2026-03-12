import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";
import {
  RuntimeInstallResult,
  RuntimeManagerLike,
  RuntimeMetadata,
  STATE_RUNTIME_METADATA_KEY,
} from "./core";

type BrowserName = "chrome" | "edge" | "brave";

interface BrowserCandidate {
  browserName: BrowserName;
  executablePath: string;
}

export class RuntimeManager implements RuntimeManagerLike {
  private readonly profileRootDir: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.profileRootDir = path.join(context.globalStorageUri.fsPath, "profiles");
  }

  async getInstalledRuntime(): Promise<RuntimeMetadata | null> {
    const stored = this.context.globalState.get<RuntimeMetadata>(
      STATE_RUNTIME_METADATA_KEY
    );
    const detected = await detectSystemRuntime(this.output);
    if (!detected) {
      return null;
    }

    const metadata: RuntimeMetadata = {
      ...detected,
      installedAt:
        stored && sameRuntime(stored, detected)
          ? stored.installedAt
          : new Date().toISOString(),
    };

    if (!stored || !sameRuntime(stored, metadata)) {
      await this.context.globalState.update(STATE_RUNTIME_METADATA_KEY, metadata);
    }

    return metadata;
  }

  async installRuntime(_channel: string): Promise<RuntimeInstallResult> {
    const before = this.context.globalState.get<RuntimeMetadata>(
      STATE_RUNTIME_METADATA_KEY
    );

    const metadata = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Validating system browser runtime",
        cancellable: false,
      },
      async () => {
        const runtime = await this.getInstalledRuntime();
        if (!runtime) {
          throw new Error(
            "No supported browser runtime found. Install Google Chrome, Microsoft Edge, or Brave."
          );
        }
        return runtime;
      }
    );

    const installedNow = !before || !sameRuntime(before, metadata);
    return { metadata, installedNow };
  }

  getProfileDir(mode: "persistent" | "ephemeral"): string {
    if (mode === "ephemeral") {
      return path.join(this.profileRootDir, "ephemeral");
    }
    return path.join(this.profileRootDir, "persistent");
  }

  async checkProfileHealth(
    profileDir: string
  ): Promise<{ exists: boolean; writable: boolean }> {
    const exists = await dirExists(profileDir);
    if (!exists) {
      return { exists: false, writable: false };
    }
    try {
      await fs.access(profileDir, fs.constants.W_OK);
      return { exists: true, writable: true };
    } catch {
      return { exists: true, writable: false };
    }
  }

  async checkRuntimeHealth(
    metadata: RuntimeMetadata | null
  ): Promise<{ executableExists: boolean; cacheDirExists: boolean }> {
    if (!metadata) {
      return { executableExists: false, cacheDirExists: false };
    }

    const executableExists = await fileExists(metadata.executablePath);
    if (metadata.source === "downloaded-chromium" && metadata.cacheDir) {
      return {
        executableExists,
        cacheDirExists: await dirExists(metadata.cacheDir),
      };
    }

    return {
      executableExists,
      cacheDirExists: true,
    };
  }
}

async function detectSystemRuntime(
  output: vscode.OutputChannel
): Promise<Omit<RuntimeMetadata, "installedAt"> | null> {
  const candidates = getBrowserCandidates(process.platform, process.env);
  for (const candidate of candidates) {
    if (!(await fileExists(candidate.executablePath))) {
      continue;
    }

    const browserVersion = await getBrowserVersion(
      candidate.executablePath,
      candidate.browserName,
      output
    );

    return {
      source: "system-chrome",
      browserName: candidate.browserName,
      browserVersion,
      platform: process.platform,
      executablePath: candidate.executablePath,
    };
  }

  return null;
}

function getBrowserCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): BrowserCandidate[] {
  if (platform === "darwin") {
    const home = env.HOME ?? "";
    return [
      {
        browserName: "chrome",
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      {
        browserName: "edge",
        executablePath:
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      },
      {
        browserName: "brave",
        executablePath:
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      },
      {
        browserName: "chrome",
        executablePath: path.join(
          home,
          "Applications",
          "Google Chrome.app",
          "Contents",
          "MacOS",
          "Google Chrome"
        ),
      },
      {
        browserName: "edge",
        executablePath: path.join(
          home,
          "Applications",
          "Microsoft Edge.app",
          "Contents",
          "MacOS",
          "Microsoft Edge"
        ),
      },
      {
        browserName: "brave",
        executablePath: path.join(
          home,
          "Applications",
          "Brave Browser.app",
          "Contents",
          "MacOS",
          "Brave Browser"
        ),
      },
    ];
  }

  if (platform === "win32") {
    const programFiles = env.PROGRAMFILES ?? "";
    const programFilesX86 = env["PROGRAMFILES(X86)"] ?? "";
    const localAppData = env.LOCALAPPDATA ?? "";

    return [
      {
        browserName: "chrome",
        executablePath: path.join(
          programFiles,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe"
        ),
      },
      {
        browserName: "chrome",
        executablePath: path.join(
          programFilesX86,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe"
        ),
      },
      {
        browserName: "chrome",
        executablePath: path.join(
          localAppData,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe"
        ),
      },
      {
        browserName: "edge",
        executablePath: path.join(
          programFiles,
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe"
        ),
      },
      {
        browserName: "edge",
        executablePath: path.join(
          programFilesX86,
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe"
        ),
      },
      {
        browserName: "edge",
        executablePath: path.join(
          localAppData,
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe"
        ),
      },
      {
        browserName: "brave",
        executablePath: path.join(
          programFiles,
          "BraveSoftware",
          "Brave-Browser",
          "Application",
          "brave.exe"
        ),
      },
      {
        browserName: "brave",
        executablePath: path.join(
          programFilesX86,
          "BraveSoftware",
          "Brave-Browser",
          "Application",
          "brave.exe"
        ),
      },
      {
        browserName: "brave",
        executablePath: path.join(
          localAppData,
          "BraveSoftware",
          "Brave-Browser",
          "Application",
          "brave.exe"
        ),
      },
    ];
  }

  return [];
}

async function getBrowserVersion(
  executablePath: string,
  browserName: BrowserName,
  output: vscode.OutputChannel
): Promise<string | undefined> {
  try {
    const commandOutput = await execFileWithTimeout(executablePath, ["--version"]);
    const trimmed = commandOutput.trim();
    if (!trimmed) {
      return undefined;
    }
    const version = trimmed.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1];
    return version ?? trimmed;
  } catch (error) {
    output.appendLine(
      `[runtime] failed to read ${browserName} version: ${toErrorMessage(error)}`
    );
    return undefined;
  }
}

function execFileWithTimeout(
  file: string,
  args: string[]
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 5000, windowsHide: true, maxBuffer: 128 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(`${stdout ?? ""}${stderr ?? ""}`);
      }
    );
  });
}

function sameRuntime(
  a: Partial<RuntimeMetadata>,
  b: Partial<RuntimeMetadata>
): boolean {
  return (
    a.source === b.source &&
    a.browserName === b.browserName &&
    a.browserVersion === b.browserVersion &&
    a.executablePath === b.executablePath
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
