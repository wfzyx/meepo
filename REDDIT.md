# Why solo 2B models suck as coding agents (and how 4 of them in 5.6GB RAM actually finish tasks)

### The Issue
If you point a coding agent (Pi, Claude Code, Aider) at a local 2B model on a laptop CPU, it fails immediately:
1. **Turn 1 prefill is too slow:** The harness injects system prompts and 15 MCP tool schemas (~8,000 tokens). On an Intel i5 CPU, that takes 3 minutes just to compute KV cache, hitting timeouts before the model even starts typing.
2. **Small models choke on tool schemas:** When a 2B model sees 15 tool definitions, it hallucinates parameters or wraps JSON in conversational markdown instead of calling the tool.
3. **No self-correction:** A model that writes code can't execute tests or inspect compiler stderr on its own.

### The Idea
Instead of running one model that tries to do chat, tools, and code all at once, split the work across 4 small models running warm in memory (~5.6GB RAM total):

1. **Router (Von 1.3.5 / ModernBERT, 395M):** Runs in <30ms on CPU. It checks the user prompt and strips all unused tool schemas before prefill. Turn 1 prompt drops from 7,850 to 1,500 tokens (81% reduction). TTFT drops from 7.5s to 700ms.
2. **Chat (Gemma 4 E2B, 128k context):** Handles conversation and planning.
3. **Tools (LFM 2.5 1.2B):** Only gets the 2 tools it needs. Runs `bash`, `read`, and `git`.
4. **Code (Qwen 3.5 2B):** Generates code patches in isolation with zero tool schemas in its prompt.
5. **Cloud (Claude Opus 5.5 / Gemini Flash):** Opt-in fallback for deadlocks and complex architecture.

To the agent harness, it registers as a standard model provider (`/model meepo/mesh`), so it looks like a single fast model.

### The Numbers
Tested on an Intel Core i5-1135G7 (4 cores / 8 threads, CPU-only, no GPU):

| Capability Tier | Solo Qwen 3.5 2B | Meepo (100% Local) | Meepo (Hybrid + Cloud) | Claude Opus 5.5 Solo |
| :--- | :---: | :---: | :---: | :---: |
| **Tool Calling** *(15 MCP schemas)* | ❌ 0% *(wraps JSON in prose)* | 🟢 100% *(schemas pruned)* | 🟢 100% | 🟢 98% |
| **Single-File Code** *(Quickselect / AST)* | 🟢 70% | 🟢 75% | 🟢 75% | 🟢 95% |
| **5-Stage Workflow Survival** *(test ➔ patch ➔ verify)* | ❌ 0% *(fails at stage 2)* | 🟢 100% | 🟢 100% | 🟢 92% |
| **Closed-Loop Fix** *(Pass@2 via test feedback)* | ❌ 0% *(no execution loop)* | 🟢 85% | 🟢 85% | 🟢 95% |
| **Deadlocks & Deep Architecture** | ❌ 0% | ❌ 10% *(hard ceiling)* | 🟢 95% *(routes to Opus)* | 🟢 95% |
| **Turn 1 Latency (Intel i5 CPU)** | 🐢 7,500 ms | ⚡ 706 ms | ⚡ 706 ms | ⏱️ 2,100 ms |
| **Cost per 1k Turns** *(80% cache hit)* | $0.00 | $0.00 | $2.63 | $42.33 |

Four 2B models obviously don't replace Opus on hard architectural problems (10% score). But for the 80% of routine agent chores (grepping files, checking git status, fixing typos, running tests), it runs locally at $0 with sub-second latency instead of burning cloud credits.

### Feedback?
- Has anyone else tried dynamic tool pruning before prefill to fix local CPU latency?
- What are people using for local routing between small models?

Code and setup: https://github.com/wfzyx/meepo (runs with `bun` + `llama-server`)
