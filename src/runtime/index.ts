import * as aizo from '../aizo_bridge';
import { WorkingMemory } from './working_memory';
import {
  EmotionState, EmotionTrajectory,
  detectL1Events, recallBiased,
  evaluateEmotionalWrite, writeEmotionalTags,
  promptModifiers,
} from './emotion';
import { detectSignals, selectMode, modeDirective, ModeTracker } from './behavioral_mode';
import { ToolRegistry } from '../tools';
import { ReflectionTrigger, spawnReflection } from '../reflection';
import type { Config, EmotionSnapshot, ModeWeights } from '../types';
import type { SessionLogger } from '../session';
import type { ChatClient, ChatMessage, ToolResultBlock, ToolUseBlock, TextBlock, ToolDef } from '../llm/types';

const BASE_PROMPT = `You are a thoughtful cyber bionic assistant with long-term memory and adaptive reasoning.
You have tools available and draw on past experience to guide your decisions.
You never perform irreversible or destructive actions without explicit user confirmation.
When uncertain, ask. When confident, act.`;

export class Runtime {
  private config:  Partial<Config>;
  private session: SessionLogger | null;
  private maxTokens: number;

  private llm:        ChatClient;
  private reflectLLM: ChatClient;
  private tools:      ToolRegistry;
  memory:             WorkingMemory;
  emotion:            EmotionState;
  private trajectory:  EmotionTrajectory;
  private modeTracker: ModeTracker;
  private modeWeights: ModeWeights;
  private reflectionTrigger: ReflectionTrigger;

  private toolCallsSinceReflection = 0;
  private lastActivityAt           = Date.now();
  private consecutiveFailures: Record<string, number> = {};
  private emotionLog:          EmotionSnapshot[]      = [];
  conversationHistory:         ChatMessage[]           = [];

  constructor(
    toolRegistry: ToolRegistry,
    llmClient:    ChatClient,
    reflectClient: ChatClient,
    config: Partial<Config> = {},
    sessionLogger: SessionLogger | null = null,
  ) {
    this.config     = config;
    this.session    = sessionLogger;
    this.maxTokens  = config.max_tokens ?? Number(process.env['CORTEX_MAX_TOKENS'] ?? 4096);

    this.llm             = llmClient;
    this.reflectLLM      = reflectClient;
    this.tools           = toolRegistry;
    this.memory          = new WorkingMemory();
    this.emotion         = new EmotionState();
    this.trajectory      = new EmotionTrajectory();
    this.modeTracker     = new ModeTracker();
    this.modeWeights     = { exploreBias: 0, conserveBias: 0 };
    this.reflectionTrigger = new ReflectionTrigger({
      toolCallThreshold:    config.reflection_tool_call_threshold,
      idleMinutesThreshold: config.reflection_idle_minutes_threshold,
    });
  }

  // ── Session Init ──────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const baselineEntry = await aizo.recall('behavioral-mode-baseline');
    if (baselineEntry.length > 0) {
      try { this.modeWeights = JSON.parse(baselineEntry[0]!.reason) as ModeWeights; } catch { /* ignore */ }
    }

    const emotionEntry = await aizo.recall('session-end-emotion-state');
    if (emotionEntry.length > 0) {
      try {
        const prev = JSON.parse(emotionEntry[0]!.reason) as EmotionSnapshot;
        this.emotion = EmotionState.fromCarryOver(prev);
      } catch { /* ignore */ }
    }

    this.memory.aizoRecallCache = await aizo.top(20);
  }

  // ── Main Turn ─────────────────────────────────────────────────────────────

  async runTurn(userMessage: string): Promise<string> {
    const now = Date.now();

    const l1Events = detectL1Events(userMessage);

    const activeTask  = this.memory.taskStack.active();
    const recallQuery = (activeTask && this.emotion.focus >= 0.4)
      ? activeTask.description : userMessage;

    const { entries, isEmpty, isStrongMatch } = await recallBiased(
      aizo, recallQuery, this.emotion.snapshot()
    );
    this.memory.aizoRecallCache = entries;

    const idleMinutes = (now - this.lastActivityAt) / 60000;
    this.emotion.naturalDecay(idleMinutes);

    for (const e of l1Events) this.emotion.processEvent(e);
    if (isEmpty)       this.emotion.processEvent({ type: 'AizoRecallEmpty' });
    if (isStrongMatch) this.emotion.processEvent({ type: 'AizoRecallStrongMatch' });
    this.trajectory.push(this.emotion.snapshot());
    this.emotionLog.push(this.emotion.snapshot());

    const signals    = detectSignals(userMessage, this.memory.aizoRecallCache);
    const mode       = selectMode(this.emotion.snapshot(), signals, this.modeWeights);
    const autonomous = this.modeTracker.update(mode);

    this.memory.emotionSnapshot = this.emotion.snapshot();
    const thresholds   = this.trajectory.adjustedThresholds();
    const modifiers    = promptModifiers(this.emotion.snapshot(), thresholds);
    const directive    = modeDirective(mode);
    const memContext   = this._formatMemoryContext();
    const systemPrompt = this._buildSystemPrompt(modifiers, directive, memContext);

    this.conversationHistory.push({ role: 'user', content: userMessage });

    const finalText = await this._llmToolLoop(systemPrompt);

    this.memory.episodicBuffer.push({ type: 'UserInteraction', summary: userMessage.slice(0, 100) });

    let output = finalText;
    if (autonomous && this.emotion.energy > 0.4 && mode === 'EXPLORE') {
      output += '\n\n_(I noticed this might be worth exploring further — want me to dig in?)_';
    }

    if (this.session) {
      this.session.logTurn(userMessage, output, this.emotion.snapshot());
    }

    await aizo.add('session-end-emotion-state', JSON.stringify(this.emotion.snapshot()), 5);

    const idleSinceActivity = (Date.now() - this.lastActivityAt) / 60000;
    if (this.reflectionTrigger.shouldReflect(this.toolCallsSinceReflection, idleSinceActivity)) {
      spawnReflection({
        episodicEvents:  this.memory.episodicBuffer.drainForReflection(),
        emotionLog:      this.emotionLog.slice(-20),
        currentMemories: this.memory.aizoRecallCache,
      }, this.reflectLLM);
      this.toolCallsSinceReflection = 0;
      this.emotionLog = [];
      this.emotion.processEvent({ type: 'ReflectionCompleted' });
    }

    this.lastActivityAt = Date.now();
    return output;
  }

  // ── LLM + Tool Use Loop ───────────────────────────────────────────────────

  private async _llmToolLoop(systemPrompt: string): Promise<string> {
    const policy = { avoidComplex: this.emotion.energy < 0.3 || this.emotion.frustration > 0.7 };
    const tools  = this.tools.schemaForPrompt(policy) as ToolDef[];
    const messages: ChatMessage[] = [...this.conversationHistory];

    for (let round = 0; round < 10; round++) {
      this.emotion.processEvent({ type: 'LlmCallCompleted' });

      const response = await this.llm.chat({
        system:    systemPrompt,
        messages,
        tools:     tools.length > 0 ? tools : undefined,
        maxTokens: this.maxTokens,
      });

      const textBlocks    = response.content.filter(b => b.type === 'text')    as TextBlock[];
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as ToolUseBlock[];

      if (toolUseBlocks.length === 0) {
        const text = textBlocks.map(b => b.text).join('');
        this.conversationHistory.push({ role: 'assistant', content: response.content });
        return text;
      }

      messages.push({ role: 'assistant', content: response.content });
      const toolResults: ToolResultBlock[] = [];

      for (const toolUse of toolUseBlocks) {
        const isComplex = this.tools.isComplex(toolUse.name);
        this.emotion.processEvent({ type: isComplex ? 'ComplexToolCall' : 'SimpleToolCall' });

        const result = await this.tools.execute(toolUse.name, toolUse.input);

        const prevSnap = this.emotion.snapshot();
        if (result.exitCode === 0) {
          delete this.consecutiveFailures[toolUse.name];
          this.emotion.processEvent({ type: 'ToolSuccess' });
          aizo.add(
            `use ${toolUse.name}`,
            `Successfully used ${toolUse.name}: ${(result.stdout ?? '').slice(0, 80)}`,
            8.0, [toolUse.name]
          ).catch(() => {});
        } else {
          this.consecutiveFailures[toolUse.name] = (this.consecutiveFailures[toolUse.name] ?? 0) + 1;
          this.emotion.processEvent({
            type: 'ToolFailure',
            consecutiveFailures: this.consecutiveFailures[toolUse.name],
          });
          aizo.add(
            `${toolUse.name} failed`,
            `${toolUse.name} failed: ${(result.stderr ?? '').slice(0, 80)}`,
            2.0, [toolUse.name]
          ).catch(() => {});
        }

        this.trajectory.push(this.emotion.snapshot());
        this.emotionLog.push(this.emotion.snapshot());
        this.toolCallsSinceReflection++;

        if (this.session) {
          this.session.logToolCall(toolUse.name, result.exitCode, this.emotion.snapshot());
        }

        const activeTask = this.memory.taskStack.active();
        const tags = evaluateEmotionalWrite(
          this.emotion.snapshot(), prevSnap,
          {
            toolName: toolUse.name,
            taskType: activeTask ? activeTask.description.split(/\s+/).slice(0, 3).join(' ') : null,
          },
          this.consecutiveFailures[toolUse.name] ?? 0
        );
        writeEmotionalTags(aizo, tags).catch(() => {});

        this.memory.episodicBuffer.push({
          type:     result.exitCode === 0 ? 'ToolSuccess' : 'ToolFailure',
          summary:  `${toolUse.name} → exit ${result.exitCode}`,
          tool:     toolUse.name,
          exitCode: result.exitCode,
        });

        toolResults.push({
          type:        'tool_result',
          tool_use_id: toolUse.id,
          content:     result.exitCode === 0
            ? (result.stdout || '(no output)')
            : `Error: ${result.stderr || 'unknown error'}`,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    return '(max tool call rounds reached)';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _buildSystemPrompt(modifiers: string[], directive: string, memContext: string): string {
    const parts = [BASE_PROMPT];
    if (modifiers.length > 0) parts.push('\n## Current State\n' + modifiers.map(m => `- ${m}`).join('\n'));
    if (directive)  parts.push(`\n## Behavioral Directive\n${directive}`);
    if (memContext) parts.push(`\n## Relevant Memory\n${memContext}`);
    return parts.join('\n');
  }

  private _formatMemoryContext(): string {
    if (this.memory.aizoRecallCache.length === 0) return '';
    return this.memory.aizoRecallCache
      .slice(0, 10)
      .map(e => `[${(e.effective_weight ?? e.score ?? 0).toFixed(1)}] ${e.item}: ${e.reason ?? ''}`)
      .join('\n');
  }

  emotionSummary(): string {
    const mode = selectMode(this.emotion.snapshot(), { riskDetected: false, tabooMatched: false }, this.modeWeights);
    const flow = this.trajectory.isFlowState() ? ' ⚡ FLOW' : '';
    return `Mode: ${mode}${flow}\n` + this.emotion.display();
  }

  analyzeTranscript(transcript: string): Promise<void> {
    return aizo.analyze(transcript, this.reflectLLM);
  }
}
