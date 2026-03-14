import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright-core";

interface WorkerConfig {
  port: number;
  executablePath: string;
  profileDir: string;
  startUrl: string;
  connectionPath: string;
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
  audioStreaming: boolean;
  audioMimeType: string | null;
  audioChunksSent: number;
  lastAudioAt: string | null;
  audioError: string | null;
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

interface AudioBridgeChunkPayload {
  data: string;
  mimeType: string;
}

interface AudioBridgeStatusPayload {
  streaming: boolean;
  mimeType?: string | null;
  error?: string | null;
}

interface AudioBridgeMessage {
  type: "audioChunk" | "audioStatus";
  payload: AudioBridgeChunkPayload | AudioBridgeStatusPayload;
}

async function main(): Promise<void> {
  const config = parseConfig();
  const useSystemAudioWindow = config.audioEnabled;
  const stats: SidecarStatsSnapshot = {
    fps: null,
    averageFrameLatencyMs: null,
    droppedFrames: 0,
    transportConnectedClients: 0,
    lastFrameAt: null,
    lastError: null,
    codecSupport: "unknown",
    codecDetails: null,
    audioStreaming: false,
    audioMimeType: null,
    audioChunksSent: 0,
    lastAudioAt: null,
    audioError: null,
  };
  if (useSystemAudioWindow) {
    stats.audioStreaming = true;
    stats.audioMimeType = "system-browser";
  }

  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: config.port,
    path: config.connectionPath,
  });
  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.executablePath,
    headless: !useSystemAudioWindow,
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
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
      ...(useSystemAudioWindow
        ? buildAudioWindowArgs(config.viewportMode)
        : []),
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  if (config.audioEnabled && !useSystemAudioWindow) {
    await installAudioBridge(context, page, wss, stats);
  }
  await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
  const codecProbe = await probeCodecs(page);
  stats.codecSupport = codecProbe.support;
  stats.codecDetails = JSON.stringify(codecProbe);
  writeLog({
    type: "codecProbe",
    payload: codecProbe,
  });

  const cdp = await context.newCDPSession(page);
  if (useSystemAudioWindow) {
    await moveWindowOffscreen(cdp, config.viewportMode);
  }
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
  if (
    !parsed.port ||
    !parsed.executablePath ||
    !parsed.profileDir ||
    !parsed.connectionPath ||
    !parsed.connectionPath.startsWith("/")
  ) {
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

function broadcast(
  wss: WebSocketServer,
  message: OutboundMessage,
  maxBufferedAmount: number
): void {
  const body = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) {
      continue;
    }
    if (client.bufferedAmount > maxBufferedAmount) {
      continue;
    }
    client.send(body);
  }
}

function buildAudioWindowArgs(viewportMode: "mobile" | "desktop"): string[] {
  const bounds =
    viewportMode === "mobile"
      ? { width: 480, height: 920 }
      : { width: 1280, height: 720 };
  return [
    `--window-size=${bounds.width},${bounds.height}`,
    "--window-position=-32000,0",
  ];
}

function writeLog(message: OutboundMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function moveWindowOffscreen(
  cdp: any,
  viewportMode: "mobile" | "desktop"
): Promise<void> {
  const bounds =
    viewportMode === "mobile"
      ? { width: 480, height: 920 }
      : { width: 1280, height: 720 };
  try {
    const windowInfo = await cdp.send("Browser.getWindowForTarget");
    if (!windowInfo || typeof windowInfo.windowId !== "number") {
      return;
    }
    await cdp.send("Browser.setWindowBounds", {
      windowId: windowInfo.windowId,
      bounds: {
        left: -32000,
        top: 0,
        width: bounds.width,
        height: bounds.height,
        windowState: "normal",
      },
    });
  } catch {
    // Window management is best-effort and not available on every platform/runtime.
  }
}

async function installAudioBridge(
  context: any,
  page: any,
  wss: WebSocketServer,
  stats: SidecarStatsSnapshot
): Promise<void> {
  await context.exposeBinding(
    "__brainrotmaxxingAudioBridge",
    async (_source: unknown, message: unknown) => {
      const parsed = parseAudioBridgeMessage(message);
      if (!parsed) {
        return;
      }

      if (parsed.type === "audioStatus") {
        const payload = parsed.payload as AudioBridgeStatusPayload;
        stats.audioStreaming = payload.streaming;
        stats.audioMimeType = payload.mimeType ?? stats.audioMimeType;
        stats.audioError = payload.error ?? null;
        broadcast(
          wss,
          {
            type: "audioStatus",
            payload: {
              streaming: stats.audioStreaming,
              mimeType: stats.audioMimeType,
              error: stats.audioError,
            },
          },
          256 * 1024
        );
        return;
      }

      const payload = parsed.payload as AudioBridgeChunkPayload;
      stats.audioStreaming = true;
      stats.audioMimeType = payload.mimeType;
      stats.audioError = null;
      stats.audioChunksSent += 1;
      stats.lastAudioAt = new Date().toISOString();
      broadcast(
        wss,
        {
          type: "audioChunk",
          payload,
        },
        512 * 1024
      );
    }
  );

  await page.addInitScript(() => {
    const globalScope = globalThis as any;
    if (typeof globalScope.__brainrotmaxxingInstallAudioBridge === "function") {
      globalScope.__brainrotmaxxingInstallAudioBridge();
      return;
    }

    globalScope.__brainrotmaxxingInstallAudioBridge = () => {
      const documentScope = globalScope.document;
      const windowScope = globalScope;
      const MutationObserverCtor = globalScope.MutationObserver;
      const MediaRecorderCtor = globalScope.MediaRecorder;
      const MediaStreamCtor = globalScope.MediaStream;
      const FileReaderCtor = globalScope.FileReader;
      const bridge = (globalScope.__brainrotmaxxingAudioState ??= {
        attachedVideo: null as any,
        recorder: null as any,
        monitorTimer: null as number | null,
        mutationObserver: null as any,
        statusSignature: "",
        activeMimeType: null as string | null,
      });

      const emit = async (type: "audioChunk" | "audioStatus", payload: unknown) => {
        const fn = globalScope.__brainrotmaxxingAudioBridge;
        if (typeof fn !== "function") {
          return;
        }
        try {
          await fn({ type, payload });
        } catch {
          // ignore bridge delivery failures inside the page
        }
      };

      const emitStatus = async (payload: {
        streaming: boolean;
        mimeType?: string | null;
        error?: string | null;
      }) => {
        const signature = JSON.stringify(payload);
        if (signature === bridge.statusSignature) {
          return;
        }
        bridge.statusSignature = signature;
        await emit("audioStatus", payload);
      };

      const stopRecorder = async (payload?: {
        streaming: boolean;
        mimeType?: string | null;
        error?: string | null;
      }) => {
        const recorder = bridge.recorder;
        bridge.recorder = null;
        if (recorder && recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // ignore
          }
        }
        bridge.attachedVideo = null;
        bridge.activeMimeType = null;
        if (payload) {
          await emitStatus(payload);
        }
      };

      const chooseVideo = () => {
        const videos = Array.from(documentScope.querySelectorAll("video")) as any[];
        const scored = videos
          .map((video) => {
            const rect = video.getBoundingClientRect();
            const area = rect.width * rect.height;
            const visible =
              area > 0 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < windowScope.innerHeight &&
              rect.left < windowScope.innerWidth;
            return { video, visible, area };
          })
          .filter((entry) => entry.visible)
          .sort((left, right) => right.area - left.area);
        return scored[0]?.video ?? null;
      };

      const chooseMimeType = (): string | null => {
        if (typeof MediaRecorderCtor === "undefined") {
          return null;
        }
        const candidates = [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/mp4;codecs=mp4a.40.2",
        ];
        for (const candidate of candidates) {
          if (MediaRecorderCtor.isTypeSupported(candidate)) {
            return candidate;
          }
        }
        return null;
      };

      const blobToBase64 = (blob: any): Promise<string> =>
        new Promise((resolve, reject) => {
          const reader = new FileReaderCtor();
          reader.onerror = () => reject(reader.error ?? new Error("FileReader failed."));
          reader.onloadend = () => {
            const result = typeof reader.result === "string" ? reader.result : "";
            const commaIndex = result.indexOf(",");
            resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
          };
          reader.readAsDataURL(blob);
        });

      const startRecorder = async (video: any) => {
        if (bridge.attachedVideo === video && bridge.recorder?.state === "recording") {
          return;
        }

        await stopRecorder();

        if (typeof video.captureStream !== "function") {
          await emitStatus({
            streaming: false,
            error: "captureStream() is unavailable in the browser runtime.",
          });
          return;
        }

        try {
          video.muted = false;
          const playPromise = video.play();
          if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => undefined);
          }
        } catch {
          // ignore autoplay-related failures
        }

        const captureStream = video.captureStream();
        const audioTracks = captureStream.getAudioTracks();
        if (audioTracks.length === 0) {
          await emitStatus({
            streaming: false,
            error: "Active reel did not expose an audio track.",
          });
          return;
        }

        const mimeType = chooseMimeType();
        if (!mimeType) {
          await emitStatus({
            streaming: false,
            error: "No supported audio recorder codec was found.",
          });
          return;
        }

        const recorder = new MediaRecorderCtor(new MediaStreamCtor(audioTracks), {
          mimeType,
          audioBitsPerSecond: 128000,
        });
        bridge.attachedVideo = video;
        bridge.recorder = recorder;
        bridge.activeMimeType = mimeType;

        recorder.addEventListener("dataavailable", async (event: any) => {
          if (!event.data || event.data.size === 0) {
            return;
          }
          try {
            await emit("audioChunk", {
              mimeType,
              data: await blobToBase64(event.data),
            });
          } catch (error) {
            await emitStatus({
              streaming: false,
              mimeType,
              error:
                error instanceof Error ? error.message : "Failed to serialize audio chunk.",
            });
          }
        });

        recorder.addEventListener("error", async (event: any) => {
          const recorderError = event.error;
          await emitStatus({
            streaming: false,
            mimeType,
            error:
              recorderError instanceof Error
                ? recorderError.message
                : "MediaRecorder reported an audio error.",
          });
        });

        recorder.addEventListener("stop", async () => {
          if (bridge.attachedVideo !== video) {
            return;
          }
          await emitStatus({
            streaming: false,
            mimeType,
            error: null,
          });
        });

        recorder.start(250);
        await emitStatus({
          streaming: true,
          mimeType,
          error: null,
        });
      };

      const syncActiveVideo = async () => {
        const video = chooseVideo();
        if (!video) {
          await stopRecorder({
            streaming: false,
            error: "No active reel video was found.",
          });
          return;
        }
        await startRecorder(video);
      };

      if (!bridge.monitorTimer) {
        bridge.monitorTimer = windowScope.setInterval(() => {
          void syncActiveVideo();
        }, 1000);
      }
      if (!bridge.mutationObserver && MutationObserverCtor) {
        bridge.mutationObserver = new MutationObserverCtor(() => {
          void syncActiveVideo();
        });
        bridge.mutationObserver.observe(documentScope.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["src", "style", "class"],
        });
      }

      void syncActiveVideo();
      windowScope.addEventListener("pagehide", () => {
        void stopRecorder({ streaming: false, error: null });
      });
    };

    globalScope.__brainrotmaxxingInstallAudioBridge();
  });

  await page.evaluate(() => {
    const globalScope = globalThis as any;
    if (typeof globalScope.__brainrotmaxxingInstallAudioBridge === "function") {
      globalScope.__brainrotmaxxingInstallAudioBridge();
    }
  });
}

function parseAudioBridgeMessage(value: unknown): AudioBridgeMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { type?: unknown; payload?: unknown };
  if (
    candidate.type !== "audioChunk" &&
    candidate.type !== "audioStatus"
  ) {
    return null;
  }
  return candidate as AudioBridgeMessage;
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
