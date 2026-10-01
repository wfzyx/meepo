export interface ExtensionUIContext {
  setStatus: (key: string, status: string | undefined) => void;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  theme: {
    fg: (color: string, text: string) => string;
    bg?: (color: string, text: string) => string;
  };
  select?: (title: string, options: string[], opts?: any) => Promise<string | undefined>;
  input?: (title: string, defaultValue?: string, opts?: any) => Promise<string | undefined>;
  confirm?: (title: string, defaultValue?: boolean, opts?: any) => Promise<boolean | undefined>;
  [key: string]: any;
}

export interface ExtensionContext {
  ui: ExtensionUIContext;
  sessionId?: string;
  cwd?: string;
  [key: string]: any;
}

export interface CommandDefinition {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

export interface ExtensionAPI {
  on: (
    event: "session_start" | "session_shutdown" | string,
    handler: (event: any, ctx: ExtensionContext) => Promise<void> | void,
  ) => void;
  registerCommand: (name: string, def: CommandDefinition) => void;
}
