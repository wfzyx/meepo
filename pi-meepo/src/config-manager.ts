import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "./types.js";

export interface ModelRoleSetting {
  name: string;
  modelId: string;
  [key: string]: any;
}

export interface RouterRoleSetting {
  name: string;
  endpoint: string;
  [key: string]: any;
}

export interface MeepoSettings {
  runner: "binary" | "docker";
  port: number;
  host: string;
  containerName: string;
  llamaServer: {
    baseUrl: string;
    modelDir?: string;
  };
  roles: {
    router: RouterRoleSetting;
    chat: ModelRoleSetting;
    tools: ModelRoleSetting;
    code: ModelRoleSetting;
    cloud: ModelRoleSetting;
  };
  [key: string]: any;
}

export function getDefaultSettings(): MeepoSettings {
  return {
    runner: "binary",
    port: 8081,
    host: "127.0.0.1",
    containerName: "meepo",
    llamaServer: {
      baseUrl: "http://127.0.0.1:8080/v1",
      modelDir: "~/models",
    },
    roles: {
      router: {
        name: "von-1.3.5",
        endpoint: "http://127.0.0.1:8000/v1/systemone",
      },
      chat: {
        name: "gemma-4-E2B-it",
        modelId: "gemma-4-E2B-it",
      },
      tools: {
        name: "LFM2.5-1.2B-Instruct",
        modelId: "LFM2.5-1.2B-Instruct",
      },
      code: {
        name: "Qwen3.5-2B",
        modelId: "Qwen3.5-2B",
      },
      cloud: {
        name: "claude-opus-5-5",
        modelId: "claude-opus-5-5",
      },
    },
  };
}

export class ConfigManager {
  private configPath: string;

  constructor(customPath?: string) {
    this.configPath = customPath || this.resolveConfigPath();
  }

  getConfigPath(): string {
    return this.configPath;
  }

  resolveConfigPath(): string {
    const cwd = process.cwd();
    // 1. Project-local .pi/meepo.json
    const projectPi = join(cwd, ".pi", "meepo.json");
    if (existsSync(projectPi)) return projectPi;

    // 2. Repo root meepo.config.json if in repo
    const repoConfig = join(cwd, "meepo.config.json");
    if (existsSync(repoConfig)) return repoConfig;

    // 3. User global ~/.pi/agent/meepo.json
    const userGlobal = join(homedir(), ".pi", "agent", "meepo.json");
    return userGlobal;
  }

  load(): MeepoSettings {
    const defaults = getDefaultSettings();
    if (!existsSync(this.configPath)) {
      return defaults;
    }

    try {
      const raw = readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...parsed,
        llamaServer: {
          ...defaults.llamaServer,
          ...(parsed.llamaServer || {}),
        },
        roles: {
          router: { ...defaults.roles.router, ...(parsed.roles?.router || {}) },
          chat: { ...defaults.roles.chat, ...(parsed.roles?.chat || {}) },
          tools: { ...defaults.roles.tools, ...(parsed.roles?.tools || {}) },
          code: { ...defaults.roles.code, ...(parsed.roles?.code || {}) },
          cloud: { ...defaults.roles.cloud, ...(parsed.roles?.cloud || {}) },
        },
      };
    } catch {
      return defaults;
    }
  }

  save(settings: MeepoSettings): void {
    const dir = join(this.configPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.configPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  async fetchLlamaModels(llamaBaseUrl: string): Promise<string[]> {
    const cleanUrl = llamaBaseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
    try {
      const res = await fetch(`${cleanUrl}/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return [];
      const data: any = await res.json();
      if (Array.isArray(data?.data)) {
        return data.data.map((m: any) => m.id || m.model || String(m)).filter(Boolean);
      }
      if (Array.isArray(data?.models)) {
        return data.models.map((m: any) => m.id || m.name || String(m)).filter(Boolean);
      }
      return [];
    } catch {
      return [];
    }
  }

  async openInteractiveSettings(
    ctx: ExtensionContext,
    onRestart: (newSettings: MeepoSettings) => Promise<void>,
  ): Promise<void> {
    if (!ctx.ui?.select) {
      ctx.ui?.notify("Interactive settings require TUI mode with ctx.ui.select", "warning");
      return;
    }

    const settings = this.load();

    while (true) {
      const runnerEmoji = settings.runner === "docker" ? "🐳" : "⚡";
      const runnerLabel = settings.runner === "docker" ? "Docker container" : "Native Go binary";

      const menu = [
        `${runnerEmoji} Runner Mode: ${runnerLabel}`,
        `🔌 Proxy Port: ${settings.port}`,
        `🦙 Upstream llama.cpp URL: ${settings.llamaServer.baseUrl}`,
        `💬 Chat Model: ${settings.roles.chat.modelId}`,
        `🛠️ Tools Model: ${settings.roles.tools.modelId}`,
        `💻 Code Model: ${settings.roles.code.modelId}`,
        `🧭 Von Router Endpoint: ${settings.roles.router.endpoint}`,
        `☁️ Cloud Escalation Model: ${settings.roles.cloud.modelId}`,
        `💾 Save & Restart Meepo`,
        `❌ Exit without saving`,
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
          const val = await ctx.ui.input(
            "Enter llama-server base URL:",
            settings.llamaServer.baseUrl,
          );
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
          "⬅️ Back",
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
          "⬅️ Back",
        ];
        const picked = await ctx.ui.select("Select cloud escalation model:", cloudChoices);
        if (!picked || picked.includes("Back")) continue;

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
