import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ConfigManager, getDefaultSettings } from "../src/config-manager.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ConfigManager", () => {
  const testConfigFile = join(tmpdir(), "meepo-test-config-" + Math.random().toString(36).slice(2) + ".json");

  beforeEach(() => {
    if (existsSync(testConfigFile)) {
      rmSync(testConfigFile, { force: true });
    }
  });

  afterEach(() => {
    if (existsSync(testConfigFile)) {
      rmSync(testConfigFile, { force: true });
    }
  });

  it("returns defaults when config file does not exist", () => {
    const mgr = new ConfigManager(testConfigFile);
    const cfg = mgr.load();
    expect(cfg.runner).toBe("binary");
    expect(cfg.port).toBe(8081);
    expect(cfg.roles.chat.modelId).toBe("gemma-4-E2B-it");
    expect(cfg.roles.tools.modelId).toBe("LFM2.5-1.2B-Instruct");
    expect(cfg.roles.code.modelId).toBe("Qwen3.5-2B");
  });

  it("saves and loads updated settings", () => {
    const mgr = new ConfigManager(testConfigFile);
    const cfg = mgr.load();

    cfg.runner = "docker";
    cfg.port = 8888;
    cfg.roles.chat.modelId = "custom-gemma";
    cfg.roles.code.modelId = "custom-qwen";

    mgr.save(cfg);

    const reloaded = mgr.load();
    expect(reloaded.runner).toBe("docker");
    expect(reloaded.port).toBe(8888);
    expect(reloaded.roles.chat.modelId).toBe("custom-gemma");
    expect(reloaded.roles.code.modelId).toBe("custom-qwen");
  });

  it("handles offline llama-server gracefully when querying models", async () => {
    const mgr = new ConfigManager(testConfigFile);
    const models = await mgr.fetchLlamaModels("http://127.0.0.1:99999");
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBe(0);
  });
});
