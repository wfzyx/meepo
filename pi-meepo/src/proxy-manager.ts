import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
        // Run container
        execSync(
          `docker run -d --name ${this.containerName} -p ${this.port}:8081 meepo:latest`,
          { stdio: "ignore", timeout: 10000 },
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

  findBinary(): string | null {
    if (this.customBinPath && existsSync(this.customBinPath)) {
      return this.customBinPath;
    }

    const candidatePaths = [
      join(homedir(), ".local", "bin", "meepo"),
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

  async stop(onStatus?: (msg: string) => void): Promise<boolean> {
    onStatus?.("Shutting down Meepo proxy...");

    // 1. Try clean HTTP shutdown endpoint first
    try {
      const res = await fetch(`${this.baseUrl}/v1/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        this.managed = false;
        return true;
      }
    } catch {
      // Fall through to container/process termination
    }

    // 2. If Docker mode
    if (this.activeMode === "docker") {
      try {
        execSync(`docker stop ${this.containerName}`, { stdio: "ignore", timeout: 5000 });
        this.managed = false;
        return true;
      } catch {}
    }

    // 3. If binary spawned process
    if (this.spawnedProcess && this.spawnedProcess.pid) {
      try {
        process.kill(this.spawnedProcess.pid, "SIGTERM");
        this.managed = false;
        return true;
      } catch {}
    }

    return false;
  }
}
