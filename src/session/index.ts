import fs from 'fs';
import path from 'path';
import type { EmotionSnapshot, TaskEntry } from '../types';

interface SessionTask extends Pick<TaskEntry, 'id' | 'description'> {
  startedAt:    string;
  completedAt?: string;
}

interface SessionSummary {
  sessionId:    string;
  startedAt:    string;
  endedAt:      string;
  durationMs:   number;
  turns:        number;
  toolCalls:    number;
  tasks:        SessionTask[];
  finalEmotion: EmotionSnapshot | null;
}

export class SessionLogger {
  readonly sessionId:  string;
  readonly sessionDir: string;
  private readonly startedAt:      Date;
  private readonly transcriptPath: string;
  private readonly eventsPath_:    string;
  private readonly summaryPath:    string;

  private turnCount = 0;
  private toolCalls_ = 0;
  private tasks: SessionTask[] = [];

  constructor(sessionsDir: string) {
    const now  = new Date();
    const date = now.toISOString().slice(0, 10);
    const id   = `${date}-${now.toTimeString().slice(0, 8).replace(/:/g, '')}`;

    this.sessionId  = id;
    this.sessionDir = path.join(sessionsDir, id);
    this.startedAt  = now;

    this.transcriptPath = path.join(this.sessionDir, 'transcript.md');
    this.eventsPath_    = path.join(this.sessionDir, 'events.jsonl');
    this.summaryPath    = path.join(this.sessionDir, 'summary.json');

    fs.mkdirSync(this.sessionDir, { recursive: true });
    this._appendTranscript(`# Session ${id}\n\nStarted: ${now.toISOString()}\n\n---\n\n`);
  }

  get eventsPath(): string { return this.eventsPath_; }

  logTurn(userMessage: string, assistantResponse: string, emotion: EmotionSnapshot): void {
    this.turnCount++;
    const ts  = new Date().toISOString();
    const bar = this._emotionBar(emotion);
    this._appendTranscript(
      `## Turn ${this.turnCount} — ${ts}\n\n` +
      `**User:** ${userMessage}\n\n` +
      `**Cortex:** ${assistantResponse}\n\n` +
      (bar ? `*Emotion: ${bar}*\n\n` : '') +
      `---\n\n`
    );
    this._appendEvent({ type: 'Turn', turn: this.turnCount, timestamp: ts, user: userMessage.slice(0, 200), emotion });
  }

  logToolCall(toolName: string, exitCode: number, emotion: EmotionSnapshot): void {
    this.toolCalls_++;
    this._appendEvent({
      type:      exitCode === 0 ? 'ToolSuccess' : 'ToolFailure',
      timestamp: new Date().toISOString(),
      tool:      toolName,
      exitCode,
      emotion,
    });
  }

  logTaskStart(id: string, description: string): void {
    this.tasks.push({ id, description, startedAt: new Date().toISOString() });
    this._appendEvent({ type: 'TaskStart', timestamp: new Date().toISOString(), taskId: id, description });
  }

  logTaskComplete(id: string): void {
    const task = this.tasks.find(t => t.id === id);
    if (task) task.completedAt = new Date().toISOString();
    this._appendEvent({ type: 'TaskComplete', timestamp: new Date().toISOString(), taskId: id });
  }

  logEvent(event: Record<string, unknown>): void {
    this._appendEvent({ timestamp: new Date().toISOString(), ...event });
  }

  end(finalEmotion: EmotionSnapshot | null): void {
    const endedAt = new Date();
    const summary: SessionSummary = {
      sessionId:    this.sessionId,
      startedAt:    this.startedAt.toISOString(),
      endedAt:      endedAt.toISOString(),
      durationMs:   endedAt.getTime() - this.startedAt.getTime(),
      turns:        this.turnCount,
      toolCalls:    this.toolCalls_,
      tasks:        this.tasks,
      finalEmotion,
    };
    try { fs.writeFileSync(this.summaryPath, JSON.stringify(summary, null, 2)); } catch { /* ignore */ }
    this._appendTranscript(
      `## Session End — ${endedAt.toISOString()}\n\n` +
      `Turns: ${this.turnCount} | Tool calls: ${this.toolCalls_} | ` +
      `Duration: ${Math.round(summary.durationMs / 1000)}s\n`
    );
  }

  private _appendTranscript(text: string): void {
    try { fs.appendFileSync(this.transcriptPath, text); } catch { /* ignore */ }
  }

  private _appendEvent(obj: Record<string, unknown>): void {
    try { fs.appendFileSync(this.eventsPath_, JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
  }

  private _emotionBar(snap: EmotionSnapshot): string {
    const f = (v: number) => v.toFixed(2);
    return `E:${f(snap.energy)} Fo:${f(snap.focus)} Fr:${f(snap.frustration)} N:${f(snap.novelty)} Co:${f(snap.confidence)}`;
  }
}
