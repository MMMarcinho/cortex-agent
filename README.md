# cortex-agent

A cyber bionic AI agent with human-like cognition — long-term memory, a live emotion model, and adaptive behavioral modes that shift as the session evolves.

## What makes it different

Most agents are stateless: every session starts blank, every response is calculated the same way. Cortex is designed around the observation that effective human intelligence is not stateless — it carries memory across time, adapts its behavior based on internal state, and knows when it's confident vs. uncertain, energized vs. depleted.

Cortex implements this through three interlocking systems:

**Emotion model** — five continuous dimensions (energy, focus, frustration, novelty, confidence) that change in response to tool outcomes, user feedback, memory hits, and idle time. Not cosmetic: the values directly influence what the agent does and how it talks to you.

**Long-term memory** — powered by [aizo](https://github.com/mmmarcinho/aizo), a Rust-based semantic memory store. Preferences, patterns, tool outcomes, and session insights are written back automatically. Recalled at the start of every turn and injected into the system prompt.

**Behavioral modes** — four discrete modes (PROTECT, CONSERVE, EXPLORE, DELIVER) selected each turn from the emotional state and memory signals. Each mode changes the system prompt directive and tool availability.

---

## Architecture

```
src/
├── index.ts                  # CLI entry point, session lifecycle
├── config.ts                 # Config loading (file + env vars)
├── types.ts                  # All shared types
│
├── runtime/
│   ├── index.ts              # Main Runtime class — orchestrates everything
│   ├── emotion.ts            # EmotionState, EmotionTrajectory, recall bias, prompt modifiers
│   ├── behavioral_mode.ts    # Mode selection (PROTECT / CONSERVE / EXPLORE / DELIVER)
│   └── working_memory.ts     # TaskStack, EpisodicBuffer, WorkingMemory
│
├── llm/
│   ├── types.ts              # ChatClient interface + message types
│   ├── index.ts              # Provider loader (reads llm.config.json)
│   ├── anthropic.ts          # Anthropic SDK client
│   └── openai.ts             # OpenAI-compatible client (Ollama, Groq, Together, etc.)
│
├── aizo_bridge/
│   └── index.ts              # aizo binary wrapper: recall, add, touch, top, analyze
│
├── reflection/
│   └── index.ts              # Mid-session reflection trigger and runner
│
├── session/
│   └── index.ts              # Session logger (transcript.md, events.jsonl, summary.json)
│
└── tools/
    ├── index.ts              # ToolRegistry
    └── builtins/
        ├── shell.ts          # shell — run arbitrary shell commands
        ├── read_file.ts      # read_file — read a file from disk
        ├── write_file.ts     # write_file — write a file to disk
        └── grep.ts           # grep — search file contents
```

---

## Emotion model

Each turn the agent maintains five dimensions, all clamped to `[0, 1]`:

| Dimension | Starts at | Meaning |
|-----------|-----------|---------|
| `energy` | 1.0 | Capacity for complex work. Drains with each LLM call and tool use |
| `focus` | 0.7 | Alignment with the current task. Drops on task switches |
| `frustration` | 0.05 | Accumulated friction. Rises on tool failures, negative feedback |
| `novelty` | 0.5 | Degree of unexplored territory. Rises when memory recalls nothing |
| `confidence` | 0.5 | Trust in own judgement. Rises on successes, drops on failures |

**Natural decay** — frustration and novelty drift back toward baseline at 5% per minute of idle time.

**Cross-session carry-over** — the emotion snapshot from the end of a session is averaged with the defaults at the start of the next one, so a session that ended frustrated does not restart at peak confidence.

**Trajectory** — a rolling 5-snapshot window fits a linear trend over each dimension. These trends adjust the thresholds used by behavioral modes and prompt modifiers.

**Flow state** — when both novelty trend and confidence trend are positive, the agent is in flow: all caution modifiers are suppressed and it runs without second-guessing itself.

---

## Behavioral modes

Selected every turn from emotion and memory signals:

| Mode | Trigger | Effect |
|------|---------|--------|
| `PROTECT` | Risk pattern in input, or taboo memory matched | Warns user, refuses to execute, asks for explicit confirmation |
| `CONSERVE` | Energy < 0.3 or frustration > 0.7 | Minimal response, complex tools suppressed, defers to user |
| `EXPLORE` | Novelty > 0.6 and confidence > 0.5 | Considers alternatives before acting, notes interesting options |
| `DELIVER` | Default | Executes directly, no extra commentary |

Risk patterns that trigger PROTECT include: `rm -rf`, `drop table`, `force push`, `chmod 777`, `kill -9`, and similar destructive commands.

---

## Long-term memory (aizo)

Cortex uses [aizo](https://github.com/mmmarcinho/aizo) — a Rust binary — as its memory backend. Aizo stores items with a score (0–10), keywords, and a reason string. Items decay over time and are re-weighted by access frequency.

**What gets written automatically:**
- Tool success/failure patterns (with tool name and exit code snippet)
- Emotional threshold crossings (e.g. frustration spike during a specific tool)
- Confidence builders (high-confidence moments tied to task types)
- Session-end emotion state (for cross-session carry-over)

**End-of-session extraction** — at shutdown, the full session transcript is piped through `aizo extract` (which generates a structured extraction prompt), then through the reflection LLM, then through `aizo import`. This extracts user preferences, habits, and patterns from natural conversation without any manual annotation.

**Mid-session reflection** — triggered after 15 tool calls or 10 minutes of idle time. Uses the reflection LLM to review the episodic buffer and confirm which memory items are still relevant (via `aizo touch`), plus optional corrections to novelty and confidence.

**Memory-biased recall** — the recall query is modified by emotional state before hitting aizo:
- High frustration: appends `safe reliable` to the query and includes taboo items
- Low confidence: filters to only high-score items (≥ 7.0)
- Low energy: caps results at 5

---

## Multi-provider LLM

Cortex decouples the LLM from the agent. Any provider that speaks the OpenAI API format works.

Two independent clients are configured: **main** (used for every agent turn) and **reflection** (used for mid-session reflection and end-of-session memory extraction). You can use a large model for main and a cheap/fast model for reflection.

### Configuration file

Create `llm.config.json` in the project root, or `~/.cortex/llm.config.json` for global defaults. Project-local file takes priority.

```json
{
  "main": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6"
  },
  "reflection": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001"
  }
}
```

**Using Ollama (local):**
```json
{
  "main": {
    "provider": "openai",
    "model": "llama3.1:8b",
    "base_url": "http://localhost:11434/v1"
  },
  "reflection": {
    "provider": "openai",
    "model": "qwen2.5:3b",
    "base_url": "http://localhost:11434/v1"
  }
}
```

**Using Groq:**
```json
{
  "main": {
    "provider": "openai",
    "model": "llama-3.3-70b-versatile",
    "base_url": "https://api.groq.com/openai/v1",
    "api_key": "gsk_..."
  },
  "reflection": {
    "provider": "openai",
    "model": "llama-3.1-8b-instant",
    "base_url": "https://api.groq.com/openai/v1",
    "api_key": "gsk_..."
  }
}
```

---

## Installation

**Requirements:** Node.js ≥ 18, TypeScript 6

```bash
git clone https://github.com/mmmarcinho/cortex-agent
cd cortex-agent
npm install
npm run build
```

**aizo** (the memory backend) is bundled via `aizo-node` and downloaded automatically on `npm install`. If the binary is unavailable, the agent runs in degraded memory mode — everything still works, memory is just not persisted.

You can also install aizo manually via Cargo:
```bash
cargo install aizo
```

---

## Running

```bash
npm start
```

```
cortex initializing...
Session: 2026-05-19-143022
Ready. Type your message, /status, /task <desc>, /done, /reset, or /quit

you>
```

### CLI commands

| Command | Description |
|---------|-------------|
| `/status` | Show current emotion state with bar chart and active mode |
| `/task <description>` | Push a new task onto the task stack |
| `/done` | Mark the active task complete (triggers confidence and energy boost) |
| `/reset` | Clear conversation history (keeps memory and emotion state) |
| `/quit` or `/exit` | End session and run memory extraction from transcript |

### Bootstrap memory

Seed the agent's memory from `MEMORY.md`:

```bash
npm run bootstrap
```

Edit `MEMORY.md` to define initial preferences, habits, and taboos before the first run. Each `memory-seed` block is an item with a score and keywords.

### Replay an emotion timeline

Reconstruct how the emotion model evolved across a saved session:

```bash
npm run replay -- ~/.cortex/sessions/2026-05-19-143022/events.jsonl
```

Prints a step-by-step table of all five emotion dimensions across every logged event.

---

## Configuration

Config is loaded in priority order: defaults → `~/.cortex/config.json` → `./.cortex/config.json` → environment variables.

```json
{
  "model": "claude-sonnet-4-6",
  "reflection_model": "claude-haiku-4-5-20251001",
  "max_tokens": 4096,

  "aizo_binary": "aizo",
  "aizo_db": "~/.cortex/memory.db",

  "sessions_dir": "~/.cortex/sessions",

  "reflection_tool_call_threshold": 15,
  "reflection_idle_minutes_threshold": 10,

  "emotion": {
    "llm_call_energy_cost": 0.02,
    "tool_success_confidence_gain": 0.05,
    "tool_failure_frustration_gain": 0.1,
    "task_completed_energy_gain": 0.12
  }
}
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `CORTEX_MODEL` | Override the main model |
| `CORTEX_MAX_TOKENS` | Override max tokens per call |
| `CORTEX_SESSIONS_DIR` | Override sessions directory |
| `AIZO_BINARY` | Path to aizo binary |
| `AIZO_DB` | Path to aizo database file |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI-compatible API key |

---

## Session output

Each session writes three files to `~/.cortex/sessions/<session-id>/`:

| File | Contents |
|------|----------|
| `transcript.md` | Human-readable log of every turn with emotion bar |
| `events.jsonl` | Machine-readable event stream (turns, tool calls, task events) |
| `summary.json` | Session totals: turns, tool calls, duration, final emotion snapshot |

---

## Adding tools

Add a `.ts` file to `src/tools/builtins/`. Export an object matching the `Tool` interface:

```typescript
import type { Tool } from '../../types';

const myTool: Tool = {
  name: 'my_tool',
  description: 'What this tool does',
  params: [
    { name: 'input', type: 'string', desc: 'The input string', required: true },
  ],
  handler: async (params) => {
    const result = doSomething(params['input'] as string);
    return { exitCode: 0, stdout: result, stderr: '' };
  },
};

module.exports = myTool;
```

The tool is auto-discovered and registered at startup. To mark it as complex (suppressed in CONSERVE mode), add its name to `COMPLEX_TOOLS` in `src/tools/index.ts`.
