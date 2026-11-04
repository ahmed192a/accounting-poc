import { AppError } from '../../../errors.js';
import { setting } from '../../../db.js';
import eta from './eta_mock.js';
import zatca from './zatca_mock.js';
import etaLive from './eta_live.js';

// Registry of tax-authority adapters (mocks, plus the UNVERIFIED live ETA adapter). The active one is the setting `tax_adapter`.
export const ADAPTERS = { [eta.id]: eta, [zatca.id]: zatca, [etaLive.id]: etaLive };
export const DEFAULT_ADAPTER = eta.id;

export function adapterById(id) {
  const a = ADAPTERS[id];
  if (!a) throw new AppError(400, 'UNKNOWN_ADAPTER', `Unknown tax adapter "${id}" (known: ${Object.keys(ADAPTERS).join(', ')})`);
  return a;
}
export const activeAdapter = (db) => adapterById(setting(db, 'tax_adapter') ?? DEFAULT_ADAPTER);
export const listAdapters = () => Object.values(ADAPTERS).map((a) => ({ id: a.id, label: a.label, mock: a.mock, live: !!a.live }));
