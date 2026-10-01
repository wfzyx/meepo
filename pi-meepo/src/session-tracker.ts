import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SessionInfo {
  sessionId: string;
  pid: number;
  startTime: number;
  lastHeartbeat: number;
}

export interface UnregisterResult {
  remainingCount: number;
  isLastSession: boolean;
  activeSessions: SessionInfo[];
}

export class SessionTracker {
  private sessionsDir: string;
  private sessionId: string;
  private pid: number;
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(sessionId: string, customDir?: string) {
    this.sessionId = sessionId;
    this.pid = process.pid;
    this.sessionsDir = customDir || join(tmpdir(), "meepo-sessions");
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  getSessionsDir(): string {
    return this.sessionsDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  register(): void {
    const info: SessionInfo = {
      sessionId: this.sessionId,
      pid: this.pid,
      startTime: Date.now(),
      lastHeartbeat: Date.now(),
    };

    writeFileSync(this.sessionFilePath(this.sessionId), JSON.stringify(info, null, 2), "utf-8");

    // Send heartbeat every 5 seconds
    this.heartbeatInterval = setInterval(() => {
      try {
        const filePath = this.sessionFilePath(this.sessionId);
        if (existsSync(filePath)) {
          info.lastHeartbeat = Date.now();
          writeFileSync(filePath, JSON.stringify(info, null, 2), "utf-8");
        }
      } catch {
        // Ignore heartbeat update errors on shutting down
      }
    }, 5_000);
  }

  unregister(): UnregisterResult {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    try {
      const filePath = this.sessionFilePath(this.sessionId);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // Ignore removal failure
    }

    const activeSessions = this.getActiveSessions();
    return {
      remainingCount: activeSessions.length,
      isLastSession: activeSessions.length === 0,
      activeSessions,
    };
  }

  getActiveSessions(): SessionInfo[] {
    const active: SessionInfo[] = [];
    if (!existsSync(this.sessionsDir)) return active;

    const files = readdirSync(this.sessionsDir);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(this.sessionsDir, file);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const info: SessionInfo = JSON.parse(raw);

        // Check if PID is still alive on the system
        let isAlive = false;
        try {
          // Sending signal 0 checks for process existence without actually terminating
          process.kill(info.pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }

        // Stale if heartbeat was missed by > 30 seconds
        const isStale = now - info.lastHeartbeat > 30_000;

        if (isAlive && !isStale) {
          active.push(info);
        } else {
          // Automatically clean up stale or dead session files
          try {
            unlinkSync(filePath);
          } catch {}
        }
      } catch {
        try {
          unlinkSync(filePath);
        } catch {}
      }
    }

    return active;
  }

  private sessionFilePath(id: string): string {
    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.sessionsDir, `${sanitized}.json`);
  }
}
