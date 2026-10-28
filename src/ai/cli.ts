import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { loadAiConfig, runCategorizerOnce } from './job.ts';

// Categorizes the descriptions that have no category yet. Needs AI_ENABLED=on and OPENROUTER_API_KEY.
const store = openSqliteStore(loadConfig(process.env).dbPath, fileURLToPath(new URL('../../migrations', import.meta.url)));
const config = loadAiConfig({ ...process.env, AI_ENABLED: process.env.AI_ENABLED ?? 'on' });
const result = await runCategorizerOnce(store, config, () => new Date());
console.log(result ? `asked ${result.asked}, applied ${result.applied}, suggested ${result.suggested}, dropped ${result.dropped}, cost US$ ${result.costUsd.toFixed(4)}${result.stoppedBy ? `, stopped by ${result.stoppedBy}` : ''}` : 'nothing run (check OPENROUTER_API_KEY)');
store.close();
