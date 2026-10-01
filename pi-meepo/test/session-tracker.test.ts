import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionTracker, type SessionInfo } from "../src/session-tracker.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SessionTracker", () => {
  const testDir = join(tmpdir(), "meepo-test-sessions-" + Math.random().toString(36).slice(2));

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("registers a session and records active PID", () => {
    const tracker = new SessionTracker("sess-1", testDir);
    tracker.register();

    const active = tracker.getActiveSessions();
    expect(active.length).toBe(1);
    expect(active[0].sessionId).toBe("sess-1");
    expect(active[0].pid).toBe(process.pid);

    tracker.unregister();
  });

  it("handles multiple concurrent sessions and detects the last exit", () => {
    const tracker1 = new SessionTracker("sess-1", testDir);
    const tracker2 = new SessionTracker("sess-2", testDir);

    tracker1.register();
    tracker2.register();

    let active = tracker1.getActiveSessions();
    expect(active.length).toBe(2);

    // First session closes: NOT the last exit
    const res1 = tracker1.unregister();
    expect(res1.isLastSession).toBe(false);
    expect(res1.remainingCount).toBe(1);

    // Second session closes: THIS IS the last exit
    const res2 = tracker2.unregister();
    expect(res2.isLastSession).toBe(true);
    expect(res2.remainingCount).toBe(0);
  });

  it("automatically prunes dead session files with non-existent PIDs", () => {
    const deadInfo: SessionInfo = {
      sessionId: "dead-sess",
      pid: 99999999, // Impossible PID
      startTime: Date.now() - 1000,
      lastHeartbeat: Date.now(),
    };
    writeFileSync(join(testDir, "dead-sess.json"), JSON.stringify(deadInfo, null, 2), "utf-8");

    const tracker = new SessionTracker("live-sess", testDir);
    tracker.register();

    const active = tracker.getActiveSessions();
    expect(active.length).toBe(1);
    expect(active[0].sessionId).toBe("live-sess");

    // Verify dead file was cleaned up from disk
    expect(existsSync(join(testDir, "dead-sess.json"))).toBe(false);

    tracker.unregister();
  });

  it("automatically prunes stale session files where heartbeat expired", () => {
    const staleInfo: SessionInfo = {
      sessionId: "stale-sess",
      pid: process.pid,
      startTime: Date.now() - 100000,
      lastHeartbeat: Date.now() - 40000, // 40s ago (stale > 30s)
    };
    writeFileSync(join(testDir, "stale-sess.json"), JSON.stringify(staleInfo, null, 2), "utf-8");

    const tracker = new SessionTracker("live-sess", testDir);
    tracker.register();

    const active = tracker.getActiveSessions();
    expect(active.length).toBe(1);
    expect(active[0].sessionId).toBe("live-sess");

    expect(existsSync(join(testDir, "stale-sess.json"))).toBe(false);

    tracker.unregister();
  });
});
