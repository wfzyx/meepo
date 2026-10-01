export interface ProxyManagerOptions {
    host?: string;
    port?: number;
    useDocker?: boolean;
    containerName?: string;
    binPath?: string;
}
export type RunnerMode = "docker" | "binary";
export declare class ProxyManager {
    readonly host: string;
    readonly port: number;
    readonly baseUrl: string;
    readonly useDocker: boolean;
    readonly containerName: string;
    private customBinPath?;
    private managed;
    private spawnedProcess?;
    private activeMode;
    constructor(options?: ProxyManagerOptions);
    get isManaged(): boolean;
    get mode(): RunnerMode;
    checkHealth(): Promise<boolean>;
    ensureRunning(onStatus?: (msg: string) => void): Promise<boolean>;
    private isDockerAvailable;
    private startDocker;
    findDockerfile(): string | null;
    findBinary(): string | null;
    private startBinary;
    private pollHealth;
    getPidFilePath(): string;
    private writePidFile;
    private cleanupPidFile;
    private stopDockerContainer;
    private killNativeProcesses;
    private waitForPortRelease;
    stop(onStatus?: (msg: string) => void): Promise<boolean>;
}
