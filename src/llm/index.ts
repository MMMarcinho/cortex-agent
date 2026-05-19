import path from 'path';
import fs from 'fs';
import { AnthropicClient } from './anthropic';
import { OpenAIClient }    from './openai';
import type { ChatClient, LLMProviderConfig } from './types';

export * from './types';

// ── llm.config.json loader ────────────────────────────────────────────────────
//
// Loaded from (in priority order):
//   ./.llm.config.json       — project-local override
//   ~/.cortex/llm.config.json — global user config
//
// Example:
//   {
//     "main":       { "provider": "anthropic", "model": "claude-sonnet-4-6" },
//     "reflection": { "provider": "openai", "model": "qwen2.5:3b",
//                     "base_url": "http://localhost:11434/v1" }
//   }

interface LLMConfigFile {
  main?:       Partial<LLMProviderConfig>;
  reflection?: Partial<LLMProviderConfig>;
}

const DEFAULTS: { main: LLMProviderConfig; reflection: LLMProviderConfig } = {
  main: {
    provider: 'anthropic',
    model:    process.env['CORTEX_MODEL'] ?? 'claude-sonnet-4-6',
  },
  reflection: {
    provider: 'anthropic',
    model:    'claude-haiku-4-5-20251001',
  },
};

function loadLLMConfigFile(): LLMConfigFile {
  const locations = [
    path.join(process.env['HOME'] ?? '~', '.cortex', 'llm.config.json'),
    path.join(process.cwd(), 'llm.config.json'),
  ];
  let merged: LLMConfigFile = {};
  for (const loc of locations) {
    try {
      const raw = JSON.parse(fs.readFileSync(loc, 'utf8')) as LLMConfigFile;
      merged = {
        main:       { ...merged.main,       ...raw.main },
        reflection: { ...merged.reflection, ...raw.reflection },
      };
    } catch { /* file absent — skip */ }
  }
  return merged;
}

function resolveConfig(
  base: LLMProviderConfig,
  override: Partial<LLMProviderConfig> | undefined,
): LLMProviderConfig {
  return { ...base, ...override };
}

export function createMainClient(fileConfig?: LLMConfigFile): ChatClient {
  const cfg = resolveConfig(DEFAULTS.main, fileConfig?.main);
  return cfg.provider === 'openai' ? new OpenAIClient(cfg) : new AnthropicClient(cfg);
}

export function createReflectionClient(fileConfig?: LLMConfigFile): ChatClient {
  const cfg = resolveConfig(DEFAULTS.reflection, fileConfig?.reflection);
  return cfg.provider === 'openai' ? new OpenAIClient(cfg) : new AnthropicClient(cfg);
}

// Convenience: load file config once, return both clients
export function createLLMClients(): { main: ChatClient; reflection: ChatClient } {
  const file = loadLLMConfigFile();
  return {
    main:       createMainClient(file),
    reflection: createReflectionClient(file),
  };
}
