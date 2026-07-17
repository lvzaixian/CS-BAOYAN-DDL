import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('deadline calendar exposes a three-item preview and an accessible full-day disclosure', () => {
  const calendar = read('src/components/CalendarView.svelte');
  const header = read('src/components/Header.svelte');

  assert.match(header, /aria-label="截止日历视图"/);
  assert.match(header, />截止日历</);
  assert.match(header, /role="group" aria-label="视图切换"/);
  assert.equal(header.match(/aria-pressed=\{filters\.view === /g)?.length, 2);
  assert.doesNotMatch(header, /role="tab(list)?"/);
  assert.match(calendar, /aria-label="截止日历"/);
  assert.match(calendar, /items\.slice\(0, 3\)/);
  assert.match(calendar, /let expandedDayKey = \$state<string \| null>\(null\)/);
  assert.match(calendar, /aria-expanded=\{expandedDayKey === cell\.key\}/);
  assert.match(calendar, /aria-controls=\{dayDetailsId\(cell\.key\)\}/);
  assert.match(calendar, /expandedDayKey = expandedDayKey === key \? null : key/);
  assert.match(calendar, /id=\{dayDetailsId\(expandedDayKey\)\}/);
  assert.match(calendar, /\{#each expandedItems as r, index \(rowKey\(r\)\)\}/);
  assert.match(calendar, /\{r\.name\}/);
  assert.match(calendar, /\{r\.project\}/);
  assert.match(calendar, /onclick=\{\(\) => onSelect\(rowKey\(r\)\)\}/);
  assert.match(calendar, /data-calendar-day-trigger/);
  assert.match(calendar, /min-w-6 min-h-6/);
  assert.match(calendar, /data-calendar-preview/);
  assert.match(calendar, /aria-haspopup="dialog"/);
  assert.match(
    calendar,
    /aria-label="查看 \{dayLabel\(cell\.key\)\}截止项目详情：\{r\.name\} \{r\.institute\} \{r\.project\}"/,
  );
  assert.match(calendar, /import \{ tick \} from 'svelte'/);
  assert.match(calendar, /await tick\(\)[\s\S]*expandedItemButtons\[0\]\?\.focus\(\)/);
});

test('deadline calendar clears expanded dates when navigation or data invalidates them', () => {
  const calendar = read('src/components/CalendarView.svelte');

  assert.match(calendar, /function clearExpandedDay\(\)/);
  assert.match(calendar, /function prev\(\)[\s\S]*clearExpandedDay\(\)/);
  assert.match(calendar, /function next\(\)[\s\S]*clearExpandedDay\(\)/);
  assert.match(calendar, /function jumpToday\(\)[\s\S]*clearExpandedDay\(\)/);
  assert.match(calendar, /if \(feedId === visibleFeedId\) return;[\s\S]*clearExpandedDay\(\)/);
  assert.match(
    calendar,
    /if \(expandedDayKey !== null && \(groupedRowKeys\.get\(expandedDayKey\)\?\.length \?\? 0\) === 0\)/,
  );
});

test('deadline grouping depends on stable row identity and deadline instead of the 1Hz row objects', () => {
  const calendar = read('src/components/CalendarView.svelte');

  assert.match(calendar, /const groupingSignature = \$derived/);
  assert.match(calendar, /const rowsByKey = \$derived\.by/);
  assert.match(calendar, /const groupedRowKeys = \$derived\.by/);
  assert.match(calendar, /cachedGrouping\.signature === groupingSignature/);
  assert.match(calendar, /key: rowKey\(r\), deadlineMs: r\.deadlineMs/);
  assert.match(calendar, /arr\.sort\(\(a, b\) => a\.deadlineMs - b\.deadlineMs\)/);
  assert.doesNotMatch(calendar, /new Map<string, DerivedSchool\[\]>/);
});

test('light calendar contrast uses the AA foreground token for the three reviewed labels', () => {
  const calendar = read('src/components/CalendarView.svelte');

  assert.match(calendar, /data-calendar-date[\s\S]*text-fg-2/);
  assert.match(calendar, /data-calendar-day-trigger[\s\S]*text-fg-2/);
  assert.match(calendar, /data-calendar-expanded-count[\s\S]*text-fg-2/);
});
