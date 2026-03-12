import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright-core";

interface WorkerConfig {
  port: number;
  executablePath: string;
  profileDir: string;
  startUrl: string;
  viewportMode: "mobile" | "desktop";
  fpsCap: number;
  audioEnabled: boolean;
}

interface SidecarStatsSnapshot {
  fps: number | null;
  averageFrameLatencyMs: number | null;
  droppedFrames: number;
  transportConnectedClients: number;
  lastFrameAt: string | null;
  lastError: string | null;
  codecSupport: "unknown" | "supported" | "unsupported";
  codecDetails: string | null;
}

interface CodecProbeResult {
  support: "supported" | "unsupported";
  mediaSourceAvailable: boolean;
  h264Baseline: boolean;
  h264Main: boolean;
  h264High: boolean;
  aac: boolean;
  webmVp9: boolean;
}

type InboundMessage =
  | {
      type: "input";
      payload:
        | {
            kind: "mouse";
            eventType: "move" | "down" | "up";
            x: number;
            y: number;
            button?: "left" | "middle" | "right";
          }
        | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
        | {
            kind: "key";
            eventType: "down" | "up";
            key: string;
            code: string;
            keyCode: number;
          };
    }
  | { type: "navigate"; payload: { url: string } }
  | { type: "resize"; payload: { width: number; height: number } }
  | { type: "ping"; payload: { ts: number } };

interface OutboundMessage {
  type: string;
  payload?: unknown;
}

async function main(): Promise<void> {
  const config = parseConfig();
  const stats: SidecarStatsSnapshot = {
    fps: null,
    averageFrameLatencyMs: null,
    droppedFrames: 0,
    transportConnectedClients: 0,
    lastFrameAt: null,
    lastError: null,
    codecSupport: "unknown",
    codecDetails: null,
  };

  const wss = new WebSocketServer({ port: config.port });
  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.executablePath,
    headless: true,
    viewport:
      config.viewportMode === "mobile"
        ? { width: 420, height: 860 }
        : { width: 1280, height: 720 },
    isMobile: config.viewportMode === "mobile",
    hasTouch: config.viewportMode === "mobile",
    userAgent:
      config.viewportMode === "mobile"
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        : undefined,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=BlockInsecurePrivateNetworkRequests",
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
  const codecProbe = await probeCodecs(page);
  stats.codecSupport = codecProbe.support;
  stats.codecDetails = JSON.stringify(codecProbe);
  writeLog({
    type: "codecProbe",
    payload: codecProbe,
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 70,
    everyNthFrame: everyNthFrameFromFps(config.fpsCap),
  });

  let frameCount = 0;
  let frameLatencyTotal = 0;
  let frameLatencyCount = 0;

  cdp.on("Page.screencastFrame", async (event: any) => {
    const now = Date.now();
    frameCount += 1;
    stats.lastFrameAt = new Date(now).toISOString();

    const frameTimestampMs =
      typeof event?.metadata?.timestamp === "number"
        ? event.metadata.timestamp * 1000
        : null;
    if (frameTimestampMs !== null) {
      const latency = Math.max(0, now - frameTimestampMs);
      frameLatencyTotal += latency;
      frameLatencyCount += 1;
      stats.averageFrameLatencyMs = frameLatencyTotal / frameLatencyCount;
    }

    const payload = {
      type: "frame",
      payload: {
        data: event.data,
        width: event?.metadata?.deviceWidth ?? null,
        height: event?.metadata?.deviceHeight ?? null,
      },
    };
    const body = JSON.stringify(payload);

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (client.bufferedAmount > 2 * 1024 * 1024) {
        stats.droppedFrames += 1;
        continue;
      }
      client.send(body);
    }

    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
    } catch (error) {
      stats.lastError = toErrorMessage(error);
    }
  });

  wss.on("connection", (socket) => {
    stats.transportConnectedClients = wss.clients.size;
    send(socket, {
      type: "hello",
      payload: {
        viewportMode: config.viewportMode,
      },
    });
    socket.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as InboundMessage;
        await handleMessage(message, page, cdp, socket);
      } catch (error) {
        stats.lastError = toErrorMessage(error);
      }
    });
    socket.on("close", () => {
      stats.transportConnectedClients = wss.clients.size;
    });
  });

  const statsTimer = setInterval(() => {
    const nextFps = frameCount;
    frameCount = 0;
    stats.fps = nextFps;
    stats.transportConnectedClients = wss.clients.size;
    writeLog({
      type: "stats",
      payload: stats,
    });
  }, 1000);

  writeLog({
    type: "ready",
    payload: {
      port: config.port,
      pid: process.pid,
      audioEnabled: config.audioEnabled,
    },
  });

  const shutdown = async () => {
    clearInterval(statsTimer);
    try {
      await context.close();
    } catch {
      // ignore
    }
    try {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function parseConfig(): WorkerConfig {
  const raw = process.env.BRAINROTMAXXING_SIDECAR_CONFIG;
  if (!raw) {
    throw new Error("Missing BRAINROTMAXXING_SIDECAR_CONFIG env.");
  }
  const parsed = JSON.parse(raw) as WorkerConfig;
  if (!parsed.port || !parsed.executablePath || !parsed.profileDir) {
    throw new Error("Invalid sidecar config.");
  }
  return parsed;
}

async function handleMessage(
  message: InboundMessage,
  page: any,
  cdp: any,
  socket: WebSocket
): Promise<void> {
  if (message.type === "ping") {
    send(socket, { type: "pong", payload: { ts: message.payload.ts } });
    return;
  }
  if (message.type === "navigate") {
    await page.goto(message.payload.url, { waitUntil: "domcontentloaded" });
    return;
  }
  if (message.type === "resize") {
    const width = clampDimension(message.payload.width);
    const height = clampDimension(message.payload.height);
    await page.setViewportSize({ width, height });
    return;
  }
  if (message.type !== "input") {
    return;
  }

  const payload = message.payload;
  if (payload.kind === "mouse") {
    await cdp.send("Input.dispatchMouseEvent", {
      type:
        payload.eventType === "move"
          ? "mouseMoved"
          : payload.eventType === "down"
            ? "mousePressed"
            : "mouseReleased",
      x: payload.x,
      y: payload.y,
      button: payload.button ?? "left",
      clickCount: 1,
    });
    return;
  }

  if (payload.kind === "wheel") {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: payload.x,
      y: payload.y,
      deltaX: payload.deltaX,
      deltaY: payload.deltaY,
    });
    return;
  }

  if (payload.kind === "key") {
    await cdp.send("Input.dispatchKeyEvent", {
      type: payload.eventType === "down" ? "keyDown" : "keyUp",
      key: payload.key,
      code: payload.code,
      windowsVirtualKeyCode: payload.keyCode,
      nativeVirtualKeyCode: payload.keyCode,
      text:
        payload.eventType === "down" && payload.key.length === 1
          ? payload.key
          : undefined,
    });
  }
}

function send(socket: WebSocket, message: OutboundMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function writeLog(message: OutboundMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function everyNthFrameFromFps(fpsCap: number): number {
  const clamped = Math.max(5, Math.min(60, Math.round(fpsCap)));
  if (clamped >= 30) {
    return 1;
  }
  return Math.max(1, Math.round(30 / clamped));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return 800;
  }
  return Math.max(320, Math.min(4096, Math.round(value)));
}

async function probeCodecs(page: any): Promise<CodecProbeResult> {
  try {
    const result = await page.evaluate(() => {
      const mediaSourceCtor = (globalThis as any).MediaSource;
      const hasMediaSource =
        typeof mediaSourceCtor !== "undefined" &&
        typeof mediaSourceCtor.isTypeSupported === "function";
      const supports = (mime: string): boolean => {
        if (!hasMediaSource) {
          return false;
        }
        try {
          return mediaSourceCtor.isTypeSupported(mime);
        } catch {
          return false;
        }
      };

      const h264Baseline = supports('video/mp4; codecs=\"avc1.42E01E\"');
      const h264Main = supports('video/mp4; codecs=\"avc1.4D401E\"');
      const h264High = supports('video/mp4; codecs=\"avc1.64001F\"');
      const aac = supports('audio/mp4; codecs=\"mp4a.40.2\"');
      const webmVp9 = supports('video/webm; codecs=\"vp09.00.10.08\"');
      const support =
        hasMediaSource && (h264Baseline || h264Main || h264High) && aac
          ? "supported"
          : "unsupported";

      return {
        support,
        mediaSourceAvailable: hasMediaSource,
        h264Baseline,
        h264Main,
        h264High,
        aac,
        webmVp9,
      };
    });

    return result as CodecProbeResult;
  } catch (error) {
    return {
      support: "unsupported",
      mediaSourceAvailable: false,
      h264Baseline: false,
      h264Main: false,
      h264High: false,
      aac: false,
      webmVp9: false,
    };
  }
}

main().catch((error) => {
  writeLog({
    type: "fatal",
    payload: {
      message: toErrorMessage(error),
    },
  });
  process.exit(1);
});
