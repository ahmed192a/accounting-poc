import { extractHeuristic } from './extractor.js';

// Provider interface for document extraction. A provider is { name, mock, extract(text, opts) } and must return
// { fields: { supplier, date, total (piastres), vat (piastres), currency, category }, confidence: {field: 0..1}, reasons: {field: text} }.
// Only the deterministic MOCK heuristic ships. A real OCR/LLM provider would plug in here; its output goes through
// exactly the same review queue, so it can never post, approve or touch a locked period on its own.
const providers = new Map();

export function registerProvider(p) {
  if (!p?.name || typeof p.extract !== 'function') throw new Error('A provider needs a name and an extract(text, opts) function');
  providers.set(p.name, p);
}
export function getProvider(name) {
  const p = providers.get(name);
  if (!p) throw new Error(`Unknown provider ${name}`);
  return p;
}
export const providerNames = () => [...providers.keys()];
export const DEFAULT_PROVIDER = 'mock-heuristic';

registerProvider({ name: DEFAULT_PROVIDER, mock: true, extract: extractHeuristic });
