// src/proxy-manager.ts
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

class ProxyManager {
  host;
  port;
  baseUrl;
  useDocker;
  containerName;
  customBinPath;
  managed = false;
  spawnedProcess;
  activeMode = "binary";
  constructor(options = {}) {
    this.host = options.host || process.env.MEEPO_HOST || "127.0.0.1";
    this.port = options.port || parseInt(process.env.MEEPO_PORT || "8081", 10);
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.useDocker = options.useDocker ?? process.env.MEEPO_USE_DOCKER === "1";
    this.containerName = options.containerName || process.env.MEEPO_CONTAINER_NAME || "meepo";
    this.customBinPath = options.binPath || process.env.MEEPO_BIN;
  }
  get isManaged() {
    return this.managed;
  }
  get mode() {
    return this.activeMode;
  }
  async checkHealth() {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(1500)
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  async ensureRunning(onStatus) {
    if (await this.checkHealth()) {
      return true;
    }
    onStatus?.("Checking runner environment...");
    if (this.useDocker && this.isDockerAvailable()) {
      this.activeMode = "docker";
      return this.startDocker(onStatus);
    }
    this.activeMode = "binary";
    return this.startBinary(onStatus);
  }
  isDockerAvailable() {
    try {
      execSync("docker info", { stdio: "ignore", timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
  async startDocker(onStatus) {
    onStatus?.(`Starting Docker container '${this.containerName}'...`);
    try {
      const exists = execSync(`docker ps -a -q -f name=^/${this.containerName}$`, {
        encoding: "utf-8",
        timeout: 3000
      }).trim();
      if (exists) {
        execSync(`docker start ${this.containerName}`, { stdio: "ignore", timeout: 5000 });
      } else {
        const imgExists = execSync(`docker images -q meepo:latest`, {
          encoding: "utf-8",
          timeout: 3000
        }).trim();
        if (!imgExists) {
          onStatus?.("Building Docker image 'meepo:latest'...");
          const dockerfilePath = this.findDockerfile();
          if (dockerfilePath) {
            const contextDir = join(dockerfilePath, "..");
            execSync(`docker build -t meepo:latest -f ${dockerfilePath} ${contextDir}`, {
              stdio: "ignore",
              timeout: 60000
            });
          }
        }
        const isLinux = process.platform === "linux";
        const netArgs = isLinux ? `--net=host` : `-p ${this.port}:8081 --add-host=host.docker.internal:host-gateway -e MEEPO_LLAMA_URL=http://host.docker.internal:8080/v1 -e MEEPO_VON_URL=http://host.docker.internal:8000/v1/systemone`;
        execSync(`docker run -d --name ${this.containerName} ${netArgs} meepo:latest`, { stdio: "ignore", timeout: 15000 });
      }
      this.managed = true;
    } catch (err) {
      onStatus?.(`Docker start failed, falling back to binary: ${err.message}`);
      this.activeMode = "binary";
      return this.startBinary(onStatus);
    }
    return this.pollHealth(15, 500, onStatus);
  }
  findDockerfile() {
    const candidatePaths = [
      join(process.cwd(), "core", "Dockerfile"),
      join(process.cwd(), "Dockerfile"),
      join(homedir(), "Code", "personal", "meepo", "core", "Dockerfile"),
      join(homedir(), "Code", "personal", "meepo", "Dockerfile"),
      join(import.meta.dirname ?? "", "..", "Dockerfile"),
      join(import.meta.dirname ?? "", "..", "core", "Dockerfile"),
      join(import.meta.dirname ?? "", "..", "..", "Dockerfile"),
      join(import.meta.dirname ?? "", "..", "..", "core", "Dockerfile")
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        return p;
      }
    }
    return null;
  }
  findBinary() {
    if (this.customBinPath && existsSync(this.customBinPath)) {
      return this.customBinPath;
    }
    const candidatePaths = [
      join(homedir(), ".local", "bin", "meepo"),
      join(homedir(), "Code", "personal", "meepo", "core", "bin", "meepo"),
      join(homedir(), "Code", "personal", "meepo", "bin", "meepo"),
      "/usr/local/bin/meepo"
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        return p;
      }
    }
    try {
      const output = execSync("which meepo", { encoding: "utf-8", timeout: 1500 }).trim();
      if (output && existsSync(output)) {
        return output;
      }
    } catch {}
    return null;
  }
  async startBinary(onStatus) {
    const binPath = this.findBinary();
    if (!binPath) {
      onStatus?.("Meepo binary not found. Please install meepo to ~/.local/bin/meepo");
      return false;
    }
    onStatus?.(`Spawning Meepo proxy (${binPath}) on :${this.port}...`);
    try {
      const child = spawn(binPath, ["serve", "--port", String(this.port), "--host", this.host], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      this.spawnedProcess = child;
      this.managed = true;
      if (child.pid) {
        this.writePidFile(child.pid);
      }
    } catch (err) {
      onStatus?.(`Failed to spawn Meepo binary: ${err.message}`);
      return false;
    }
    return this.pollHealth(20, 300, onStatus);
  }
  async pollHealth(maxAttempts, intervalMs, onStatus) {
    for (let i = 1;i <= maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (await this.checkHealth()) {
        onStatus?.("Meepo proxy is ready.");
        return true;
      }
      onStatus?.(`Waiting for Meepo proxy on :${this.port} (attempt ${i}/${maxAttempts})...`);
    }
    return false;
  }
  getPidFilePath() {
    return join(tmpdir(), "meepo-sessions", "meepo-proxy.pid");
  }
  writePidFile(pid) {
    try {
      const pidFile = this.getPidFilePath();
      const dir = join(pidFile, "..");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(pidFile, String(pid), "utf-8");
    } catch {}
  }
  cleanupPidFile() {
    try {
      const pidFile = this.getPidFilePath();
      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
      }
    } catch {}
  }
  stopDockerContainer(onStatus) {
    try {
      const running = execSync(`docker inspect -f '{{.State.Running}}' ${this.containerName} 2>/dev/null || true`, { encoding: "utf-8", timeout: 2000 }).trim();
      if (running === "true") {
        onStatus?.(`Stopping Docker container '${this.containerName}'...`);
        execSync(`docker stop -t 2 ${this.containerName} 2>/dev/null || true`, {
          stdio: "ignore",
          timeout: 6000
        });
      }
    } catch {}
  }
  killNativeProcesses(onStatus) {
    const pidsToKill = new Set;
    if (this.spawnedProcess && this.spawnedProcess.pid) {
      pidsToKill.add(this.spawnedProcess.pid);
    }
    try {
      const pidFile = this.getPidFilePath();
      if (existsSync(pidFile)) {
        const saved = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (!isNaN(saved) && saved > 0 && saved !== process.pid) {
          pidsToKill.add(saved);
        }
      }
    } catch {}
    try {
      const fuserOut = execSync(`fuser ${this.port}/tcp 2>/dev/null || true`, {
        encoding: "utf-8",
        timeout: 1500
      }).trim();
      if (fuserOut) {
        for (const token of fuserOut.split(/\s+/)) {
          const p = parseInt(token.trim(), 10);
          if (!isNaN(p) && p > 0 && p !== process.pid) {
            pidsToKill.add(p);
          }
        }
      }
    } catch {}
    try {
      const pgrepOut = execSync(`pgrep -f "meepo serve" 2>/dev/null || true`, {
        encoding: "utf-8",
        timeout: 1500
      }).trim();
      if (pgrepOut) {
        for (const line of pgrepOut.split(/\s+/)) {
          const p = parseInt(line.trim(), 10);
          if (!isNaN(p) && p > 0 && p !== process.pid) {
            pidsToKill.add(p);
          }
        }
      }
    } catch {}
    for (const pid of pidsToKill) {
      try {
        process.kill(pid, 0);
        onStatus?.(`Terminating native Meepo process (PID ${pid})...`);
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    const survivors = Array.from(pidsToKill).filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (survivors.length > 0) {
      const start = Date.now();
      while (Date.now() - start < 200) {}
      for (const pid of survivors) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }
  async waitForPortRelease(maxAttempts = 15, intervalMs = 150) {
    for (let i = 0;i < maxAttempts; i++) {
      const online = await this.checkHealth();
      if (!online) {
        return true;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return !await this.checkHealth();
  }
  async stop(onStatus) {
    onStatus?.("Shutting down Meepo proxy...");
    try {
      await fetch(`${this.baseUrl}/v1/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(1500)
      });
    } catch {}
    this.stopDockerContainer(onStatus);
    this.killNativeProcesses(onStatus);
    this.cleanupPidFile();
    const released = await this.waitForPortRelease(15, 100);
    this.managed = false;
    this.spawnedProcess = undefined;
    return released;
  }
}

// src/session-tracker.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { tmpdir as tmpdir2 } from "node:os";

class SessionTracker {
  sessionsDir;
  sessionId;
  pid;
  heartbeatInterval;
  constructor(sessionId, customDir) {
    this.sessionId = sessionId;
    this.pid = process.pid;
    this.sessionsDir = customDir || join2(tmpdir2(), "meepo-sessions");
    if (!existsSync2(this.sessionsDir)) {
      mkdirSync2(this.sessionsDir, { recursive: true });
    }
  }
  getSessionsDir() {
    return this.sessionsDir;
  }
  getSessionId() {
    return this.sessionId;
  }
  register() {
    const info = {
      sessionId: this.sessionId,
      pid: this.pid,
      startTime: Date.now(),
      lastHeartbeat: Date.now()
    };
    writeFileSync2(this.sessionFilePath(this.sessionId), JSON.stringify(info, null, 2), "utf-8");
    this.heartbeatInterval = setInterval(() => {
      try {
        const filePath = this.sessionFilePath(this.sessionId);
        if (existsSync2(filePath)) {
          info.lastHeartbeat = Date.now();
          writeFileSync2(filePath, JSON.stringify(info, null, 2), "utf-8");
        }
      } catch {}
    }, 5000);
  }
  unregister() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    try {
      const filePath = this.sessionFilePath(this.sessionId);
      if (existsSync2(filePath)) {
        unlinkSync2(filePath);
      }
    } catch {}
    const activeSessions = this.getActiveSessions();
    return {
      remainingCount: activeSessions.length,
      isLastSession: activeSessions.length === 0,
      activeSessions
    };
  }
  getActiveSessions() {
    const active = [];
    if (!existsSync2(this.sessionsDir))
      return active;
    const files = readdirSync(this.sessionsDir);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith(".json"))
        continue;
      const filePath = join2(this.sessionsDir, file);
      try {
        const raw = readFileSync2(filePath, "utf-8");
        const info = JSON.parse(raw);
        let isAlive = false;
        try {
          process.kill(info.pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
        const isStale = now - info.lastHeartbeat > 30000;
        if (isAlive && !isStale) {
          active.push(info);
        } else {
          try {
            unlinkSync2(filePath);
          } catch {}
        }
      } catch {
        try {
          unlinkSync2(filePath);
        } catch {}
      }
    }
    return active;
  }
  sessionFilePath(id) {
    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join2(this.sessionsDir, `${sanitized}.json`);
  }
}

// src/config-manager.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir2 } from "node:os";
function getDefaultSettings() {
  return {
    runner: "binary",
    port: 8081,
    host: "127.0.0.1",
    containerName: "meepo",
    warmupPrefill: true,
    llamaServer: {
      baseUrl: "http://127.0.0.1:8080/v1",
      modelDir: "~/models"
    },
    roles: {
      router: {
        name: "von-1.3.5",
        endpoint: "http://127.0.0.1:8000/v1/systemone"
      },
      chat: {
        name: "gemma-4-E2B-it",
        modelId: "gemma-4-E2B-it"
      },
      tools: {
        name: "LFM2.5-1.2B-Instruct",
        modelId: "LFM2.5-1.2B-Instruct"
      },
      code: {
        name: "Qwen3.5-2B",
        modelId: "Qwen3.5-2B"
      },
      cloud: {
        name: "claude-opus-5-5",
        modelId: "claude-opus-5-5"
      }
    }
  };
}

class ConfigManager {
  configPath;
  constructor(customPath) {
    this.configPath = customPath || this.resolveConfigPath();
  }
  getConfigPath() {
    return this.configPath;
  }
  resolveConfigPath() {
    const cwd = process.cwd();
    const projectPi = join3(cwd, ".pi", "meepo.json");
    if (existsSync3(projectPi))
      return projectPi;
    const repoConfig = join3(cwd, "meepo.config.json");
    if (existsSync3(repoConfig))
      return repoConfig;
    const userGlobal = join3(homedir2(), ".pi", "agent", "meepo.json");
    return userGlobal;
  }
  load() {
    const defaults = getDefaultSettings();
    if (!existsSync3(this.configPath)) {
      return defaults;
    }
    try {
      const raw = readFileSync3(this.configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...parsed,
        llamaServer: {
          ...defaults.llamaServer,
          ...parsed.llamaServer || {}
        },
        roles: {
          router: { ...defaults.roles.router, ...parsed.roles?.router || {} },
          chat: { ...defaults.roles.chat, ...parsed.roles?.chat || {} },
          tools: { ...defaults.roles.tools, ...parsed.roles?.tools || {} },
          code: { ...defaults.roles.code, ...parsed.roles?.code || {} },
          cloud: { ...defaults.roles.cloud, ...parsed.roles?.cloud || {} }
        }
      };
    } catch {
      return defaults;
    }
  }
  save(settings) {
    const dir = join3(this.configPath, "..");
    if (!existsSync3(dir)) {
      mkdirSync3(dir, { recursive: true });
    }
    writeFileSync3(this.configPath, JSON.stringify(settings, null, 2), "utf-8");
  }
  async fetchLlamaModels(llamaBaseUrl) {
    const cleanUrl = llamaBaseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
    try {
      const res = await fetch(`${cleanUrl}/models`, {
        signal: AbortSignal.timeout(2000)
      });
      if (!res.ok)
        return [];
      const data = await res.json();
      if (Array.isArray(data?.data)) {
        return data.data.map((m) => m.id || m.model || String(m)).filter(Boolean);
      }
      if (Array.isArray(data?.models)) {
        return data.models.map((m) => m.id || m.name || String(m)).filter(Boolean);
      }
      return [];
    } catch {
      return [];
    }
  }
  async triggerWarmup(baseUrl, sysPrompt) {
    try {
      const res = await fetch(`${baseUrl}/v1/warmup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sysPrompt ? { system_prompt: sysPrompt } : {}),
        signal: AbortSignal.timeout(2000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  async openInteractiveSettings(ctx, onRestart) {
    if (!ctx.ui?.select) {
      ctx.ui?.notify("Interactive settings require TUI mode with ctx.ui.select", "warning");
      return;
    }
    const settings = this.load();
    while (true) {
      const runnerEmoji = settings.runner === "docker" ? "\uD83D\uDC33" : "⚡";
      const runnerLabel = settings.runner === "docker" ? "Docker container" : "Native Go binary";
      const warmupEmoji = settings.warmupPrefill ? "\uD83D\uDD25" : "❄️";
      const warmupLabel = settings.warmupPrefill ? "ENABLED (auto-warm Turn 1)" : "DISABLED";
      const menu = [
        `${runnerEmoji} Runner Mode: ${runnerLabel}`,
        `${warmupEmoji} KV Cache Warmup: ${warmupLabel}`,
        `\uD83D\uDD0C Proxy Port: ${settings.port}`,
        `\uD83E\uDD99 Upstream llama.cpp URL: ${settings.llamaServer.baseUrl}`,
        `\uD83D\uDCAC Chat Model: ${settings.roles.chat.modelId}`,
        `\uD83D\uDEE0️ Tools Model: ${settings.roles.tools.modelId}`,
        `\uD83D\uDCBB Code Model: ${settings.roles.code.modelId}`,
        `\uD83E\uDDED Von Router Endpoint: ${settings.roles.router.endpoint}`,
        `☁️ Cloud Escalation Model: ${settings.roles.cloud.modelId}`,
        `\uD83D\uDCBE Save & Restart Meepo`,
        `❌ Exit without saving`
      ];
      const choice = await ctx.ui.select("Meepo Mesh Configuration", menu);
      if (!choice || choice.includes("Exit without saving")) {
        break;
      }
      if (choice.includes("Runner Mode")) {
        settings.runner = settings.runner === "docker" ? "binary" : "docker";
        ctx.ui.notify(`Switched runner to ${settings.runner}`, "info");
        continue;
      }
      if (choice.includes("KV Cache Warmup")) {
        settings.warmupPrefill = !settings.warmupPrefill;
        ctx.ui.notify(`KV Cache Prefill Warmup ${settings.warmupPrefill ? "enabled" : "disabled"}`, "info");
        continue;
      }
      if (choice.includes("Proxy Port")) {
        if (ctx.ui.input) {
          const val = await ctx.ui.input("Enter proxy port (default: 8081):", String(settings.port));
          if (val) {
            const p = parseInt(val.trim(), 10);
            if (!isNaN(p) && p > 0 && p < 65536) {
              settings.port = p;
            } else {
              ctx.ui.notify("Invalid port number", "error");
            }
          }
        }
        continue;
      }
      if (choice.includes("Upstream llama.cpp")) {
        if (ctx.ui.input) {
          const val = await ctx.ui.input("Enter llama-server base URL:", settings.llamaServer.baseUrl);
          if (val && val.trim()) {
            settings.llamaServer.baseUrl = val.trim();
          }
        }
        continue;
      }
      if (choice.includes("Chat Model") || choice.includes("Tools Model") || choice.includes("Code Model")) {
        const role = choice.includes("Chat") ? "chat" : choice.includes("Tools") ? "tools" : "code";
        ctx.ui.notify("Querying local llama-server for available models...", "info");
        const available = await this.fetchLlamaModels(settings.llamaServer.baseUrl);
        const modelChoices = [
          ...available,
          "✏️ Custom model name...",
          "⬅️ Back"
        ];
        const picked = await ctx.ui.select(`Select model for ${role.toUpperCase()} role:`, modelChoices);
        if (!picked || picked.includes("Back")) {
          continue;
        }
        if (picked.includes("Custom") && ctx.ui.input) {
          const custom = await ctx.ui.input("Enter model ID:", settings.roles[role].modelId);
          if (custom && custom.trim()) {
            settings.roles[role].modelId = custom.trim();
            settings.roles[role].name = custom.trim();
          }
        } else {
          settings.roles[role].modelId = picked;
          settings.roles[role].name = picked;
        }
        continue;
      }
      if (choice.includes("Von Router")) {
        if (ctx.ui.input) {
          const val = await ctx.ui.input("Enter Von endpoint URL:", settings.roles.router.endpoint);
          if (val && val.trim()) {
            settings.roles.router.endpoint = val.trim();
          }
        }
        continue;
      }
      if (choice.includes("Cloud Escalation")) {
        const cloudChoices = [
          "claude-opus-5-5",
          "claude-sonnet-4-5",
          "gemini-3-8-flash",
          "gpt-5-codex",
          "✏️ Custom cloud model...",
          "⬅️ Back"
        ];
        const picked = await ctx.ui.select("Select cloud escalation model:", cloudChoices);
        if (!picked || picked.includes("Back"))
          continue;
        if (picked.includes("Custom") && ctx.ui.input) {
          const custom = await ctx.ui.input("Enter cloud model ID:", settings.roles.cloud.modelId);
          if (custom && custom.trim()) {
            settings.roles.cloud.modelId = custom.trim();
            settings.roles.cloud.name = custom.trim();
          }
        } else {
          settings.roles.cloud.modelId = picked;
          settings.roles.cloud.name = picked;
        }
        continue;
      }
      if (choice.includes("Save & Restart")) {
        this.save(settings);
        ctx.ui.notify(`Saved configuration to ${this.configPath}. Restarting Meepo...`, "info");
        await onRestart(settings);
        break;
      }
    }
  }
}

// src/index.ts
import { randomUUID } from "node:crypto";
function meepoExtension(pi) {
  const configManager = new ConfigManager;
  let settings = configManager.load();
  const host = process.env.MEEPO_HOST || settings.host;
  const port = process.env.MEEPO_PORT ? parseInt(process.env.MEEPO_PORT, 10) : settings.port;
  const useDocker = process.env.MEEPO_USE_DOCKER !== undefined ? process.env.MEEPO_USE_DOCKER === "1" : settings.runner === "docker";
  const containerName = process.env.MEEPO_CONTAINER_NAME || settings.containerName;
  const customBin = process.env.MEEPO_BIN;
  let proxyManager = new ProxyManager({
    host,
    port,
    useDocker,
    containerName,
    binPath: customBin
  });
  let sessionTracker = null;
  let isProxyHealthy = false;
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionId || `pi-session-${process.pid}-${randomUUID().slice(0, 8)}`;
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
      const warmLabel = settings.warmupPrefill ? " \uD83D\uDD25" : "";
      ctx.ui.setStatus("meepo", ctx.ui.theme.fg("success", "\uD83D\uDFE2") + ctx.ui.theme.fg("dim", ` Meepo [${modeLabel}${warmLabel}]`));
      if (settings.warmupPrefill) {
        configManager.triggerWarmup(proxyManager.baseUrl);
      }
    } else {
      ctx.ui.setStatus("meepo", ctx.ui.theme.fg("warning", "⚠️") + ctx.ui.theme.fg("dim", " Meepo offline"));
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!sessionTracker)
      return;
    const { remainingCount, isLastSession } = sessionTracker.unregister();
    if (isLastSession) {
      ctx.ui.setStatus("meepo", ctx.ui.theme.fg("dim", "⏳ Stopping Meepo (last exit)..."));
      await proxyManager.stop();
    }
  });
  pi.registerCommand("meepo", {
    description: "Manage Meepo mesh proxy, configure local models & runner settings",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() || "status";
      if (sub === "settings" || sub === "config") {
        const subArgs = parts.slice(1);
        if (subArgs.length === 0) {
          await configManager.openInteractiveSettings(ctx, async (newSettings) => {
            settings = newSettings;
            await proxyManager.stop();
            proxyManager = new ProxyManager({
              host: settings.host,
              port: settings.port,
              useDocker: settings.runner === "docker",
              containerName: settings.containerName,
              binPath: customBin
            });
            await proxyManager.ensureRunning();
            const modeLabel = proxyManager.mode === "docker" ? "docker" : "bin";
            ctx.ui.setStatus("meepo", ctx.ui.theme.fg("success", "\uD83D\uDFE2") + ctx.ui.theme.fg("dim", ` Meepo [${modeLabel}]`));
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
            ctx.ui.notify(`KV Cache Warmup: ${settings.warmupPrefill ? "enabled" : "disabled"}. Usage: /meepo settings prefill on|off`, "info");
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
          const role = subArgs[1]?.toLowerCase();
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
          ctx.ui.notify(`Meepo Config (${configManager.getConfigPath()}):
${JSON.stringify(settings, null, 2)}`, "info");
          return;
        }
        ctx.ui.notify("Unknown settings option. Run '/meepo settings' for interactive menu.", "warning");
        return;
      }
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
      if (sub === "start") {
        ctx.ui.notify("Starting Meepo proxy...", "info");
        const ok = await proxyManager.ensureRunning((msg) => {
          ctx.ui.notify(msg, "info");
        });
        if (ok) {
          ctx.ui.notify(`Meepo proxy running at ${proxyManager.baseUrl}`, "info");
          ctx.ui.setStatus("meepo", ctx.ui.theme.fg("success", "\uD83D\uDFE2") + ctx.ui.theme.fg("dim", ` Meepo [${proxyManager.mode}]`));
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
          ctx.ui.setStatus("meepo", ctx.ui.theme.fg("warning", "⚠️") + ctx.ui.theme.fg("dim", " Meepo offline"));
        } else {
          ctx.ui.notify("Failed to stop Meepo or already stopped.", "warning");
        }
        return;
      }
      if (sub === "restart") {
        ctx.ui.notify("Restarting Meepo proxy...", "info");
        await proxyManager.stop();
        await new Promise((r) => setTimeout(r, 600));
        settings = configManager.load();
        proxyManager = new ProxyManager({
          host: settings.host,
          port: settings.port,
          useDocker: settings.runner === "docker",
          containerName: settings.containerName,
          binPath: customBin
        });
        const ok = await proxyManager.ensureRunning();
        if (ok) {
          ctx.ui.notify(`Meepo proxy restarted at ${proxyManager.baseUrl} [${proxyManager.mode}]`, "info");
          ctx.ui.setStatus("meepo", ctx.ui.theme.fg("success", "\uD83D\uDFE2") + ctx.ui.theme.fg("dim", ` Meepo [${proxyManager.mode}]`));
        } else {
          ctx.ui.notify("Failed to restart Meepo proxy.", "error");
        }
        return;
      }
      const healthy = await proxyManager.checkHealth();
      const activeSessions = sessionTracker ? sessionTracker.getActiveSessions() : [];
      let upstreamStatus = "unknown";
      try {
        const res = await fetch(`${proxyManager.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const data = await res.json();
          upstreamStatus = `llama: ${data.llamaOnline ? "online" : "offline"} | von: ${data.vonOnline ? "online" : "offline"}`;
        }
      } catch {}
      const lines = [
        `Meepo Mesh Proxy: ${healthy ? "\uD83D\uDFE2 ONLINE" : "⚠️ OFFLINE"}`,
        `  Base URL: ${proxyManager.baseUrl}`,
        `  Runner: ${proxyManager.mode} (config: ${settings.runner}, ${proxyManager.isManaged ? "managed by pi-meepo" : "external"})`,
        `  Active Pi Sessions: ${activeSessions.length}`,
        `  Upstream: ${upstreamStatus}`,
        `  KV Cache Warmup: ${settings.warmupPrefill ? "\uD83D\uDD25 ENABLED (auto-warmed)" : "❄️ DISABLED"}`,
        ``,
        `Active Role Models:`,
        `  \uD83D\uDCAC Chat:  ${settings.roles.chat.modelId}`,
        `  \uD83D\uDEE0️ Tools: ${settings.roles.tools.modelId}`,
        `  \uD83D\uDCBB Code:  ${settings.roles.code.modelId}`,
        `  ☁️ Cloud: ${settings.roles.cloud.modelId}`,
        ``,
        `Commands:`,
        `  /meepo settings               Interactive TUI settings menu`,
        `  /meepo settings docker on|off Enable or disable Docker runner`,
        `  /meepo settings prefill on|off Toggle KV cache prefill warmup`,
        `  /meepo settings model <r> <m>  Set role model (chat/tools/code/cloud)`,
        `  /meepo settings show           Display full JSON configuration`,
        `  /meepo warmup                  Trigger manual KV cache warmup`,
        `  /meepo start | stop | restart  Control proxy process lifecycle`
      ];
      ctx.ui.notify(lines.join(`
`), "info");
    }
  });
}
export {
  meepoExtension as default
};
