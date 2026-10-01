import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startMeepoServer } from '../src/server';

describe('Meepo Standalone Proxy Server', () => {
  let server: any;
  const testPort = 8089;

  beforeAll(() => {
    server = startMeepoServer({ port: testPort });
  });

  afterAll(() => {
    server.stop();
  });

  it('serves GET /health with mesh health status', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/health`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.orchestrator).toBe('meepo');
    expect(json.port).toBe(testPort);
    expect(json.health).toBeDefined();
  });

  it('serves GET /v1/models matching OpenAI spec', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/v1/models`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.object).toBe('list');
    const ids = json.data.map((m: any) => m.id);
    expect(ids).toContain('mesh');
    expect(ids).toContain('chat');
    expect(ids).toContain('tools');
    expect(ids).toContain('code');
  });

  it(
    'handles POST /v1/chat/completions with automatic prompt diet & routing',
    async () => {
      // 10 mock MCP distractor tools + core tools
      const distractorTools = [
      { type: 'function', function: { name: 'bash', description: 'Run bash' } },
      { type: 'function', function: { name: 'read', description: 'Read file' } },
      { type: 'function', function: { name: 'mcp__github_issues', description: 'GitHub' } },
      { type: 'function', function: { name: 'mcp__slack', description: 'Slack' } },
    ];

    const res = await fetch(`http://127.0.0.1:${testPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mesh',
        messages: [
          {
            role: 'system',
            content:
              'You are a coding assistant.\n<skills>massive bloat</skills>\n<docs>more bloat</docs>\n<tools>- bash: run\n- mcp__slack: slack</tools>',
          },
          { role: 'user', content: 'run bash command "echo hello"' },
        ],
        tools: distractorTools,
        stream: false,
        max_tokens: 16,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.choices).toBeDefined();
    expect(json.choices.length).toBeGreaterThan(0);
    },
    { timeout: 30000 }
  );

  it(
    'streams SSE chunks on POST /v1/chat/completions when stream=true',
    async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mesh',
          messages: [{ role: 'user', content: 'Say "pong"' }],
          stream: true,
          max_tokens: 16,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const text = await res.text();
      expect(text).toContain('data: ');
      expect(text).toContain('[DONE]');
    },
    { timeout: 30000 }
  );
});
