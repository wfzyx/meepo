import type { ExtensionAPI, ExtensionContext } from "./types.js";
import { ProxyManager } from "./proxy-manager.js";
import { SessionTracker } from "./session-tracker.js";
import { randomUUID } from "node:crypto";

export default function meepoExtension(pi: ExtensionAPI) {
  const host = process.env.MEEPO_HOST || "127.0.0.1";
  const port = parseInt(process.env.MEEPO_PORT || "8081", 10);
  const useDocker = process.env.MEEPO_USE_DOCKER === "1";
  const containerName = process.env.MEEPO_CONTAINER_NAME || "meepo";
  const customBin = process.env.MEEPO_BIN;

  const proxyManager = new ProxyManager({
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
      ctx.ui.setStatus(
        "meepo",
        ctx.ui.theme.fg("success", "🟢") + ctx.ui.theme.fg("dim", ` Meepo [${modeLabel}]`),
      );
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

  // ─── Command: /meepo ───────────────────────────────────────────────────────
  pi.registerCommand("meepo", {
    description: "Manage Meepo mesh proxy and view session lifecycle status",
    handler: async (args: string, ctx: ExtensionContext) => {
      const sub = args.trim().toLowerCase();

      if (sub === "start") {
        ctx.ui.notify("Starting Meepo proxy...", "info");
        const ok = await proxyManager.ensureRunning((msg) => {
          ctx.ui.notify(msg, "info");
        });
        if (ok) {
          ctx.ui.notify(`Meepo proxy running at ${proxyManager.baseUrl}`, "info");
          ctx.ui.setStatus(
            "meepo",
            ctx.ui.theme.fg("success", "🟢") + ctx.ui.theme.fg("dim", " Meepo (online)"),
          );
        } else {
          ctx.ui.notify("Failed to start Meepo proxy. Check logs or binary.", "error");
        }
        return;
      }

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

      if (sub === "restart") {
        ctx.ui.notify("Restarting Meepo proxy...", "info");
        await proxyManager.stop();
        await new Promise((r) => setTimeout(r, 600));
        const ok = await proxyManager.ensureRunning();
        if (ok) {
          ctx.ui.notify(`Meepo proxy restarted at ${proxyManager.baseUrl}`, "info");
        } else {
          ctx.ui.notify("Failed to restart Meepo proxy.", "error");
        }
        return;
      }

      // Default: status report
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
        `  Runner: ${proxyManager.mode} (${proxyManager.isManaged ? "managed by pi-meepo" : "external"})`,
        `  Active Pi Sessions: ${activeSessions.length}`,
        `  Upstream: ${upstreamStatus}`,
        ``,
        `Commands:`,
        `  /meepo status   Show this status dashboard`,
        `  /meepo start    Start Meepo proxy`,
        `  /meepo stop     Stop Meepo proxy`,
        `  /meepo restart  Restart Meepo proxy`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
