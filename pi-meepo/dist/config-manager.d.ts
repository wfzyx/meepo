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
    warmupPrefill?: boolean;
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
export declare function getDefaultSettings(): MeepoSettings;
export declare class ConfigManager {
    private configPath;
    constructor(customPath?: string);
    getConfigPath(): string;
    resolveConfigPath(): string;
    load(): MeepoSettings;
    save(settings: MeepoSettings): void;
    fetchLlamaModels(llamaBaseUrl: string): Promise<string[]>;
    triggerWarmup(baseUrl: string, sysPrompt?: string): Promise<boolean>;
    openInteractiveSettings(ctx: ExtensionContext, onRestart: (newSettings: MeepoSettings) => Promise<void>): Promise<void>;
}
