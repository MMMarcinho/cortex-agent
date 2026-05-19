import OpenAI from 'openai';
import type {
  ChatClient, ChatParams, ChatResponse,
  ContentBlock, TextBlock, ToolUseBlock, ChatMessage, LLMProviderConfig,
} from './types';

// ── Message format conversion ─────────────────────────────────────────────────
//
// Our canonical format is Anthropic-style. Convert to/from OpenAI format here.

function toOpenAIMessages(
  system: string,
  messages: ChatMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      // Split into text + tool_calls
      const textParts = msg.content.filter(b => b.type === 'text') as TextBlock[];
      const toolCalls = msg.content.filter(b => b.type === 'tool_use') as ToolUseBlock[];

      const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
        role:    'assistant',
        content: textParts.map(b => b.text).join('') || null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map(tc => ({
          id:       tc.id,
          type:     'function' as const,
          function: {
            name:      tc.name,
            arguments: JSON.stringify(tc.input),
          },
        }));
      }
      result.push(assistantMsg);

    } else {
      // user — may contain tool_result blocks
      const toolResults = msg.content.filter(b => b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults as { type: 'tool_result'; tool_use_id: string; content: string }[]) {
          result.push({
            role:         'tool',
            tool_call_id: tr.tool_use_id,
            content:      tr.content,
          });
        }
      } else {
        const text = msg.content.filter(b => b.type === 'text').map(b => (b as TextBlock).text).join('');
        result.push({ role: 'user', content: text });
      }
    }
  }

  return result;
}

// ── OpenAI Client ─────────────────────────────────────────────────────────────

export class OpenAIClient implements ChatClient {
  private client: OpenAI;
  private model:  string;

  constructor(config: LLMProviderConfig) {
    this.client = new OpenAI({
      apiKey:  config.api_key ?? process.env['OPENAI_API_KEY'] ?? 'no-key',
      baseURL: config.base_url || 'https://api.openai.com/v1',
    });
    this.model = config.model;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const messages = toOpenAIMessages(params.system, params.messages);

    const tools = params.tools?.map(t => ({
      type:     'function' as const,
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.input_schema,
      },
    }));

    const response = await this.client.chat.completions.create({
      model:      this.model,
      max_tokens: params.maxTokens,
      messages,
      tools:      tools?.length ? tools : undefined,
    });

    const choice  = response.choices[0]!;
    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    for (const tc of choice.message.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      content.push({
        type:  'tool_use',
        id:    tc.id,
        name:  tc.function.name,
        input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      } satisfies ToolUseBlock);
    }

    return { content };
  }
}
