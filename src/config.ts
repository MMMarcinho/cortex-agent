import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Config } from './types';

export const GLOBAL_CONFIG_DIR   = path.join(os.homedir(), '.cortex');
export const PROJECT_CONFIG_DIR  = path.join(process.cwd(), '.cortex');
const GLOBAL_CONFIG_FILE  = path.join(GLOBAL_CONFIG_DIR, 'config.json');
const PROJECT_CONFIG_FILE = path.join(PROJECT_CONFIG_DIR, 'config.json');

const DEFAULTS: Config = {
  model:            'claude-sonnet-4-6',
  reflection_model: 'claude-haiku-4-5-20251001',
  max_tokens:       4096,

  aizo_binary: 'aizo',
  aizo_db:     path.join(GLOBAL_CONFIG_DIR, 'memory.db'),

  sessions_dir: path.join(GLOBAL_CONFIG_DIR, 'sessions'),

  reflection_tool_call_threshold:    15,
  reflection_idle_minutes_threshold: 10,

  emotion: {
    llm_call_energy_cost:          0.02,
    tool_success_confidence_gain:  0.05,
    tool_success_novelty_gain:     0.03,
    tool_failure_frustration_gain: 0.1,
    tool_failure_confidence_cost:  0.06,
    task_completed_energy_gain:    0.12,
    task_completed_focus_loss:     0.05,
    reflection_energy_gain:        0.08,
    positive_kw_energy_gain:       0.08,
    positive_kw_novelty_gain:      0.06,
    negative_kw_frustration_gain:  0.07,
    recall_empty_focus_cost:       0.04,
    recall_match_confidence_gain:  0.06,
    complex_tool_focus_cost:       0.04,
    simple_tool_novelty_gain:      0.02,
  },
};

function loadJson(filePath: string): Partial<Config> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<Config>;
  } catch {
    return {};
  }
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const [k, v] of Object.entries(override) as [keyof T, unknown][]) {
    if (
      v !== null && typeof v === 'object' && !Array.isArray(v) &&
      typeof result[k] === 'object' && result[k] !== null
    ) {
      result[k] = deepMerge(result[k] as object, v as object) as T[typeof k];
    } else if (v !== undefined) {
      result[k] = v as T[typeof k];
    }
  }
  return result;
}

function envOverrides(): Partial<Config> {
  const o: Partial<Config> = {};
  if (process.env['CORTEX_MODEL'])        o.model        = process.env['CORTEX_MODEL'];
  if (process.env['CORTEX_MAX_TOKENS'])   o.max_tokens   = Number(process.env['CORTEX_MAX_TOKENS']);
  if (process.env['AIZO_BINARY'])         o.aizo_binary  = process.env['AIZO_BINARY'];
  if (process.env['AIZO_DB'])             o.aizo_db      = process.env['AIZO_DB'];
  if (process.env['CORTEX_SESSIONS_DIR']) o.sessions_dir = process.env['CORTEX_SESSIONS_DIR'];
  return o;
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const global  = loadJson(GLOBAL_CONFIG_FILE);
  const project = loadJson(PROJECT_CONFIG_FILE);
  const env     = envOverrides();

  _config = deepMerge(deepMerge(deepMerge(DEFAULTS, global), project), env);

  for (const dir of [GLOBAL_CONFIG_DIR, _config.sessions_dir]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }

  return _config;
}
