import * as fs from "fs/promises";
import * as readline from "readline";
import { spawn, ChildProcess } from "child_process";
import * as net from "net";
import * as vscode from "vscode";
import {
  ACTION_RESTART_SIDECAR,
  SidecarManagerLike,
  SidecarStats,
  SIDE_CAR_PANEL_TYPE,
  getWorkerScriptPath,
} from "./core";

interface OpenOptions {
  runtime: {
    executablePath: string;
  };
  profileDir: string;
  startUrl: string;
  viewportMode: "mobile" | "desktop";
  fpsCap: number;
  audioEnabled: boolean;
}

interface WorkerLog {
  type: string;
  payload?: unknown;
}

export class SidecarManager implements SidecarManagerLike, vscode.Disposable {
  private worker: ChildProcess | null = null;
  private workerReadline: readline.Interface | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private stats: SidecarStats = {
    running: false,
    port: null,
    fps: null,
    averageFrameLatencyMs: null,
    droppedFrames: 0,
    transportConnectedClients: 0,
    lastFrameAt: null,
    lastError: null,
    codecSupport: "unknown",
    codecDetails: null,
  };
  private lastOpenOptions: OpenOptions | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  async openPanel(options: OpenOptions): Promise<void> {
    this.lastOpenOptions = options;
    await this.ensureWorker(options);

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        SIDE_CAR_PANEL_TYPE,
        "BrainrotMaxxing Sidecar",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
      this.panel.webview.onDidReceiveMessage(async (message: any) => {
        if (message?.type === "restart") {
          await this.restart();
        }
      });
    }

    const port = this.stats.port;
    if (!port) {
      throw new Error("Sidecar did not report a running port.");
    }

    this.panel.title = "BrainrotMaxxing Sidecar";
    this.panel.webview.html = getPanelHtml(this.panel.webview, port, options.startUrl);
    this.panel.reveal(vscode.ViewColumn.Beside, false);
  }

  async restart(): Promise<void> {
    if (!this.lastOpenOptions) {
      throw new Error("No previous sidecar session to restart.");
    }
    await this.stopWorker();
    await this.ensureWorker(this.lastOpenOptions);
    if (this.panel && this.stats.port) {
      await this.panel.webview.postMessage({
        type: "sidecarPort",
        payload: {
          port: this.stats.port,
          startUrl: this.lastOpenOptions.startUrl,
        },
      });
    }
  }

  async resetSession(): Promise<void> {
    await this.stopWorker();
  }

  getStats(): SidecarStats {
    return { ...this.stats };
  }

  dispose(): void {
    void this.stopWorker();
  }

  private async ensureWorker(options: OpenOptions): Promise<void> {
    if (this.worker && this.stats.running) {
      return;
    }
    if (this.worker) {
      await this.stopWorker();
    }

    await fs.mkdir(options.profileDir, { recursive: true });
    const port = await reserveFreePort();
    const workerScriptPath = getWorkerScriptPath(__dirname);
    if (!(await pathExists(workerScriptPath))) {
      throw new Error(`Worker script is missing at ${workerScriptPath}`);
    }

    const config = {
      port,
      executablePath: options.runtime.executablePath,
      profileDir: options.profileDir,
      startUrl: options.startUrl,
      viewportMode: options.viewportMode,
      fpsCap: options.fpsCap,
      audioEnabled: options.audioEnabled,
    };

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [workerScriptPath], {
        env: {
          ...process.env,
          BRAINROTMAXXING_SIDECAR_CONFIG: JSON.stringify(config),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.worker = child;
      if (!child.stdout) {
        reject(new Error("Sidecar worker stdout was not available."));
        return;
      }
      this.workerReadline = readline.createInterface({ input: child.stdout });

      let resolved = false;
      const readyTimeout = setTimeout(() => {
        if (resolved) {
          return;
        }
        resolved = true;
        reject(new Error("Timed out waiting for sidecar worker to become ready."));
      }, 15000);

      const handleReady = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(readyTimeout);
        resolve();
      };

      this.workerReadline.on("line", (line) => {
        const parsed = safeParseLog(line);
        if (!parsed) {
          return;
        }
        this.onWorkerLog(parsed);
        if (parsed.type === "ready") {
          handleReady();
        }
        if (parsed.type === "fatal" && !resolved) {
          resolved = true;
          clearTimeout(readyTimeout);
          reject(new Error(`Worker fatal: ${JSON.stringify(parsed.payload)}`));
        }
      });

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        this.output.appendLine(`[sidecar:stderr] ${text}`);
      });

      child.on("exit", (code, signal) => {
        this.stats.running = false;
        this.stats.port = null;
        this.stats.lastError = `Exited (code=${String(code)} signal=${String(
          signal
        )})`;
        this.output.appendLine(`[sidecar] exited ${this.stats.lastError}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(readyTimeout);
          reject(new Error(this.stats.lastError));
        }
      });
    });
  }

  private async stopWorker(): Promise<void> {
    if (!this.worker) {
      return;
    }

    const worker = this.worker;
    this.worker = null;
    this.stats.running = false;
    this.stats.port = null;
    this.workerReadline?.close();
    this.workerReadline = null;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          worker.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 3000);

      worker.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        worker.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  private onWorkerLog(log: WorkerLog): void {
    if (log.type === "ready") {
      const payload = (log.payload ?? {}) as { port?: number };
      this.stats.running = true;
      this.stats.port = payload.port ?? null;
      this.stats.lastError = null;
      this.output.appendLine(`[sidecar] ready on port ${String(this.stats.port)}`);
      return;
    }

    if (log.type === "codecProbe") {
      const payload = (log.payload ?? {}) as {
        support?: "supported" | "unsupported";
      };
      this.stats.codecSupport = payload.support ?? "unknown";
      this.stats.codecDetails = JSON.stringify(log.payload ?? {});
      return;
    }

    if (log.type === "stats") {
      const payload = (log.payload ?? {}) as Partial<SidecarStats>;
      this.stats = {
        ...this.stats,
        running: true,
        fps:
          typeof payload.fps === "number" || payload.fps === null
            ? payload.fps
            : this.stats.fps,
        averageFrameLatencyMs:
          typeof payload.averageFrameLatencyMs === "number" ||
          payload.averageFrameLatencyMs === null
            ? payload.averageFrameLatencyMs
            : this.stats.averageFrameLatencyMs,
        droppedFrames:
          typeof payload.droppedFrames === "number"
            ? payload.droppedFrames
            : this.stats.droppedFrames,
        transportConnectedClients:
          typeof payload.transportConnectedClients === "number"
            ? payload.transportConnectedClients
            : this.stats.transportConnectedClients,
        lastFrameAt:
          typeof payload.lastFrameAt === "string" || payload.lastFrameAt === null
            ? payload.lastFrameAt
            : this.stats.lastFrameAt,
        lastError:
          typeof payload.lastError === "string" || payload.lastError === null
            ? payload.lastError
            : this.stats.lastError,
        codecSupport:
          payload.codecSupport === "supported" || payload.codecSupport === "unsupported"
            ? payload.codecSupport
            : this.stats.codecSupport,
        codecDetails:
          typeof payload.codecDetails === "string" || payload.codecDetails === null
            ? payload.codecDetails
            : this.stats.codecDetails,
      };
      return;
    }

    if (log.type === "fatal") {
      this.stats.lastError = JSON.stringify(log.payload);
      this.output.appendLine(`[sidecar] fatal ${this.stats.lastError}`);
    }
  }
}

function getPanelHtml(webview: vscode.Webview, port: number, startUrl: string): string {
  const nonce = createNonce();
  const escapedUrl = escapeHtml(startUrl);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ws://127.0.0.1:*;"
    />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: #0f1115;
        color: #e6edf3;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        overflow: hidden;
      }
      .root {
        position: relative;
        width: 100%;
        height: 100%;
        background: #0b0e13;
      }
      .toolbar {
        position: absolute;
        z-index: 5;
        left: 8px;
        right: 8px;
        top: 8px;
        display: flex;
        gap: 8px;
        padding: 8px;
        background: rgba(18, 25, 34, 0.92);
        border: 1px solid #2a3240;
        border-radius: 10px;
        backdrop-filter: blur(4px);
        opacity: 0;
        transform: translateY(-8px);
        pointer-events: none;
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .root:hover .toolbar,
      .root:focus-within .toolbar {
        opacity: 1;
        transform: translateY(0px);
        pointer-events: auto;
      }
      .toolbar input {
        flex: 1;
        min-width: 0;
        background: #0f1115;
        color: #e6edf3;
        border: 1px solid #303846;
        border-radius: 6px;
        padding: 6px 8px;
      }
      .toolbar button {
        background: #2563eb;
        color: #ffffff;
        border: none;
        border-radius: 6px;
        padding: 6px 10px;
        cursor: pointer;
      }
      .viewer-wrap {
        position: absolute;
        inset: 0;
        overflow: hidden;
        background: #000000;
      }
      #viewer {
        width: 100%;
        height: 100%;
        object-fit: contain;
        user-select: none;
        outline: none;
      }
      .status {
        position: absolute;
        z-index: 6;
        left: 12px;
        bottom: 12px;
        background: rgba(22, 27, 34, 0.92);
        border: 1px solid #303846;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 120ms ease, transform 120ms ease;
        pointer-events: none;
      }
      .status.visible {
        opacity: 1;
        transform: translateY(0px);
      }
      .overlay {
        position: absolute;
        inset: 0;
        display: none;
        place-items: center;
        background: rgba(8, 10, 14, 0.78);
      }
      .overlay.visible {
        display: grid;
      }
      .overlay-card {
        background: #161b22;
        border: 1px solid #303846;
        border-radius: 8px;
        padding: 12px;
        display: flex;
        gap: 10px;
        align-items: center;
      }
      .overlay-card button {
        background: #f59e0b;
        color: #111827;
        border: none;
        border-radius: 6px;
        padding: 5px 8px;
      }
    </style>
  </head>
  <body>
    <div class="root">
      <div class="toolbar">
        <input id="url" value="${escapedUrl}" />
        <button id="go">Go</button>
        <button id="restart">${ACTION_RESTART_SIDECAR}</button>
      </div>
      <div id="viewer-wrap" class="viewer-wrap">
        <img id="viewer" tabindex="0" draggable="false" />
        <div id="overlay" class="overlay">
          <div class="overlay-card">
            <span>Sidecar stream heartbeat lost.</span>
            <button id="overlay-restart">${ACTION_RESTART_SIDECAR}</button>
          </div>
        </div>
      </div>
      <div id="status" class="status"></div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const viewer = document.getElementById("viewer");
      const viewerWrap = document.getElementById("viewer-wrap");
      const statusEl = document.getElementById("status");
      const overlay = document.getElementById("overlay");
      const urlInput = document.getElementById("url");
      const goButton = document.getElementById("go");
      const restartButton = document.getElementById("restart");
      const overlayRestartButton = document.getElementById("overlay-restart");
      let ws = null;
      let port = ${port};
      let frameWidth = 1280;
      let frameHeight = 720;
      let lastPongAt = 0;
      let lastMessageAt = 0;
      let pingTimer = null;
      let reconnectTimer = null;
      let resizeTimer = null;
      let statusTimer = null;
      let connected = false;

      const setStatus = (text, sticky = false) => {
        if (!text) {
          statusEl.classList.remove("visible");
          statusEl.textContent = "";
          return;
        }
        statusEl.textContent = text;
        statusEl.classList.add("visible");
        if (statusTimer) {
          clearTimeout(statusTimer);
          statusTimer = null;
        }
        if (!sticky) {
          statusTimer = setTimeout(() => {
            statusEl.classList.remove("visible");
          }, 1800);
        }
      };

      const showOverlay = (visible) => {
        overlay.classList.toggle("visible", visible);
      };

      const connect = () => {
        if (!port) {
          setStatus("Missing sidecar port.", true);
          return;
        }
        if (ws) {
          try { ws.close(); } catch {}
          ws = null;
        }
        setStatus("Connecting to sidecar...", true);
        ws = new WebSocket("ws://127.0.0.1:" + port);

        ws.onopen = () => {
          connected = true;
          lastPongAt = Date.now();
          lastMessageAt = Date.now();
          setStatus("Connected.");
          showOverlay(false);
          pushResize();
          viewer.focus();
          if (pingTimer) {
            clearInterval(pingTimer);
          }
          pingTimer = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping", payload: { ts: Date.now() } }));
            }
          }, 2000);
        };

        ws.onmessage = (event) => {
          lastMessageAt = Date.now();
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === "frame" && message.payload) {
            const payload = message.payload;
            frameWidth = payload.width || frameWidth;
            frameHeight = payload.height || frameHeight;
            viewer.src = "data:image/jpeg;base64," + payload.data;
            showOverlay(false);
            return;
          }
          if (message.type === "hello") {
            setStatus("Sidecar stream ready.");
            return;
          }
          if (message.type === "pong") {
            lastPongAt = Date.now();
            return;
          }
        };

        ws.onclose = () => {
          connected = false;
          setStatus("Disconnected. Reconnecting...", true);
          showOverlay(true);
          if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
          }
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }
          reconnectTimer = setTimeout(connect, 1000);
        };

        ws.onerror = () => {
          setStatus("Connection error.", true);
        };
      };

      const send = (message) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return;
        }
        ws.send(JSON.stringify(message));
      };

      const pushResize = () => {
        if (!viewerWrap) {
          return;
        }
        const rect = viewerWrap.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          return;
        }
        send({
          type: "resize",
          payload: {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      };

      const scheduleResize = () => {
        if (resizeTimer) {
          clearTimeout(resizeTimer);
        }
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          pushResize();
        }, 80);
      };

      const mapCoords = (event) => {
        const rect = viewer.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          return { x: 0, y: 0 };
        }
        const x = Math.max(0, Math.min(frameWidth, ((event.clientX - rect.left) / rect.width) * frameWidth));
        const y = Math.max(0, Math.min(frameHeight, ((event.clientY - rect.top) / rect.height) * frameHeight));
        return { x, y };
      };

      viewer.addEventListener("mousemove", (event) => {
        const { x, y } = mapCoords(event);
        send({ type: "input", payload: { kind: "mouse", eventType: "move", x, y } });
      });
      viewer.addEventListener("mousedown", (event) => {
        const { x, y } = mapCoords(event);
        send({ type: "input", payload: { kind: "mouse", eventType: "down", x, y, button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left" } });
        event.preventDefault();
      });
      viewer.addEventListener("mouseup", (event) => {
        const { x, y } = mapCoords(event);
        send({ type: "input", payload: { kind: "mouse", eventType: "up", x, y, button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left" } });
      });
      viewer.addEventListener("wheel", (event) => {
        const { x, y } = mapCoords(event);
        send({ type: "input", payload: { kind: "wheel", x, y, deltaX: event.deltaX, deltaY: event.deltaY } });
        event.preventDefault();
      }, { passive: false });
      viewer.addEventListener("keydown", (event) => {
        send({ type: "input", payload: { kind: "key", eventType: "down", key: event.key, code: event.code, keyCode: event.keyCode || event.which || 0 } });
      });
      viewer.addEventListener("keyup", (event) => {
        send({ type: "input", payload: { kind: "key", eventType: "up", key: event.key, code: event.code, keyCode: event.keyCode || event.which || 0 } });
      });

      goButton.addEventListener("click", () => {
        const url = String(urlInput.value || "").trim();
        if (!url) {
          return;
        }
        send({ type: "navigate", payload: { url } });
      });
      urlInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          goButton.click();
        }
      });

      restartButton.addEventListener("click", () => {
        vscode.postMessage({ type: "restart" });
      });
      overlayRestartButton.addEventListener("click", () => {
        vscode.postMessage({ type: "restart" });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") {
          return;
        }
        if (message.type === "sidecarPort" && message.payload) {
          port = message.payload.port;
          if (message.payload.startUrl) {
            urlInput.value = message.payload.startUrl;
          }
          connect();
        }
      });

      window.addEventListener("resize", scheduleResize);
      if (typeof ResizeObserver === "function" && viewerWrap) {
        const resizeObserver = new ResizeObserver(() => scheduleResize());
        resizeObserver.observe(viewerWrap);
      }

      setInterval(() => {
        if (!connected) {
          showOverlay(true);
          return;
        }
        const now = Date.now();
        const stalePong = lastPongAt !== 0 && now - lastPongAt > 30000;
        const staleInbound = lastMessageAt !== 0 && now - lastMessageAt > 45000;
        showOverlay(stalePong || staleInbound);
      }, 1000);

      connect();
      scheduleResize();
    </script>
  </body>
</html>`;
}

async function reserveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a local port."));
        return;
      }
      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

function safeParseLog(value: string): WorkerLog | null {
  try {
    const parsed = JSON.parse(value) as WorkerLog;
    if (!parsed || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
