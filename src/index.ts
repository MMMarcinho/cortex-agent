#!/usr/bin/env node
import readline from 'readline';
import path from 'path';
import fs from 'fs';

import { ToolRegistry } from './tools';
import { Runtime } from './runtime';
import { getConfig } from './config';
import { SessionLogger } from './session';
import * as aizo from './aizo_bridge';
import { EmotionState, EmotionTrajectory } from './runtime/emotion';
import { createLLMClients } from './llm';

// ── Built-in tools ────────────────────────────────────────────────────────────

function buildToolRegistry(): ToolRegistry {
  const registry    = new ToolRegistry();
  const builtinsDir = path.join(__dirname, 'tools', 'builtins');
  for (const file of fs.readdirSync(builtinsDir).filter(f => f.endsWith('.js'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    registry.register(require(path.join(builtinsDir, file)));
  }
  return registry;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap(memoryPath: string): Promise<void> {
  const content = fs.readFileSync(memoryPath, 'utf8');
  const blocks: { item: string; reason: string; score: number; keywords: string[] }[] = [];
  const blockRe = /```memory-seed\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(content)) !== null) {
    for (const chunk of m[1]!.split(/^---$/m)) {
      const entry: Record<string, string> = {};
      for (const line of chunk.trim().split('\n')) {
        const [key, ...rest] = line.split(':');
        if (key && rest.length) entry[key.trim()] = rest.join(':').trim();
      }
      if (entry['item']) {
        blocks.push({
          item:     entry['item'],
          reason:   entry['reason'] ?? '',
          score:    parseFloat(entry['score'] ?? '5') || 5,
          keywords: entry['keywords'] ? entry['keywords'].split(',').map(s => s.trim()) : [],
        });
      }
    }
  }

  if (blocks.length === 0) {
    console.log('No memory-seed blocks found in MEMORY.md');
    return;
  }
  for (const e of blocks) {
    await aizo.add(e.item, e.reason, e.score, e.keywords);
    console.log(`  + [${e.score}] ${e.item}`);
  }
  console.log(`\nBootstrapped ${blocks.length} memory entries.`);
}

// ── Replay mode ───────────────────────────────────────────────────────────────

function replay(eventsPath: string): void {
  const content = fs.readFileSync(eventsPath, 'utf8');
  const lines   = content.trim().split('\n').filter(Boolean);

  const state = new EmotionState();
  const traj  = new EmotionTrajectory();

  const header = ['Step', 'Event', 'Energy', 'Focus', 'Frust.', 'Novelty', 'Conf.'];
  const fmt    = (v: string | number) => String(v).padEnd(12);

  console.log(header.map(fmt).join(''));
  console.log('-'.repeat(header.length * 12));
  console.log(
    ['0', '(initial)', state.energy, state.focus, state.frustration, state.novelty, state.confidence]
      .map((v, i) => i > 1 ? (v as number).toFixed(3) : String(v))
      .map(fmt).join('')
  );

  lines.forEach((line, i) => {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.processEvent(raw as any);
    traj.push(state.snapshot());
    const row = [
      i + 1,
      (raw['type'] ?? raw['event'] ?? '?') as string,
      state.energy, state.focus, state.frustration, state.novelty, state.confidence,
    ];
    console.log(row.map((v, j) => j > 1 ? (v as number).toFixed(3) : String(v)).map(fmt).join(''));
  });

  console.log(`\nFinal — flow state: ${traj.isFlowState()}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === '--bootstrap') {
    const memPath = args[1] ?? path.join(process.cwd(), 'MEMORY.md');
    await bootstrap(memPath);
    return;
  }

  if (args[0] === '--replay') {
    const evPath = args[1];
    if (!evPath) { console.error('Usage: --replay <events.jsonl>'); process.exit(1); }
    replay(evPath);
    return;
  }

  // API key is validated per-provider in llm.config.json or via env vars.
  // We skip the hard check here so users can run with Ollama (no key needed).

  const config  = getConfig();
  aizo.configure({ aizo_binary: config.aizo_binary, aizo_db: config.aizo_db });

  const { main: mainLLM, reflection: reflectLLM } = createLLMClients();
  const session  = new SessionLogger(config.sessions_dir);
  const registry = buildToolRegistry();
  const runtime  = new Runtime(registry, mainLLM, reflectLLM, config, session);

  console.log('cortex initializing...');
  await runtime.initialize();
  console.log(`Session: ${session.sessionId}`);
  console.log('Ready. Type your message, /status, /task <desc>, /done, /reset, or /quit\n');

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === '/quit' || input === '/exit') {
      console.log('Goodbye.');
      rl.close();
      process.exit(0);
    }

    if (input === '/status') {
      console.log('\n' + runtime.emotionSummary() + '\n');
      rl.prompt();
      return;
    }

    if (input.startsWith('/task ')) {
      const desc = input.slice(6).trim();
      const id   = runtime.memory.taskStack.push(desc);
      runtime.memory.activeContext = desc;
      session.logTaskStart(id, desc);
      console.log(`Task #${id} started: ${desc}`);
      rl.prompt();
      return;
    }

    if (input === '/done') {
      const task = runtime.memory.taskStack.active();
      if (!task) { console.log('No active task.'); }
      else {
        runtime.memory.taskStack.complete(task.id);
        runtime.emotion.processEvent({ type: 'TaskCompleted' });
        session.logTaskComplete(task.id);
        console.log(`Task #${task.id} completed.`);
      }
      rl.prompt();
      return;
    }

    if (input === '/reset') {
      runtime.conversationHistory = [];
      console.log('Conversation history cleared.');
      rl.prompt();
      return;
    }

    try {
      process.stdout.write('cortex> ');
      const response = await runtime.runTurn(input);
      console.log(response + '\n');
    } catch (err) {
      console.error(`\nError: ${(err as Error).message}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    session.end(runtime.emotion.snapshot());
    console.log('\nSession ended. Extracting preferences from transcript...');
    const transcriptPath = path.join(session.sessionDir, 'transcript.md');
    let transcript = '';
    try { transcript = fs.readFileSync(transcriptPath, 'utf8'); } catch { /* no transcript */ }
    runtime.analyzeTranscript(transcript).finally(() => process.exit(0));
  });
}

main().catch(err => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
