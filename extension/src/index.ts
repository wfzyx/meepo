import type { ExtensionAPI, ExtensionContext } from "./types.js";
import { ProxyManager } from "./proxy-manager.js";
import { SessionTracker } from "./session-tracker.js";
import { ConfigManager, type MeepoSettings } from "./config-manager.js";
import { randomUUID } from "node:crypto";

export default function meepoExtension(pi: ExtensionAPI) {
  const configManager = new ConfigManager();
  let settings = configManager.load();

  const host = process.env.MEEPO_HOST || settings.host;
  const port = process.env.MEEPO_PORT ? parseInt(process.env.MEEPO_PORT, 10) : settings.port;
  const useDocker = process.env.MEEPO_USE_DOCKER !== undefined
    ? process.env.MEEPO_USE_DOCKER === "1"
    : settings.runner === "docker";
  const containerName = process.env.MEEPO_CONTAINER_NAME || settings.containerName;
  const customBin = process.env.MEEPO_BIN;

  let proxyManager = new ProxyManager({
    host,
    port,
    useDocker,
    containerName,
    binPath: customBin,
  });

  let sessionTracker: SessionTracker | null = null;
  let isProxyHealthy = false;

  // ─── Lifecycle: session_start ──────────────────────────────────────────────
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    // Unique session identifier for this Pi process/context
    const sessionId = (ctx as any).sessionId || `pi-session-${process.pid}-${randomUUID().slice(0, 8)}`;
    sessionTracker = new SessionTracker(sessionId);
    sessionTracker.register();

    ctx.ui.setStatus("meepo", ctx.ui.theme.fg("dim", "⏳ Checking Meepo..."));

    isProxyHealthy = await proxyManager.checkHealth();
    if (!isProxyHealthy) {
      ctx.ui.setStatus("meepo", ctx.ui.theme.fg("dim", "⏳ Starting Meepo proxy..."));
      const started = await proxyManager.ensureRunning((msg) => {
        ctx.ui.setStatus("meepo", ctx.ui.theme.fg("dim", `⏳ ${msg}`));
      });

      isProxyHealthy = started;
    }

    if (isProxyHealthy) {
      const modeLabel = proxyManager.mode === "docker" ? "docker" : "bin";
      const warmLabel = settings.warmupPrefill ? " 🔥" : "";
      ctx.ui.setStatus(
        "meepo",
        ctx.ui.theme.fg("success", "🟢") + ctx.ui.theme.fg("dim", ` Meepo [${modeLabel}${warmLabel}]`),
      );

      // Background prefill Turn 1 warmup if enabled
      if (settings.warmupPrefill) {
        configManager.triggerWarmup(proxyManager.baseUrl);
      }
    } else {
      ctx.ui.setStatus(
        "meepo",
        ctx.ui.theme.fg("warning", "⚠️") + ctx.ui.theme.fg("dim", " Meepo offline"),
      );
    }
  });

  // ─── Lifecycle: session_shutdown ───────────────────────────────────────────
  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    if (!sessionTracker) return;

    const { remainingCount, isLastSession } = sessionTracker.unregister();

    if (isLastSession) {
      // Last active Pi session exited: auto-teardown Meepo server/container!
      ctx.ui.setStatus("meepo", ctx.ui.theme.fg("dim", "⏳ Stopping Meepo (last exit)..."));
      await proxyManager.stop();
    }
  });

  // ─── Real-Time Stream Telemetry (Pi 1.0+) ────────────────────────────────
  let streamTurnStart = 0;
  let firstTokenTime: number | null = null;
  let streamedTokens = 0;
  let lastStatusUpdate = 0;

  const resetStreamStats = () => {
    streamTurnStart = 0;
    firstTokenTime = null;
    streamedTokens = 0;
    lastStatusUpdate = 0;
  };

  const setReadyStatus = (ctx: ExtensionContext) => {
    if (!isProxyHealthy) {
      ctx.ui.setStatus("meepo", ctx.ui.theme.fg("warning", "⚠️") + ctx.ui.theme.fg("dim", " Meepo offline"));
      return;
    }
    const modeLabel = proxyManager.mode === "docker" ? "docker" : "bin";
    const warmLabel = settings.warmupPrefill ? " 🔥" : "";
    ctx.ui.setStatus(
      "meepo",
      ctx.ui.theme.fg("success", "🟢") + ctx.ui.theme.fg("dim", ` Meepo [${modeLabel}${warmLabel}]`),
    );
  };

  pi.on("turn_start", () => {
    streamTurnStart = performance.now();
    firstTokenTime = null;
    streamedTokens = 0;
    lastStatusUpdate = 0;
  });

  pi.on("provider_stream_event", (event: any, ctx: ExtensionContext) => {
    if (!isProxyHealthy) return;

    const isMeepoModel =
      event.provider === "meepo" ||
      event.provider === "llama.cpp" ||
      (typeof event.model === "string" && (event.model.startsWith("meepo/") || event.model.startsWith("local/")));

    if (!isMeepoModel) return;

    const now = performance.now();
    if (firstTokenTime === null) {
      firstTokenTime = now;
    }

    streamedTokens++;

    if (now - lastStatusUpdate > 100) {
      lastStatusUpdate = now;
      const elapsedSec = (now - firstTokenTime) / 1000;
      const tokPerSec = elapsedSec > 0.05 ? (streamedTokens / elapsedSec).toFixed(1) : "--";
      const ttftMs = Math.round(firstTokenTime - streamTurnStart);
      const shortModel = (event.model || "").replace(/^(meepo|local)\//, "");

      ctx.ui.setStatus(
        "meepo",
        ctx.ui.theme.fg("success", "⚡") +
          ctx.ui.theme.fg("dim", ` Meepo [${shortModel} • ${tokPerSec} t/s • ${ttftMs}ms TTFT]`),
      );
    }
  });

  pi.on("turn_end", (_event: any, ctx: ExtensionContext) => {
    resetStreamStats();
    setReadyStatus(ctx);
  });
  // ─── Command: /meepo ───────────────────────────────────────────────────────
  pi.registerCommand("meepo", {
    description: "Manage Meepo mesh proxy, configure local models & runner settings",
    handler: async (args: string, ctx: ExtensionContext) => {
      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() || "status";

      // ─── Subcommand: settings / config ─────────────────────────────────────
      if (sub === "settings" || sub === "config") {
        const subArgs = parts.slice(1);

        if (subArgs.length === 0) {
          // Interactive TUI configuration dialog
          await configManager.openInteractiveSettings(ctx, async (newSettings: MeepoSettings) => {
            settings = newSettings;
            await proxyManager.stop();
            proxyManager = new ProxyManager({
              host: settings.host,
              port: settings.port,
              useDocker: settings.runner === "docker",
              containerName: settings.containerName,
              binPath: customBin,
            });
            await proxyManager.ensureRunning();
            const modeLabel = proxyManager.mode === "docker" ? "docker" : "bin";
            ctx.ui.setStatus(
              "meepo",
              ctx.ui.theme.fg("success", "🟢") + ctx.ui.theme.fg("dim", ` Meepo [${modeLabel}]`),
            );
          });
          return;
        }

        const action = subArgs[0].toLowerCase();

        if (action === "prefill" || action === "warmup") {
          const val = subArgs[1]?.toLowerCase();
          if (val === "on" || val === "true" || val === "1") {
            settings.warmupPrefill = true;
            configManager.save(settings);
            ctx.ui.notify("KV cache prefill warmup enabled.", "info");
            configManager.triggerWarmup(proxyManager.baseUrl);
          } else if (val === "off" || val === "false" || val === "0") {
            settings.warmupPrefill = false;
            configManager.save(settings);
            ctx.ui.notify("KV cache prefill warmup disabled.", "info");
          } else {
            ctx.ui.notify(
              `KV Cache Warmup: ${settings.warmupPrefill ? "enabled" : "disabled"}. Usage: /meepo settings prefill on|off`,
              "info",
            );
          }
          return;
        }

        if (action === "docker") {
          const val = subArgs[1]?.toLowerCase();
          if (val === "on" || val === "true" || val === "1") {
            settings.runner = "docker";
            configManager.save(settings);
            ctx.ui.notify("Docker runner enabled. Run '/meepo restart' to apply.", "info");
          } else if (val === "off" || val === "false" || val === "0") {
            settings.runner = "binary";
            configManager.save(settings);
            ctx.ui.notify("Docker runner disabled (native binary enabled). Run '/meepo restart' to apply.", "info");
          } else {
            ctx.ui.notify(`Current runner: ${settings.runner}. Usage: /meepo settings docker on|off`, "info");
          }
          return;
        }

        if (action === "model") {
          const role = subArgs[1]?.toLowerCase() as "chat" | "tools" | "code" | "cloud" | undefined;
          const modelId = subArgs[2];
          if (role && modelId && ["chat", "tools", "code", "cloud"].includes(role)) {
            settings.roles[role].modelId = modelId;
            settings.roles[role].name = modelId;
            configManager.save(settings);
            ctx.ui.notify(`Updated ${role} model to '${modelId}'. Run '/meepo restart' to apply.`, "info");
          } else {
            ctx.ui.notify("Usage: /meepo settings model <chat|tools|code|cloud> <modelId>", "warning");
          }
          return;
        }

        if (action === "port") {
          const p = parseInt(subArgs[1], 10);
          if (!isNaN(p) && p > 0 && p < 65536) {
            settings.port = p;
            configManager.save(settings);
            ctx.ui.notify(`Updated proxy port to ${p}. Run '/meepo restart' to apply.`, "info");
          } else {
            ctx.ui.notify("Usage: /meepo settings port <number>", "warning");
          }
          return;
        }

        if (action === "llama") {
          const url = subArgs[1];
          if (url) {
            settings.llamaServer.baseUrl = url;
            configManager.save(settings);
            ctx.ui.notify(`Updated llama-server URL to '${url}'. Run '/meepo restart' to apply.`, "info");
          } else {
            ctx.ui.notify("Usage: /meepo settings llama <url>", "warning");
          }
          return;
        }

        if (action === "show") {
          ctx.ui.notify(
            `Meepo Config (${configManager.getConfigPath()}):\n${JSON.stringify(settings, null, 2)}`,
            "info",
          );
          return;
        }

        ctx.ui.notify("Unknown settings option. Run '/meepo settings' for interactive menu.", "warning");
        return;
      }
      // ─── Subcommand: warmup / prefill ───────────────────────────────────────
      if (sub === "warmup" || sub === "prefill") {
        ctx.ui.notify("Triggering KV cache prefill warmup on llama-server...", "info");
        const ok = await configManager.triggerWarmup(proxyManager.baseUrl);
        if (ok) {
          ctx.ui.notify("KV cache prefill warmup initiated for active roles.", "info");
        } else {
          ctx.ui.notify("Failed to initiate warmup. Is Meepo proxy running?", "warning");
        }
        return;
      }

      // ─── Subcommand: start ─────────────────────────────────────────────────
      if (sub === "start") {
        ctx.ui.notify("Starting Meepo proxy...", "info");
        const ok = await proxyManager.ensureRunning((msg) => {
          ctx.ui.notify(msg, "info");
        });
        if (ok) {
          ctx.ui.notify(`Meepo proxy running at ${proxyManager.baseUrl}`, "info");
          ctx.ui.setStatus(
            "meepo",
            ctx.ui.theme.fg("success", "🟢") + ctx.ui.theme.fg("dim", ` Meepo [${proxyManager.mode}]`),
          );
        } else {
          ctx.ui.notify("Failed to start Meepo proxy. Check logs or binary.", "error");
        }
        return;
      }

      // ─── Subcommand: stop ──────────────────────────────────────────────────
      if (sub === "stop") {
        ctx.ui.notify("Stopping Meepo proxy...", "info");
        const ok = await proxyManager.stop();
        if (ok) {
          ctx.ui.notify("Meepo proxy stopped.", "info");
          ctx.ui.setStatus(
            "meepo",
            ctx.ui.theme.fg("warning", "⚠️") + ctx.ui.theme.fg("dim", " Meepo offline"),
          );
        } else {
          ctx.ui.notify("Failed to stop Meepo or already stopped.", "warning");
        }
        return;
      }

      // ─── Subcommand: restart ───────────────────────────────────────────────
      if (sub === "restart") {
        ctx.ui.notify("Restarting Meepo proxy...", "info");
        await proxyManager.stop();
        await new Promise((r) => setTimeout(r, 600));
        // Refresh settings from disk before restart
        settings = configManager.load();
        proxyManager = new ProxyManager({
          host: settings.host,
          port: settings.port,
          useDocker: settings.runner === "docker",
          containerName: settings.containerName,
          binPath: customBin,
        });
        const ok = await proxyManager.ensureRunning();
        if (ok) {
          ctx.ui.notify(`Meepo proxy restarted at ${proxyManager.baseUrl} [${proxyManager.mode}]`, "info");
          ctx.ui.setStatus(
            "meepo",
            ctx.ui.theme.fg("success", "🟢") + ctx.ui.theme.fg("dim", ` Meepo [${proxyManager.mode}]`),
          );
        } else {
          ctx.ui.notify("Failed to restart Meepo proxy.", "error");
        }
        return;
      }

      // ─── Default: status report ────────────────────────────────────────────
      const healthy = await proxyManager.checkHealth();
      const activeSessions = sessionTracker ? sessionTracker.getActiveSessions() : [];

      let upstreamStatus = "unknown";
      try {
        const res = await fetch(`${proxyManager.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const data: any = await res.json();
          upstreamStatus = `llama: ${data.llamaOnline ? "online" : "offline"} | von: ${data.vonOnline ? "online" : "offline"}`;
        }
      } catch {}

      const lines = [
        `Meepo Mesh Proxy: ${healthy ? "🟢 ONLINE" : "⚠️ OFFLINE"}`,
        `  Base URL: ${proxyManager.baseUrl}`,
        `  Runner: ${proxyManager.mode} (config: ${settings.runner}, ${proxyManager.isManaged ? "managed by pi-meepo" : "external"})`,
        `  Active Pi Sessions: ${activeSessions.length}`,
        `  Upstream: ${upstreamStatus}`,
        `  KV Cache Warmup: ${settings.warmupPrefill ? "🔥 ENABLED (auto-warmed)" : "❄️ DISABLED"}`,
        ``,
        `Active Role Models:`,
        `  💬 Chat:  ${settings.roles.chat.modelId}`,
        `  🛠️ Tools: ${settings.roles.tools.modelId}`,
        `  💻 Code:  ${settings.roles.code.modelId}`,
        `  ☁️ Cloud: ${settings.roles.cloud.modelId}`,
        ``,
        `Commands:`,
        `  /meepo settings               Interactive TUI settings menu`,
        `  /meepo settings docker on|off Enable or disable Docker runner`,
        `  /meepo settings prefill on|off Toggle KV cache prefill warmup`,
        `  /meepo settings model <r> <m>  Set role model (chat/tools/code/cloud)`,
        `  /meepo settings show           Display full JSON configuration`,
        `  /meepo warmup                  Trigger manual KV cache warmup`,
        `  /meepo start | stop | restart  Control proxy process lifecycle`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
