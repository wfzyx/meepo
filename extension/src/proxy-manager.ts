import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

export interface ProxyManagerOptions {
  host?: string;
  port?: number;
  useDocker?: boolean;
  containerName?: string;
  binPath?: string;
}

export type RunnerMode = "docker" | "binary";

export class ProxyManager {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly useDocker: boolean;
  readonly containerName: string;
  private customBinPath?: string;

  private managed = false;
  private spawnedProcess?: ChildProcess;
  private activeMode: RunnerMode = "binary";

  constructor(options: ProxyManagerOptions = {}) {
    this.host = options.host || process.env.MEEPO_HOST || "127.0.0.1";
    this.port = options.port || parseInt(process.env.MEEPO_PORT || "8081", 10);
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.useDocker = options.useDocker ?? (process.env.MEEPO_USE_DOCKER === "1");
    this.containerName = options.containerName || process.env.MEEPO_CONTAINER_NAME || "meepo";
    this.customBinPath = options.binPath || process.env.MEEPO_BIN;
  }

  get isManaged(): boolean {
    return this.managed;
  }

  get mode(): RunnerMode {
    return this.activeMode;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureRunning(onStatus?: (msg: string) => void): Promise<boolean> {
    // 1. Check if already online
    if (await this.checkHealth()) {
      return true;
    }

    onStatus?.("Checking runner environment...");

    // 2. Decide runner mode (Docker vs Binary)
    if (this.useDocker && this.isDockerAvailable()) {
      this.activeMode = "docker";
      return this.startDocker(onStatus);
    }

    this.activeMode = "binary";
    return this.startBinary(onStatus);
  }

  private isDockerAvailable(): boolean {
    try {
      execSync("docker info", { stdio: "ignore", timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  private async startDocker(onStatus?: (msg: string) => void): Promise<boolean> {
    onStatus?.(`Starting Docker container '${this.containerName}'...`);
    try {
      // Check if container exists
      const exists = execSync(`docker ps -a -q -f name=^/${this.containerName}$`, {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();

      if (exists) {
        execSync(`docker start ${this.containerName}`, { stdio: "ignore", timeout: 5000 });
      } else {
        // Check if image exists; if not, attempt to build from Dockerfile
        const imgExists = execSync(`docker images -q meepo:latest`, {
          encoding: "utf-8",
          timeout: 3000,
        }).trim();

        if (!imgExists) {
          onStatus?.("Building Docker image 'meepo:latest'...");
          const dockerfilePath = this.findDockerfile();
          if (dockerfilePath) {
            const contextDir = join(dockerfilePath, "..");
            execSync(`docker build -t meepo:latest -f ${dockerfilePath} ${contextDir}`, {
              stdio: "ignore",
              timeout: 60000,
            });
          }
        }

        // Run container with optimal network settings
        const isLinux = process.platform === "linux";
        const netArgs = isLinux
          ? `--net=host`
          : `-p ${this.port}:8081 --add-host=host.docker.internal:host-gateway -e MEEPO_LLAMA_URL=http://host.docker.internal:8080/v1 -e MEEPO_VON_URL=http://host.docker.internal:8000/v1/systemone`;

        execSync(
          `docker run -d --name ${this.containerName} ${netArgs} meepo:latest`,
          { stdio: "ignore", timeout: 15000 },
        );
      }
      this.managed = true;
    } catch (err) {
      onStatus?.(`Docker start failed, falling back to binary: ${(err as Error).message}`);
      this.activeMode = "binary";
      return this.startBinary(onStatus);
    }

    return this.pollHealth(15, 500, onStatus);
  }
  findDockerfile(): string | null {
    const candidatePaths = [
      join(process.cwd(), "core", "Dockerfile"),
      join(process.cwd(), "Dockerfile"),
      join(homedir(), "Code", "personal", "meepo", "core", "Dockerfile"),
      join(homedir(), "Code", "personal", "meepo", "Dockerfile"),
      join((import.meta as any).dirname ?? "", "..", "Dockerfile"),
      join((import.meta as any).dirname ?? "", "..", "core", "Dockerfile"),
      join((import.meta as any).dirname ?? "", "..", "..", "Dockerfile"),
      join((import.meta as any).dirname ?? "", "..", "..", "core", "Dockerfile"),
    ];

    for (const p of candidatePaths) {
      if (existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  findBinary(): string | null {
    if (this.customBinPath && existsSync(this.customBinPath)) {
      return this.customBinPath;
    }

    const candidatePaths = [
      join(homedir(), ".local", "bin", "meepo"),
      join(homedir(), "Code", "personal", "meepo", "core", "bin", "meepo"),
      join(homedir(), "Code", "personal", "meepo", "bin", "meepo"),
      "/usr/local/bin/meepo",
    ];

    for (const p of candidatePaths) {
      if (existsSync(p)) {
        return p;
      }
    }

    // Try finding via `which meepo`
    try {
      const output = execSync("which meepo", { encoding: "utf-8", timeout: 1500 }).trim();
      if (output && existsSync(output)) {
        return output;
      }
    } catch {
      // not in PATH
    }

    return null;
  }

  private async startBinary(onStatus?: (msg: string) => void): Promise<boolean> {
    const binPath = this.findBinary();
    if (!binPath) {
      onStatus?.("Meepo binary not found. Please install meepo to ~/.local/bin/meepo");
      return false;
    }

    onStatus?.(`Spawning Meepo proxy (${binPath}) on :${this.port}...`);

    try {
      const child = spawn(binPath, ["serve", "--port", String(this.port), "--host", this.host], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      this.spawnedProcess = child;
      this.managed = true;

      // Save PID to disk for multi-session and runner-switch recovery
      if (child.pid) {
        this.writePidFile(child.pid);
      }
    } catch (err) {
      onStatus?.(`Failed to spawn Meepo binary: ${(err as Error).message}`);
      return false;
    }

    return this.pollHealth(20, 300, onStatus);
  }

  private async pollHealth(
    maxAttempts: number,
    intervalMs: number,
    onStatus?: (msg: string) => void,
  ): Promise<boolean> {
    for (let i = 1; i <= maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (await this.checkHealth()) {
        onStatus?.("Meepo proxy is ready.");
        return true;
      }
      onStatus?.(`Waiting for Meepo proxy on :${this.port} (attempt ${i}/${maxAttempts})...`);
    }
    return false;
  }

  getPidFilePath(): string {
    return join(tmpdir(), "meepo-sessions", "meepo-proxy.pid");
  }

  private writePidFile(pid: number): void {
    try {
      const pidFile = this.getPidFilePath();
      const dir = join(pidFile, "..");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(pidFile, String(pid), "utf-8");
    } catch {}
  }

  private cleanupPidFile(): void {
    try {
      const pidFile = this.getPidFilePath();
      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
      }
    } catch {}
  }

  private stopDockerContainer(onStatus?: (msg: string) => void): void {
    try {
      // Check if container is running
      const running = execSync(
        `docker inspect -f '{{.State.Running}}' ${this.containerName} 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 2000 },
      ).trim();

      if (running === "true") {
        onStatus?.(`Stopping Docker container '${this.containerName}'...`);
        execSync(`docker stop -t 2 ${this.containerName} 2>/dev/null || true`, {
          stdio: "ignore",
          timeout: 6000,
        });
      }
    } catch {
      // Docker command failed or docker not installed
    }
  }

  private killNativeProcesses(onStatus?: (msg: string) => void): void {
    const pidsToKill = new Set<number>();

    // 1. In-memory spawned process
    if (this.spawnedProcess && this.spawnedProcess.pid) {
      pidsToKill.add(this.spawnedProcess.pid);
    }

    // 2. Read PID file from disk (handles previous sessions and runner switches)
    try {
      const pidFile = this.getPidFilePath();
      if (existsSync(pidFile)) {
        const saved = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (!isNaN(saved) && saved > 0 && saved !== process.pid) {
          pidsToKill.add(saved);
        }
      }
    } catch {}

    // 3. Find any processes listening on the target port via fuser
    try {
      const fuserOut = execSync(`fuser ${this.port}/tcp 2>/dev/null || true`, {
        encoding: "utf-8",
        timeout: 1500,
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

    // 4. Find any running 'meepo serve' processes via pgrep
    try {
      const pgrepOut = execSync(`pgrep -f "meepo serve" 2>/dev/null || true`, {
        encoding: "utf-8",
        timeout: 1500,
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

    // Send SIGTERM to all identified PIDs
    for (const pid of pidsToKill) {
      try {
        process.kill(pid, 0); // check if alive
        onStatus?.(`Terminating native Meepo process (PID ${pid})...`);
        process.kill(pid, "SIGTERM");
      } catch {}
    }

    // Allow 200ms grace period, then SIGKILL any stubborn survivors
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

  private async waitForPortRelease(maxAttempts = 15, intervalMs = 150): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      const online = await this.checkHealth();
      if (!online) {
        return true;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return !(await this.checkHealth());
  }

  async stop(onStatus?: (msg: string) => void): Promise<boolean> {
    onStatus?.("Shutting down Meepo proxy...");

    // 1. Clean HTTP shutdown endpoint first
    try {
      await fetch(`${this.baseUrl}/v1/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(1500),
      });
    } catch {}

    // 2. Unconditionally stop Docker container if running
    this.stopDockerContainer(onStatus);

    // 3. Unconditionally terminate native binary processes (by PID, port, and process table)
    this.killNativeProcesses(onStatus);

    // 4. Clean up disk PID file
    this.cleanupPidFile();

    // 5. Deterministic barrier: ensure port is truly released
    const released = await this.waitForPortRelease(15, 100);

    this.managed = false;
    this.spawnedProcess = undefined;
    return released;
  }
}
