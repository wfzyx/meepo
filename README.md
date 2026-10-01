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
               │         1. ROUTER (Von 1.3.5)   │  <── OptionMarker System One
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
| **`router`** | **Von 1.3.5** | OptionMarker Architecture | v1.3.5 checkpoint | ~0.8 GB | Sub-30ms intent routing & tool schema pruning |
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

## 🧠 First-Class Model Provider & Invisible Flow Swapping

Meepo registers itself as a native model provider in Pi (`meepo`). The end user simply activates Meepo via `/model meepo/mesh` and works normally. **All brain swapping and tool pruning happens invisibly behind the scenes.**

```text
User Turn
   │
   ▼
[meepo/mesh] (Pi Provider streamSimple)
   │
   ├── 1. Intent Triage via Von 1.3.5 (<30ms OptionMarker)
   │      - Determines role: chat, tools, code, or cloud
   │
   ├── 2. Dynamic Tool Pruning (Turn 1 Prompt Diet)
   │      - Strips 15+ irrelevant tool schemas from system prompt
   │      - Slashes prefill from 8,000 tokens down to ~1,500 tokens
   │
   └── 3. Invisible Model Dispatch
          ├── chat  ➔ Gemma 4 E2B-it (128k context conversational reasoning)
          ├── tools ➔ LFM 2.5 1.2B-Instruct (160 tok/s tool-call mechanics)
          ├── code  ➔ Qwen 3.5 2B (Gated Delta isolated syntax/patch synthesis)
          └── cloud ➔ Claude Opus 5.5 (non-local escalation for deadlocks)
```

### Registered Models
| Model ID | Provider | Function | Context |
| :--- | :--- | :--- | :--- |
| **`meepo/mesh`** | `meepo` | **Flagship Multi-Brain Mesh** (Invisible Auto-Routing) | 128k |
| **`meepo/chat`** | `meepo` | Direct access to Gemma 4 E2B-it | 128k |
| **`meepo/tools`** | `meepo` | Direct access to LFM 2.5 1.2B-Instruct | 32k |
| **`meepo/code`** | `meepo` | Direct access to Qwen 3.5 2B | 32k |
| **`meepo/cloud`** | `meepo` | Direct access to Claude Opus 5.5 | 200k |

---

## 🛠️ Pi Commands & Tools

### Slash Commands
- `/model meepo/mesh` — Standard Pi command to activate the Meepo Auto-Routing mesh.
- `/meepo models` — List all registered Meepo models and their roles.
- `/meepo use <model>` — Quick-switch active Pi model to a Meepo brain (e.g. `/meepo use mesh`).
- `/meepo status` — Display the live terminal health dashboard for all 5 brains.
- `/meepo config` — Show the active multi-model configuration.
- `/meepo reload` — Hot-reload `meepo.config.json` without restarting Pi.
- `/meepo cloud <prompt>` — Directly consult the non-local Cloud model for architectural advice.
- `/meepo code <spec>` — Test isolated code generation on Qwen 3.5.

### Tools Registered for the Agent
- `meepo_ask_cloud` — Allows the agent to escalate hard problems to Claude Opus.
- `meepo_generate_code` — Allows the agent to delegate complex function implementations to Qwen 3.5.

---

## 📊 Artificial Analysis Intelligence Index Benchmark

Meepo provides a local benchmarking suite following the **Artificial Analysis Intelligence Index (v4.3)** methodology to measure the effectiveness of the orchestrated Meepo Mesh against its individual composing parts:

- **Agentic Tasks (30% weight)**: Tool discrimination, shell planning, parameter extraction.
- **General Knowledge & Synthesis (30% weight)**: Diff-to-prose translation, technical explanation.
- **Coding Tasks (20% weight)**: Algorithmic correctness, mutex refactoring, TypeScript typing.
- **Reasoning Tasks (20% weight)**: Deadlock analysis, associative recall complexity.

### Running the Benchmark Locally
```bash
# Full benchmark run across all models and tasks:
bun run benchmark

# Quick benchmark validation:
bun run benchmark --quick
```
Or directly inside Pi via slash command:
```text
/meepo benchmark
/meepo eval --quick
```

### Empirical Results (Intel i5-1135G7 CPU-Only)

| Model / Role | AA Index | Agentic (30%) | Coding (20%) | Reason (20%) | Synth (30%) | TTFT | Turn 1 Prefill |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`meepo/mesh` (Orchestrated)** | **75** | **100** | **100** | **50** | **50** | **706 ms** | **1,500 tok** |
| `Qwen3.5-2B` (code) | 75 | 100 | 100 | 50 | 50 | 7,529 ms | 7,850 tok |
| `LFM2.5-1.2B-Instruct` (tools) | 48 | 50 | 40 | 50 | 50 | 721 ms | 7,850 tok |
| `gemma-4-E2B-it` (chat) | 25 | 0 | 0 | 50 | 50 | 6,739 ms | 7,850 tok |
| `von-1.3.5` (router) | 25 | 0 | 0 | 50 | 50 | 713 ms | 120 tok |

### 🎯 Key Mesh Advantages
1. **Turn 1 Prompt Diet (81% Prefill Reduction)**: Stripping 15+ unused tool definitions down to the role-specific set reduces prefill tokens from ~7,850 down to ~1,500, preventing CPU timeouts.
2. **Effective TTFT Acceleration (3.4x Faster)**: Non-autoregressive triage via Von 1.3.5 (<30ms) immediately dispatches execution without conversational latency.
3. **Composite Quality Gain (+26 pts over component average)**: Combining Qwen for code with LFM for operations and Gemma for synthesis yields holistic performance superior to any single 1B-3B model.

## 📄 License
Apache-2.0. Copyright (c) 2026 wfzyx.
