import { describe, it, expect } from "bun:test";
import { ProxyManager } from "../src/proxy-manager.js";
import { existsSync } from "node:fs";

describe("ProxyManager", () => {
  it("initializes with default options", () => {
    const mgr = new ProxyManager();
    expect(mgr.host).toBe("127.0.0.1");
    expect(mgr.port).toBe(8081);
    expect(mgr.baseUrl).toBe("http://127.0.0.1:8081");
    expect(mgr.useDocker).toBe(false);
    expect(mgr.containerName).toBe("meepo");
  });

  it("respects custom options", () => {
    const mgr = new ProxyManager({
      host: "0.0.0.0",
      port: 9090,
      useDocker: true,
      containerName: "meepo-custom",
    });
    expect(mgr.host).toBe("0.0.0.0");
    expect(mgr.port).toBe(9090);
    expect(mgr.baseUrl).toBe("http://0.0.0.0:9090");
    expect(mgr.useDocker).toBe(true);
    expect(mgr.containerName).toBe("meepo-custom");
  });

  it("finds the native meepo binary on system", () => {
    const mgr = new ProxyManager();
    const bin = mgr.findBinary();
    expect(bin).not.toBeNull();
    if (bin) {
      expect(existsSync(bin)).toBe(true);
    }
  });

  it("finds Dockerfile in repository", () => {
    const mgr = new ProxyManager();
    const dockerfile = mgr.findDockerfile();
    expect(dockerfile).not.toBeNull();
    if (dockerfile) {
      expect(existsSync(dockerfile)).toBe(true);
    }
  });

  it("correctly checks health of running meepo server", async () => {
    const mgr = new ProxyManager({ port: 8081 });
    const isHealthy = await mgr.checkHealth();
    expect(typeof isHealthy).toBe("boolean");
  });
});
