/** Host-owned model selection. Reasoning effort is separate from the model id. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { OperatorError } from './verbs/io.ts';
export const EFFORTS = ['off','minimal','low','medium','high','xhigh','max'] as const;
export type ReasoningEffort = typeof EFFORTS[number];
export function parseEffort(value: unknown): ReasoningEffort {
 if (typeof value !== 'string' || !(EFFORTS as readonly string[]).includes(value)) throw new OperatorError(`Invalid reasoning effort: ${String(value)}.`, `Choose ${EFFORTS.join(', ')} using harness model setup.`);
 return value as ReasoningEffort;
}
const read = (file: string): Record<string, unknown> => {
 try { const value: unknown = JSON.parse(readFileSync(file,'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object'); return value as Record<string,unknown>; }
 catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new OperatorError(`Cannot read model settings at ${file}: ${(error as Error).message}`); }
};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
export const modelSettingsPath = (project: string) => path.join(`${project}-harness`,'model.json');
export function resolveModelSettings(project: string, env: NodeJS.ProcessEnv = process.env) {
 const saved = read(modelSettingsPath(project));
 if (Object.keys(saved).length && saved.version !== 1) throw new OperatorError('Unsupported saved model settings version.');
 for (const key of ['provider','model']) if (saved[key] !== undefined && !text(saved[key])) throw new OperatorError(`Invalid saved model ${key}.`);
 if (saved.effort !== undefined) parseEffort(saved.effort);
 const needsDefault = !(text(env.HARNESS_PROVIDER) ?? text(saved.provider)) || !(text(env.HARNESS_MODEL) ?? text(saved.model));
 const pi = needsDefault && text(env.HARNESS_AGENT_DIR) ? read(path.join(env.HARNESS_AGENT_DIR!, 'settings.json')) : {};
 const pick = (environment: unknown, local: unknown, fallback: unknown, defaultValue?: string) => text(environment) ? { value: text(environment), source:'environment/config file' } : text(local) ? { value:text(local), source:'saved project setting' } : text(fallback) ? { value:text(fallback), source:'Pi model default' } : { value:defaultValue, source:'harness default' };
 const provider = pick(env.HARNESS_PROVIDER,saved.provider,pi.defaultProvider);
 const model = pick(env.HARNESS_MODEL,saved.model,pi.defaultModel);
 // Pi's personal effort does not leak into isolated runs.
 const effort = pick(env.HARNESS_REASONING_EFFORT,saved.effort,undefined,'medium');
 return {provider:provider.value,model:model.value,effort:parseEffort(effort.value),sources:{provider:provider.source,model:model.source,effort:effort.source}};
}
export async function supportedEfforts(piPackage: string, provider: string, model: string): Promise<ReasoningEffort[]> {
 const require = createRequire(path.join(piPackage,'package.json'));
 const file = require.resolve.paths('@earendil-works/pi-ai')?.map(root=>path.join(root,'@earendil-works/pi-ai/dist/compat.js')).find(file=>existsSync(file));
 if (!file) throw new OperatorError('The installed Pi model catalog could not be located.');
 const catalog = await import(pathToFileURL(file).href);
 const selected = catalog.getModel(provider,model);
 if (!selected) throw new OperatorError(`Model ${provider}/${model} is not in the installed Pi catalog.`, 'Choose an exact installed model id with harness model setup.');
 return catalog.getSupportedThinkingLevels(selected).map(parseEffort);
}
export async function assertModelEffort(piPackage: string, request: {provider?:string|undefined;model?:string|undefined;effort?:ReasoningEffort}): Promise<void> {
 const effort = request.effort ?? 'medium';
 if (!request.provider || !request.model) throw new OperatorError('Select a provider and model before starting model work.', 'Run harness model setup.');
 const allowed = await supportedEfforts(piPackage,request.provider,request.model);
 if (!allowed.includes(effort)) throw new OperatorError(`${request.provider}/${request.model} does not support reasoning effort ${effort}.`, `Supported: ${allowed.join(', ')}. Use harness model setup or change HARNESS_REASONING_EFFORT.`);
}
export const modelLabel = (settings:{provider?:string|undefined;model?:string|undefined;effort?:ReasoningEffort}) => `${settings.provider ?? 'unselected'}/${settings.model ?? 'unselected'} · reasoning ${settings.effort ?? 'medium'}`;
