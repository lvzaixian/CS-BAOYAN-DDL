import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listViewSource = readFileSync(
  new URL('../src/components/ListView.svelte', import.meta.url),
  'utf8',
);
const schoolRowSource = readFileSync(
  new URL('../src/components/SchoolRow.svelte', import.meta.url),
  'utf8',
);
const detailPanelSource = readFileSync(
  new URL('../src/components/DetailPanel.svelte', import.meta.url),
  'utf8',
);
const appCssSource = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

test('keeps the public list groups in actionable, unknown and expired order', () => {
  const active = listViewSource.indexOf("head('进行中'");
  const unknown = listViewSource.indexOf("head('未知截止'");
  const expired = listViewSource.indexOf("head('已过期'");

  assert.ok(active !== -1, 'missing 进行中 group label');
  assert.ok(unknown > active, '未知截止 must follow 进行中');
  assert.ok(expired > unknown, '已过期 must follow 未知截止');
  assert.doesNotMatch(listViewSource, /head\('(日期未公布|已结束)'/);
});

test('renders only the compact verification badge copy for public rows', () => {
  const markup = schoolRowSource.slice(schoolRowSource.indexOf('</script>'));

  assert.match(
    schoolRowSource,
    /school\.verificationStatus === 'expired'\s*\?\s*'已过期'\s*:\s*'已核验'/,
  );
  assert.match(markup, /\{verificationLabel\}/);
  assert.match(markup, /\{#each displayTags as t\}/);
  assert.doesNotMatch(schoolRowSource, /t === '(已开营|已结营)'/);
  assert.doesNotMatch(markup, />\s*(已开营|已结营)\s*</);
});

test('uses five unframed detail sections in the required order', () => {
  const bodyStart = detailPanelSource.indexOf('<!-- body -->');
  const footerStart = detailPanelSource.indexOf('<!-- footer cta -->');
  const body = detailPanelSource.slice(bodyStart, footerStart);
  const headings = ['截止信息', '食宿与交通', '推荐信', '材料', '信息来源'];
  let previous = -1;

  for (const heading of headings) {
    const position = body.indexOf(heading);
    assert.ok(position > previous, `${heading} is missing or out of order`);
    previous = position;
  }

  assert.equal(body.match(/<section\b/g)?.length, 5);
  assert.doesNotMatch(body, /surface-[23]|rounded-(?:lg|xl)/);
});

test('shows deadline and application facts with legacy-safe fallbacks', () => {
  assert.match(detailPanelSource, /school\.deadlineOriginal/);
  assert.match(detailPanelSource, /school\.deadlineMs === null\s*\?\s*'未公布'/);
  assert.match(
    detailPanelSource,
    /const deadlineStatus = \$derived\(expiredDeadlineText\(school\)\)/,
  );
  assert.match(
    detailPanelSource,
    /const normalizedDeadline = \$derived\(\s*school\.deadlineMs === null/,
  );
  assert.match(detailPanelSource, /verifiedAtMs === null\s*\?\s*'未记录'/);
  assert.match(detailPanelSource, /school\.logistics\.summary/);
  assert.match(detailPanelSource, /factStatusLabels\[school\.logistics\.status\]/);
  assert.match(detailPanelSource, /school\.recommendation\.summary/);
  assert.match(detailPanelSource, /school\.materials\.summary/);
});

test('orders official and discovery sources without promoting legacy links', () => {
  assert.match(detailPanelSource, /source\.kind === 'official'/);
  assert.match(detailPanelSource, /source\.kind !== 'official'/);
  assert.match(
    detailPanelSource,
    /\{#each discoverySources as source\}[\s\S]*?<a[\s\S]*?rel="noopener noreferrer"/,
  );
  assert.match(detailPanelSource, /officialSources\[0\]/);
  assert.match(detailPanelSource, /暂无已核验官方来源/);
});

test('preserves drawer accessibility and constrains long responsive content', () => {
  assert.match(detailPanelSource, /role="dialog"/);
  assert.match(detailPanelSource, /aria-modal="true"/);
  assert.match(detailPanelSource, /w-full sm:w-\[460px\]/);
  assert.match(detailPanelSource, /from 'lucide-svelte'/);
  assert.match(appCssSource, /overflow-wrap:\s*anywhere/);
  assert.match(appCssSource, /letter-spacing:\s*normal/);
  assert.match(appCssSource, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});
