# 🧙‍♂️ Meepo (Divided We Stand)

> **Multi-Brain Local & Hybrid Agent Orchestration Mesh for Pi.**  
> *Five specialized intelligences running in strict sequential harmony on commodity hardware without VRAM bloat.*

---

## 🏛️ The Philosophy: Divided We Stand

Trying to force a single 1B–7B local model to simultaneously act as Shakespeare, a JSON tool-calling puppet, an AST software engineer, and an architectural oracle results in total failure:
- **System prompts bloat to 8k tokens**, choking CPU prefill for 200+ seconds on Turn 1.
- **Pure RNNs / dynamic states** suffer associative recall degradation on random diff anchors.
- **Pure Transformers** bloat KV caches into gigabytes of RAM.

**Meepo splits the intelligence into five plain, standard functional roles:**

```text
                           [User Input]
                                │
                                ▼
               ┌─────────────────────────────────┐
               │         1. ROUTER (Von)         │  <── Non-autoregressive 395M ModernBERT
               │   • Sub-30ms categorical route  │      Single forward pass, 0 KV cache
               │   • Prunes 70% of tool schemas  │
               └────────────────┬────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        ▼                                               ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐
│        2. CHAT (Gemma 4)     │        │        3. TOOLS (LFM 2.5)    │
│  • 128k context window       │        │  • Fast 1D convolutions      │
│  • Human dialogue & synthesis│        │  • Agent loop & tool puppet  │
└──────────────────────────────┘        └──────────────┬───────────────┘
                                                       │
                                 ┌─────────────────────┴─────────────────────┐
                                 ▼                                           ▼
                  ┌──────────────────────────────┐            ┌──────────────────────────────┐
                  │       4. CODE (Qwen 3.5)     │            │       5. CLOUD (Opus)        │
                  │ • Gated Delta recurrence     │            │  • Claude Opus / Gemini      │
                  │ • Isolated AST / diff synth  │            │  • Concurrency & deadlocks   │
                  └──────────────────────────────┘            └──────────────────────────────┘
```

---

## 🧠 The Brain Roster (Scheme 1: Functional Standard)

| Role Key | Model | Architecture | Parameter / Quant | RAM Footprint | Execution Lane |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`router`** | **Von 1.0** | ModernBERT Encoder | 395M (FP16/OpenVINO) | ~0.8 GB | Sub-30ms intent routing & tool schema pruning |
| **`chat`** | **Gemma 4 E2B-it** | Dense Multimodal | ~2B (Q4_K_M ~3.1 GB) | ~3.1 GB | 128k context, native system role, human dialogue |
| **`tools`** | **LFM 2.5** | Continuous Dynamical | 1.2B (Q4_K_M 730 MB) | ~0.73 GB | 160 tok/s prefill, tool calling, bash/fs execution |
| **`code`** | **Qwen 3.5** | Gated Delta Network | 2B (Q4_K_M 1.28 GB) | ~1.28 GB | AST syntax, algorithm logic, pure patch generation |
| **`cloud`** | **Claude Opus** | Cloud / Non-local | Frontier Cloud | 0 GB local | Hard concurrency, deadlocks, architectural crossroads |
| **TOTAL** | — | — | — | **~5.9 GB RAM** | **<10% of 64GB DDR4** |

---

## ⚡ Key Innovations

### 1. Dynamic Tool Pruning (Prompt Diet)
On commodity CPUs, evaluating 8,000 tokens of 15 tool schemas takes minutes. **`router`** classifies the intent in 20ms and strips away irrelevant tools before the prompt reaches local autoregressive models.

### 2. Isolated Code Offload (`meepo_generate_code`)
`tools` (LFM 2.5) acts as the agentic mechanic. When it needs to write an intricate multi-line function or diff, it calls `meepo_generate_code`. **`code`** (Qwen 3.5) generates the raw code block in an isolated context without tool schema pollution. `tools` then packages it into Pi's `edit` or `write` tool.

### 3. Non-Local Cloud Escalation (`meepo_ask_cloud`)
When hitting a concurrency race, memory leak, or repeated failure, the local agent escalates out-of-band to **`cloud`** (Claude Opus or Gemini Flash).

---

## 🚀 Quickstart

### 1. Requirements
- [Bun](https://bun.sh) (`v1.2+`)
- [llama.cpp](https://github.com/ggerganov/llama.cpp) with `llama-server` running on `http://127.0.0.1:8080`
- [Von](https://github.com/wfzyx/von) server running on `http://127.0.0.1:8000` (optional, has fallback)

### 2. Install & Test
```bash
cd ~/Code/personal/meepo
bun install
bun test
```

### 3. Load into Pi
To load Meepo into your active Pi session:
```bash
pi --extension ~/Code/personal/meepo/src/index.ts
```
Or symlink it into your user extensions directory:
```bash
ln -s ~/Code/personal/meepo/src/index.ts ~/.pi/agent/extensions/meepo.ts
```

---

## 🛠️ Pi Commands & Tools

### Commands
- `/meepo status` — Display the live terminal health dashboard for all 5 brains.
- `/meepo config` — Show the active multi-model configuration.
- `/meepo reload` — Hot-reload `meepo.config.json` without restarting Pi.
- `/meepo cloud <prompt>` — Directly consult the non-local Cloud model for architectural advice.
- `/meepo code <spec>` — Test isolated code generation on Qwen 3.5.

### Tools Registered for the Agent
- `meepo_ask_cloud` — Allows the agent to escalate hard problems to Claude Opus.
- `meepo_generate_code` — Allows the agent to delegate complex function implementations to Qwen 3.5.

---

## 📄 License
Apache-2.0. Copyright (c) 2026 wfzyx.
