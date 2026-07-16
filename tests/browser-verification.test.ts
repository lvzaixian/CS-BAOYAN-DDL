import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateSnapshot } from '../src/lib/snapshot-validation';
import { validateApprovedSnapshot } from '../scripts/snapshot/approve-snapshot';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('browser tooling keeps the deterministic fixture in dist-e2e only', () => {
  const packageJson = JSON.parse(read('package.json')) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};
  const devDependencies = packageJson.devDependencies ?? {};

  assert.ok(devDependencies['@playwright/test']);
  assert.ok(devDependencies['@axe-core/playwright']);
  assert.ok(devDependencies.pngjs);
  assert.equal(scripts.build, 'vite build --mode production');
  assert.match(scripts['build:e2e'] ?? '', /rm -rf dist-e2e/);
  assert.match(scripts['build:e2e'] ?? '', /vite build --mode e2e/);
  assert.equal(scripts['check:e2e-isolation'], 'tsx scripts/check-e2e-isolation.ts');
  assert.equal(
    scripts['test:e2e'],
    'pnpm run build && pnpm run build:e2e && pnpm run check:e2e-isolation && playwright test',
  );

  const viteConfig = read('vite.config.ts');
  assert.match(viteConfig, /mode === 'e2e'/);
  assert.match(viteConfig, /e2e\/fixtures/);
  assert.match(viteConfig, /data\/approved/);
  assert.match(viteConfig, /outDir:\s*isE2E\s*\?\s*'dist-e2e'\s*:\s*'dist'/);

  const playwrightConfig = read('playwright.config.ts');
  assert.match(playwrightConfig, /timezoneId:\s*'Asia\/Shanghai'/);
  assert.match(playwrightConfig, /colorScheme:\s*'light'/);
  assert.match(playwrightConfig, /reducedMotion:\s*'reduce'/);
  assert.match(playwrightConfig, /trace:\s*'retain-on-failure'/);
  assert.match(playwrightConfig, /screenshot:\s*'only-on-failure'/);
  assert.match(playwrightConfig, /width:\s*1440,\s*height:\s*900/);
  assert.match(playwrightConfig, /width:\s*390,\s*height:\s*844/);
  assert.match(playwrightConfig, /width:\s*320,\s*height:\s*700/);
  assert.match(playwrightConfig, /--outDir dist-e2e/);

  const isolationCheck = read('scripts/check-e2e-isolation.ts');
  assert.match(isolationCheck, /productionBundle\.includes\(e2eMarker\)/);
  assert.match(isolationCheck, /e2eBundle\.includes\(productionMarker\)/);
  assert.match(isolationCheck, /E2E_ACTIVE_SOONER/);

  const fixture = JSON.parse(read('e2e/fixtures/current.json')) as {
    schemaVersion: number;
    counts: Record<string, number>;
    opportunities: Array<{
      projectId: string;
      verificationStatus: string;
      deadlineEpochMs: number | null;
      deadlineOriginal: string;
      eventArrangement?: {
        mode?: string;
        time?: { status?: string; summary?: string };
        formatLocation?: { status?: string; summary?: string };
      };
    }>;
  };
  const fixedNow = Date.parse('2026-07-16T12:00:00+08:00');
  assert.deepEqual(validateSnapshot(fixture, fixedNow), []);
  assert.deepEqual(validateApprovedSnapshot(fixture, fixedNow), []);
  assert.equal(fixture.schemaVersion, 2);
  assert.deepEqual(fixture.counts, {
    confirmedOpen: 7,
    confirmedUnknownDeadline: 1,
    pendingExcluded: 0,
    expired: 1,
  });
  assert.deepEqual(
    fixture.opportunities.map((row) => row.verificationStatus),
    [
      'confirmed-open',
      'confirmed-open',
      'confirmed-open',
      'confirmed-open',
      'confirmed-open',
      'confirmed-open',
      'confirmed-open',
      'confirmed-unknown-deadline',
      'expired',
    ],
  );
  assert.deepEqual(
    new Set(fixture.opportunities.map((row) => row.eventArrangement?.mode)),
    new Set(['online', 'offline', 'hybrid', 'unknown']),
  );
  assert.ok(fixture.opportunities.every((row) => row.eventArrangement?.mode));
  const dateOnly = fixture.opportunities.find((row) => row.projectId.includes('|云海大学|'));
  assert.equal(dateOnly?.deadlineEpochMs, Date.parse('2026-07-18T23:59:59+08:00'));
  assert.equal(dateOnly?.deadlineOriginal, '2026年7月18日截止；官方未公布具体时刻');
  const expired = fixture.opportunities.find((row) => row.verificationStatus === 'expired');
  assert.deepEqual(expired?.eventArrangement, {
    mode: 'unknown',
    time: { status: 'not-published', summary: '未公布' },
    formatLocation: { status: 'not-published', summary: '未公布' },
  });
  const sameDayCounts = new Map<string, number>();
  for (const row of fixture.opportunities) {
    if (row.deadlineEpochMs === null) continue;
    const day = new Date(row.deadlineEpochMs).toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Shanghai',
    });
    sameDayCounts.set(day, (sameDayCounts.get(day) ?? 0) + 1);
  }
  assert.ok([...sameDayCounts.values()].some((count) => count >= 5));
});

test('frontend exposes stable browser selectors and accessible filter state', () => {
  const schoolRow = read('src/components/SchoolRow.svelte');
  const listView = read('src/components/ListView.svelte');
  const toolbar = read('src/components/Toolbar.svelte');
  const filterPanel = read('src/components/FilterPanel.svelte');
  const header = read('src/components/Header.svelte');
  const app = read('src/App.svelte');
  const types = read('src/lib/types.ts');
  const urlState = read('src/lib/urlState.svelte.ts');

  assert.match(schoolRow, /data-row-key=\{key\}/);
  assert.match(schoolRow, /data-deadline-ms=/);
  assert.match(schoolRow, /aria-label="查看项目详情：\{school\.name\} \{school\.institute\} \{school\.project\}"/);
  for (const group of ['active-timed', 'active-unknown', 'expired']) {
    assert.match(listView, new RegExp(`data-row-group="${group}"`));
  }
  assert.match(toolbar, /aria-label="搜索学校、学院、项目和活动类型"/);
  assert.match(toolbar, /placeholder='搜索学校、学院、项目、活动类型/);
  assert.equal(filterPanel.match(/aria-pressed=\{on\}/g)?.length, 4);
  assert.match(filterPanel, />形式</);
  assert.match(filterPanel, />院校所在地</);
  assert.match(filterPanel, /countModes\(rows\)/);
  assert.match(filterPanel, /\{#if hasTagCounts\}/);
  assert.match(types, /modes:\s*EventMode\[\]/);
  assert.match(urlState, /EVENT_MODES/);
  assert.match(urlState, /modes:\s*parseEnumList\(p\.get\('modes'\),\s*EVENT_MODES\)/);
  assert.match(urlState, /p\.set\('modes',\s*s\.modes\.join\(','\)\)/);
  assert.match(urlState, /filters\.modes\s*=\s*next\.modes/);
  assert.match(urlState, /filters\.modes\s*=\s*\[\]/);
  assert.match(toolbar, /filters\.modes\.length/);
  assert.match(toolbar, /\{#each filters\.modes as mode\}/);
  assert.match(app, /modes:\s*filters\.modes/);
  assert.match(header, /aria-expanded=\{drawerOpen\}/);
  assert.match(header, /aria-controls="mobile-filter-drawer"/);
  assert.match(app, /role="dialog"/);
  assert.match(app, /aria-modal="true"/);
  assert.match(app, /aria-label="筛选条件"/);
});

test('CI and deploy gate production packaging behind the same browser suite', () => {
  const ci = read('.github/workflows/ci.yml');
  const ciDiagnostics = ci.indexOf('Initialize browser diagnostics');
  const ciUnit = ci.indexOf('pnpm run test:unit');
  const ciBuild = ci.indexOf('pnpm run build');
  const ciChromium = ci.indexOf('playwright install --with-deps chromium');
  const ciE2E = ci.indexOf('pnpm run test:e2e');
  const ciDistUpload = ci.indexOf('path: dist');
  assert.ok(ciBuild >= 0 && ciBuild < ciChromium && ciChromium < ciE2E && ciE2E < ciDistUpload);
  assert.ok(ciDiagnostics >= 0 && ciDiagnostics < ciUnit);
  assert.match(ci, /if:\s*\$\{\{ failure\(\) \}\}[\s\S]*test-results/);
  assert.match(ci, /Initialize browser diagnostics[\s\S]*browser-diagnostics\/context\.txt/);
  assert.match(ci, /browser-diagnostics\/[\s\S]*if-no-files-found:\s*error/);

  const deploy = read('.github/workflows/deploy.yml');
  const prepareStart = deploy.indexOf('  prepare:');
  const controlPlaneStart = deploy.indexOf('  package-control-plane:');
  const prepare = deploy.slice(prepareStart, controlPlaneStart);
  const deployBuild = prepare.indexOf('pnpm run build');
  const deployChromium = prepare.indexOf('playwright install --with-deps chromium');
  const deployE2E = prepare.indexOf('pnpm run test:e2e');
  const releaseIdentity = prepare.indexOf('Create release identity');
  const packageDist = prepare.indexOf('-C dist -cf');

  assert.ok(
    deployBuild >= 0 &&
      deployBuild < deployChromium &&
      deployChromium < deployE2E &&
      deployE2E < releaseIdentity &&
      releaseIdentity < packageDist,
  );
  assert.match(prepare, /if:\s*\$\{\{ failure\(\) \}\}[\s\S]*test-results/);
  assert.match(prepare, /Initialize browser diagnostics[\s\S]*browser-diagnostics\/context\.txt/);
  assert.match(prepare, /browser-diagnostics\/[\s\S]*if-no-files-found:\s*error/);
  assert.doesNotMatch(prepare, /secrets\./);
  assert.doesNotMatch(prepare, /-C dist-e2e -cf/);
});
