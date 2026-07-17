import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { deadlineOriginalSupportsNormalizedTime } from '../src/lib/time';

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

test('renders compact two-line project identity and icon-plus-text mode badges', () => {
  const markup = schoolRowSource.slice(schoolRowSource.indexOf('</script>'));

  assert.match(markup, /data-layout="compact-two-line"/);
  assert.doesNotMatch(schoolRowSource, /opportunityStatusLabel|statusLabel/);
  assert.doesNotMatch(schoolRowSource, /Archive|BadgeCheck/);
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

test('uses five unframed detail sections in the required order', () => {
  const bodyStart = detailPanelSource.indexOf('<!-- body -->');
  const footerStart = detailPanelSource.indexOf('<!-- footer cta -->');
  const body = detailPanelSource.slice(bodyStart, footerStart);
  const headings = ['截止与日期', '活动安排', '食宿与交通', '推荐信', '材料'];
  let previous = -1;

  for (const heading of headings) {
    const position = body.indexOf(heading);
    assert.ok(position > previous, `${heading} is missing or out of order`);
    previous = position;
  }

  assert.equal(body.match(/<section\b/g)?.length, 5);
  assert.doesNotMatch(body, /信息来源|discoverySources|detail-source-list/);
  assert.doesNotMatch(body, /surface-[23]|rounded-(?:lg|xl)/);
});

test('shows one official deadline followed immediately by the activity date', () => {
  assert.match(detailPanelSource, /school\.deadlineOriginal/);
  assert.match(detailPanelSource, /const officialDeadline = \$derived/);
  assert.doesNotMatch(detailPanelSource, /原始文本|标准化时间|核验时间/);

  const deadlineLabel = detailPanelSource.indexOf('<dt>报名截止</dt>');
  const activityDateLabel = detailPanelSource.indexOf('<dt>活动日期</dt>');
  const arrangementSection = detailPanelSource.indexOf('id="arrangement-heading"');
  assert.ok(deadlineLabel !== -1, 'missing official deadline');
  assert.ok(activityDateLabel > deadlineLabel, 'activity date must immediately follow deadline');
  assert.ok(arrangementSection > activityDateLabel, 'activity date must precede arrangement section');

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

test('matches only explicit times that support the normalized deadline', () => {
  const at = (day: number, hour: number, minute: number) =>
    new Date(2026, 6, day, hour, minute).getTime();

  for (const [text, deadline] of [
    ['2026年7月28日15:00关闭', at(28, 15, 0)],
    ['2026年7月28日15：00关闭', at(28, 15, 0)],
    ['2026年7月28日18点30分截止', at(28, 18, 30)],
    ['2026年7月28日18时30分截止', at(28, 18, 30)],
    ['2026年7月28日下午5点截止', at(28, 17, 0)],
    ['2026年7月28日20时截止', at(28, 20, 0)],
    ['2026年7月28日中午12点截止', at(28, 12, 0)],
    ['2026年7月28日24:00截止', at(29, 0, 0)],
    ['10:00 开放，7月28日15:00关闭', at(28, 15, 0)],
  ] as const) {
    assert.equal(
      deadlineOriginalSupportsNormalizedTime(text, deadline),
      true,
      `expected normalized time support in: ${text}`,
    );
  }

  for (const [text, deadline] of [
    ['10:00 开放，7月28日截止', at(28, 23, 59)],
    ['2026年7月28日截止', at(28, 23, 59)],
    ['2026年7月28日23:59截止；官方未公布具体时刻', at(28, 23, 59)],
    ['2026年7月28日下午5点截止', at(28, 5, 0)],
    ['2026年7月28日晚上8点截止', at(28, 8, 0)],
    ['2026年7月28日24:01截止', at(29, 0, 1)],
  ] as const) {
    assert.equal(
      deadlineOriginalSupportsNormalizedTime(text, deadline),
      false,
      `expected no normalized time support in: ${text}`,
    );
  }

  assert.equal(deadlineOriginalSupportsNormalizedTime('2026年7月28日15:00关闭', null), false);
});

test('shows project and event type in the detail header and uses the requested official CTA', () => {
  const footer = detailPanelSource.slice(detailPanelSource.indexOf('<!-- footer cta -->'));

  assert.match(detailPanelSource, /\{school\.project\}/);
  assert.match(detailPanelSource, /\{school\.eventType\}/);
  assert.match(footer, />\s*打开官网\s*</);
  assert.match(footer, /本站信息仅供参考/);
  assert.doesNotMatch(footer, /查看官方(?:通知|来源)|立即报名/);
});

test('labels province as the school location in list and detail views', () => {
  assert.match(schoolRowSource, /aria-label="院校所在地：\{province\}"/);
  assert.match(schoolRowSource, />\s*· \{province\}\s*</);
  assert.match(detailPanelSource, />院校所在地：\{province\}</);
});

test('opens details as a dialog trigger instead of a toggle button', () => {
  assert.doesNotMatch(schoolRowSource, /aria-pressed=\{selected\}/);
  assert.match(schoolRowSource, /aria-haspopup="dialog"/);
});

test('keeps a verified official CTA without exposing source inventories', () => {
  assert.match(detailPanelSource, /source\.kind === 'official'/);
  assert.match(detailPanelSource, /officialSources\[0\]/);
  assert.doesNotMatch(detailPanelSource, /source\.kind !== 'official'|const discoverySources/);
  assert.doesNotMatch(detailPanelSource, /暂无已核验官方来源|信息来源/);
});

test('preserves drawer accessibility and constrains long responsive content', () => {
  assert.match(detailPanelSource, /role="dialog"/);
  assert.match(detailPanelSource, /aria-modal="true"/);
  assert.match(detailPanelSource, /w-full sm:w-\[460px\]/);
  assert.match(detailPanelSource, /class="detail-panel__body[^\n]*"[\s\S]*?tabindex="0"/);
  assert.match(detailPanelSource, /aria-label="项目详情内容"/);
  assert.match(detailPanelSource, /from 'lucide-svelte'/);
  assert.match(appCssSource, /overflow-wrap:\s*anywhere/);
  assert.match(appCssSource, /letter-spacing:\s*normal/);
  assert.match(appCssSource, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});
