import * as aizo from '../aizo_bridge';
import type { ReflectionInput } from '../types';
import type { ChatClient } from '../llm/types';

const DEFAULT_TRIGGER = {
  toolCallThreshold:    15,
  idleMinutesThreshold: 10,
};

export class ReflectionTrigger {
  private toolCallThreshold:    number;
  private idleMinutesThreshold: number;

  constructor(opts: Partial<typeof DEFAULT_TRIGGER> = {}) {
    this.toolCallThreshold    = opts.toolCallThreshold    ?? DEFAULT_TRIGGER.toolCallThreshold;
    this.idleMinutesThreshold = opts.idleMinutesThreshold ?? DEFAULT_TRIGGER.idleMinutesThreshold;
  }

  shouldReflect(toolCallsSinceLast: number, idleMinutes: number): boolean {
    return toolCallsSinceLast >= this.toolCallThreshold
      || idleMinutes >= this.idleMinutesThreshold;
  }
}

// Reflection focuses only on what can't be inferred from the transcript alone:
// which existing memories are still relevant (touch), and whether the emotion
// model needs calibration. Preference extraction from text is handled by
// aizo.analyze() at session end (using aizo extract → LLM → aizo import).

interface ReflectionResult {
  confirmed_items?:    { item: string }[];
  emotion_correction?: { suggested_novelty_adjustment: number; suggested_confidence_adjustment: number };
  mode_correction?:    { explore_bias_delta: number; conserve_bias_delta: number };
}

async function runReflection(
  input: ReflectionInput,
  llmClient: ChatClient,
): Promise<ReflectionResult | null> {
  if (input.episodicEvents.length === 0) return null;

  try {
    const summary = input.episodicEvents.slice(-20).map(e =>
      `[${new Date(e.timestamp).toISOString()}] ${e.type}: ${e.summary}`
    ).join('\n');

    const memContext = (input.currentMemories ?? []).slice(0, 10).map(m =>
      `[${((m.effective_weight ?? m.score ?? 0) as number).toFixed(1)}] ${m.item}`
    ).join('\n') || '(none)';

    const emotionArc = (input.emotionLog ?? []).slice(-5).map(snap =>
      `E:${snap.energy.toFixed(2)} Fr:${snap.frustration.toFixed(2)} N:${snap.novelty.toFixed(2)} Co:${snap.confidence.toFixed(2)}`
    ).join(' → ') || '(none)';

    const prompt = `You are reviewing a mid-session activity log to calibrate an agent's internal state.

## Active Memories (top 10 by weight)
${memContext}

## Recent Events (last 20)
${summary}

## Emotion Arc
${emotionArc}

Return ONLY valid JSON. Return empty arrays/zeros if nothing needs changing.
{
  "confirmed_items": [{"item": "..."}],
  "emotion_correction": {"suggested_novelty_adjustment": 0.0, "suggested_confidence_adjustment": 0.0},
  "mode_correction": {"explore_bias_delta": 0.0, "conserve_bias_delta": 0.0}
}`;

    const resp = await llmClient.chat({
      system:    '',
      messages:  [{ role: 'user', content: prompt }],
      maxTokens: 512,
    });

    const text    = (resp.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text ?? '{}';
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    const result  = JSON.parse(cleaned) as ReflectionResult;

    for (const item of (result.confirmed_items ?? [])) {
      await aizo.touch(item.item);
    }

    process.stderr.write(
      `[reflection] confirmed ${(result.confirmed_items ?? []).length} memories\n`
    );

    return result;
  } catch (err) {
    process.stderr.write(`[reflection] failed: ${(err as Error).message}\n`);
    return null;
  }
}

export function spawnReflection(input: ReflectionInput, llmClient: ChatClient): void {
  setImmediate(() => runReflection(input, llmClient).catch(() => {}));
}
