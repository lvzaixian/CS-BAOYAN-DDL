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

test('renders compact project identity and icon-plus-text mode badges for public rows', () => {
  const markup = schoolRowSource.slice(schoolRowSource.indexOf('</script>'));

  assert.match(
    schoolRowSource,
    /const statusLabel = \$derived\(opportunityStatusLabel\(school\)\)/,
  );
  assert.match(markup, /\{statusLabel\}/);
  assert.doesNotMatch(schoolRowSource, /verificationLabel/);
  assert.match(markup, /\{#each displayTags as t\}/);
  assert.doesNotMatch(schoolRowSource, /t === '(已开营|已结营)'/);
  assert.doesNotMatch(markup, />\s*(已开营|已结营)\s*</);
  assert.match(markup, /\{school\.project\}/);
  assert.match(markup, /\{school\.eventType\}/);
  assert.match(markup, /\{modeLabel\}/);
  assert.match(schoolRowSource, /Monitor/);
  assert.match(schoolRowSource, /MapPin/);
  assert.match(schoolRowSource, /GitMerge/);
  assert.match(schoolRowSource, /CircleHelp/);
});

test('uses six unframed detail sections in the required order', () => {
  const bodyStart = detailPanelSource.indexOf('<!-- body -->');
  const footerStart = detailPanelSource.indexOf('<!-- footer cta -->');
  const body = detailPanelSource.slice(bodyStart, footerStart);
  const headings = ['截止信息', '活动安排', '食宿与交通', '推荐信', '材料', '信息来源'];
  let previous = -1;

  for (const heading of headings) {
    const position = body.indexOf(heading);
    assert.ok(position > previous, `${heading} is missing or out of order`);
    previous = position;
  }

  assert.equal(body.match(/<section\b/g)?.length, 6);
  assert.doesNotMatch(body, /surface-[23]|rounded-(?:lg|xl)/);
});

test('shows deadline and application facts with legacy-safe fallbacks', () => {
  assert.match(detailPanelSource, /school\.deadlineOriginal/);
  assert.match(detailPanelSource, /school\.deadlineMs === null\s*\?\s*'未公布'/);
  assert.match(
    detailPanelSource,
    /const deadlineStatus = \$derived\(expiredDeadlineText\(school\)\)/,
  );
  assert.match(detailPanelSource, /verifiedAtMs === null\s*\?\s*'未记录'/);
  assert.match(detailPanelSource, /eventModeLabel\(school\.eventArrangement\.mode\)/);
  assert.match(detailPanelSource, /school\.eventArrangement\.time\.summary/);
  assert.match(detailPanelSource, /factStatusLabels\[school\.eventArrangement\.time\.status\]/);
  assert.match(detailPanelSource, /school\.eventArrangement\.formatLocation\.summary/);
  assert.match(detailPanelSource, /factStatusLabels\[school\.eventArrangement\.formatLocation\.status\]/);
  assert.match(detailPanelSource, /school\.logistics\.summary/);
  assert.match(detailPanelSource, /factStatusLabels\[school\.logistics\.status\]/);
  assert.match(detailPanelSource, /school\.recommendation\.summary/);
  assert.match(detailPanelSource, /school\.materials\.summary/);
});

test('shows a precise normalized deadline only when the official text includes hour and minute', () => {
  const declaration = detailPanelSource.match(
    /const explicitDeadlineTimePattern = (\/[^\n]+\/);/,
  );
  assert.ok(declaration, 'missing explicit deadline time pattern');
  const pattern = new RegExp(declaration[1].slice(1, -1));

  for (const text of [
    '2026年8月12日23:59前完成报名',
    '2026年8月12日23：59前完成报名',
    '2026年8月12日18点30分截止',
    '2026年8月12日18时30分截止',
  ]) {
    assert.equal(pattern.test(text), true, `expected explicit time in: ${text}`);
  }
  for (const text of [
    '2026年8月12日截止',
    '2026年8月12日截止；官方未公布具体时刻',
    '2026年8月12日18点截止',
    '2026年8月12日29:99截止',
  ]) {
    assert.equal(pattern.test(text), false, `expected date-only deadline in: ${text}`);
  }

  assert.match(
    detailPanelSource,
    /explicitDeadlineTimePattern\.test\(school\.deadlineOriginal\)/,
  );
  assert.match(
    detailPanelSource,
    /deadlineHasExplicitTime\s*\?\s*formatDateTime\(school\.deadlineMs\)/,
  );
  assert.match(detailPanelSource, /按当日末排序（官方未公布具体时刻）/);
  assert.doesNotMatch(
    detailPanelSource,
    /school\.deadlineOriginal\.includes\('官方未公布具体时刻'\)/,
  );
});

test('shows project and event type in the detail header and keeps the official CTA honest', () => {
  const footer = detailPanelSource.slice(detailPanelSource.indexOf('<!-- footer cta -->'));

  assert.match(detailPanelSource, /\{school\.project\}/);
  assert.match(detailPanelSource, /\{school\.eventType\}/);
  assert.match(footer, />\s*查看官方通知\s*</);
  assert.doesNotMatch(footer, /立即报名/);
});

test('labels province as the school location in list and detail views', () => {
  assert.match(schoolRowSource, />· 院校所在地：\{province\}</);
  assert.match(detailPanelSource, />院校所在地：\{province\}</);
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
