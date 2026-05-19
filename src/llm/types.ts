// Unified LLM types — Anthropic-style as the canonical internal format.
// Provider adapters translate to/from this when needed.

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface ChatParams {
  system:    string;
  messages:  ChatMessage[];
  tools?:    ToolDef[];
  maxTokens: number;
}

export interface ChatResponse {
  content: ContentBlock[];
}

export interface ChatClient {
  chat(params: ChatParams): Promise<ChatResponse>;
}

export interface LLMProviderConfig {
  provider:  'anthropic' | 'openai';
  model:     string;
  api_key?:  string;   // falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY env vars
  base_url?: string;   // custom endpoint (Ollama, Groq, Together, etc.)
}
