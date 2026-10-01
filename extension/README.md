# pi-meepo

Zero-config lifecycle manager and auto-wiring extension for [Meepo](https://github.com/wfzyx/meepo) in [Pi](https://github.com/badlogic/pi-mono).

Inspired by `pi-headroom`, `pi-meepo` automatically manages the Meepo multi-brain proxy lifecycle so you never have to start or stop background servers manually.

---

## How It Works

```
Pi Session Start → checks :8081 health → auto-spawns binary / starts Docker container
                                              ↓
                        Registers active session PID in heartbeat registry
                                              ↓
                   Status bar shows "🟢 Meepo [bin]" in Pi footer
                                              ↓
Pi Session Exit  → unregisters session PID
                   Checks remaining active Pi sessions
                   ├─ Other sessions still open? → Keeps Meepo alive
                   └─ Last session exited?       → Auto-shuts down Meepo proxy / container
```

1. **`session_start`**: Checks if the Meepo proxy is already running on `:8081`. If offline, automatically discovers your native Go binary (`meepo`) or starts the Docker container (`meepo:latest`), polling `/health` until ready.
2. **Session Reference Counting**: Tracks active Pi sessions via PID and heartbeats in `/tmp/meepo-sessions/`. If you have 3 terminal tabs open with Pi, Meepo stays warm across all of them.
3. **`session_shutdown` (Last-Exit Teardown)**: When you close your terminal or exit Pi, the extension unregisters the session. If it was the **last active Pi session**, it triggers a graceful shutdown (`POST /v1/shutdown` or `docker stop`) so zero background CPU or RAM is wasted.

---

## Installation

```bash
# From local package inside Meepo repo
pi install ./pi-meepo

# Or test directly without installing
pi -e ./pi-meepo
```

---

## Configuration

| Environment Variable   | Default       | Description                                                      |
|------------------------|---------------|------------------------------------------------------------------|
| `MEEPO_PORT`           | `8081`        | Port for the Meepo reverse proxy                                 |
| `MEEPO_HOST`           | `127.0.0.1`   | Bind address for the proxy                                       |
| `MEEPO_USE_DOCKER`     | `0`           | Set to `1` to run Meepo inside Docker instead of native binary   |
| `MEEPO_CONTAINER_NAME` | `meepo`       | Docker container name                                            |
| `MEEPO_BIN`            | _auto-detect_ | Explicit path to `meepo` binary (otherwise searches PATH, ~/.local/bin) |

---

## Commands

### `/meepo`
Shows proxy status, active Pi sessions, upstream health (`llama-server` and `von`), and runner mode.

### `/meepo settings`
Opens an interactive TUI settings menu with arrow-key navigation to configure:
- **Runner mode**: Toggle between Docker container and native Go binary
- **Port**: Set proxy port (default: 8081)
- **Upstream llama.cpp URL**: Configure llama-server address
- **Local role models**: Pick discovered models from `llama-server` for Chat (`gemma-4-E2B-it`), Tools (`LFM2.5-1.2B-Instruct`), and Code (`Qwen3.5-2B`)
- **Von Router & Cloud**: Configure Von System One endpoint and Cloud escalation model
- **Save & Restart**: Automatically saves to `~/.pi/agent/meepo.json` (or `.pi/meepo.json`) and restarts the proxy

Non-interactive subcommands:
- `/meepo settings docker on|off` — Toggle Docker runner
- `/meepo settings model <chat|tools|code|cloud> <modelId>` — Configure role model
- `/meepo settings port <number>` — Change proxy port
- `/meepo settings llama <url>` — Change upstream llama.cpp URL
- `/meepo settings show` — Print current JSON configuration
### `/meepo start`
Manually starts the Meepo proxy or container if stopped.

### `/meepo stop`
Manually stops the Meepo proxy or container.

### `/meepo restart`
Performs a clean stop and restart of the Meepo proxy.

---

## Status Bar

The extension displays a compact indicator in Pi's status bar:
- `🟢 Meepo [bin]` — Proxy is online and running via native Go binary
- `🟢 Meepo [docker]` — Proxy is online and running via Docker container
- `⏳ Starting Meepo...` — Proxy is spinning up
- `⚠️ Meepo offline` — Proxy could not be reached
