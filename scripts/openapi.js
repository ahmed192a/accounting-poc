#!/usr/bin/env node
// Generates docs/openapi.json from the loaded module registry (route meta.summary, permission,
// path parameters). Output is deterministic (sorted, no timestamps). Run: node scripts/openapi.js [out.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadModules, MODULES_DIR } from '../src/modules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Convert "/api/items/:id" to "/api/items/{id}". */
export const toOpenApiPath = (p) => p.replace(/:(\w+)/g, '{$1}');

export function buildOpenApi(registry, { version = '0.1.0' } = {}) {
  const paths = {};
  const routes = [...registry.routes].sort((a, b) => (a.path + a.method < b.path + b.method ? -1 : 1));
  for (const r of routes) {
    const p = toOpenApiPath(r.path);
    const op = {
      summary: r.meta.summary ?? '',
      tags: [r.module],
      operationId: `${r.method.toLowerCase()}_${r.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      parameters: r.names.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      responses: {
        [r.method === 'POST' ? '201' : '200']: { description: 'Success (JSON)' },
        ...(r.isPublic ? {} : { 401: { description: 'Unknown user' }, 403: { description: 'Missing permission' } }),
        400: { description: 'Validation error: { error: { code, message } }' },
      },
    };
    if (r.meta.permission) op['x-permission'] = r.meta.permission;
    if (!r.isPublic) op.security = [{ userHeader: [] }];
    if (r.method !== 'GET') op.requestBody = { required: false, content: { 'application/json': { schema: { type: 'object' } } } };
    (paths[p] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Accounting PoC API',
      version,
      description: 'Generated from route declarations in src/modules/*. Documentation only: request/response schemas are not described. Money is integer piastres. PoC identification is the x-user-id header (no real authentication yet).',
    },
    paths,
    components: { securitySchemes: { userHeader: { type: 'apiKey', in: 'header', name: 'x-user-id' } } },
  };
}

export async function generate(outFile = resolve(ROOT, 'docs', 'openapi.json')) {
  const registry = await loadModules(MODULES_DIR);
  const doc = buildOpenApi(registry);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');
  return { outFile, doc };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outFile, doc } = await generate(process.argv[2] ? resolve(process.argv[2]) : undefined);
  const ops = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(`Wrote ${outFile}: ${Object.keys(doc.paths).length} paths, ${ops} operations`);
}
