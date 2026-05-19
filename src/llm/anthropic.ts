import Anthropic from '@anthropic-ai/sdk';
import type { ChatClient, ChatParams, ChatResponse, ContentBlock, LLMProviderConfig } from './types';

export class AnthropicClient implements ChatClient {
  private client: Anthropic;
  private model:  string;

  constructor(config: LLMProviderConfig) {
    this.client = new Anthropic({
      apiKey:  config.api_key ?? process.env['ANTHROPIC_API_KEY'],
      baseURL: config.base_url || undefined,
    });
    this.model = config.model;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const response = await this.client.messages.create({
      model:      this.model,
      max_tokens: params.maxTokens,
      system:     params.system,
      tools:      params.tools?.length ? params.tools as Anthropic.Tool[] : undefined,
      messages:   params.messages as Anthropic.MessageParam[],
    });
    return { content: response.content as ContentBlock[] };
  }
}
