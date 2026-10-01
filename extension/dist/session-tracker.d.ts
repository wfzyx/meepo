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
export declare class SessionTracker {
    private sessionsDir;
    private sessionId;
    private pid;
    private heartbeatInterval?;
    constructor(sessionId: string, customDir?: string);
    getSessionsDir(): string;
    getSessionId(): string;
    register(): void;
    unregister(): UnregisterResult;
    getActiveSessions(): SessionInfo[];
    private sessionFilePath;
}
