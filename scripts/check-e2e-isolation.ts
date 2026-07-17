import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const productionSnapshot = JSON.parse(
  readFileSync(path.join(root, 'data/approved/current.json'), 'utf8'),
) as { opportunities?: Array<{ projectId?: unknown }> };
const e2eSnapshot = JSON.parse(
  readFileSync(path.join(root, 'e2e/fixtures/current.json'), 'utf8'),
) as { opportunities?: Array<{ projectId?: unknown }> };

function requireMarker(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} snapshotId is missing`);
  }
  return value;
}

function readBundle(directory: string): string {
  const absolute = path.join(root, directory);
  if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${directory} is missing; build both production and E2E bundles first`);
  }
  const chunks: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) chunks.push(readFileSync(target, 'utf8'));
    }
  };
  visit(absolute);
  return chunks.join('\n');
}

const productionMarker = requireMarker(
  productionSnapshot.opportunities?.[0]?.projectId,
  'production',
);
const e2eMarker = requireMarker(e2eSnapshot.opportunities?.[0]?.projectId, 'E2E');
const productionBundle = readBundle('dist');
const e2eBundle = readBundle('dist-e2e');

if (!productionBundle.includes(productionMarker)) {
  throw new Error('production bundle does not contain its approved snapshot marker');
}
if (productionBundle.includes(e2eMarker) || productionBundle.includes('E2E_ACTIVE_SOONER')) {
  throw new Error('E2E fixture leaked into the production bundle');
}
if (!e2eBundle.includes(e2eMarker) || !e2eBundle.includes('E2E_ACTIVE_SOONER')) {
  throw new Error('E2E bundle does not contain the deterministic fixture');
}
if (e2eBundle.includes(productionMarker)) {
  throw new Error('production snapshot leaked into the E2E bundle');
}

console.log('Production and E2E bundles are isolated.');
