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
  assert.match(calendar, /aria-label="截止日历"/);
  assert.match(calendar, /items\.slice\(0, 3\)/);
  assert.match(calendar, /let expandedDayKey = \$state<string \| null>\(null\)/);
  assert.match(calendar, /aria-expanded=\{expandedDayKey === cell\.key\}/);
  assert.match(calendar, /aria-controls=\{dayDetailsId\(cell\.key\)\}/);
  assert.match(calendar, /expandedDayKey = expandedDayKey === key \? null : key/);
  assert.match(calendar, /id=\{dayDetailsId\(expandedDayKey\)\}/);
  assert.match(calendar, /\{#each expandedItems as r \(rowKey\(r\)\)\}/);
  assert.match(calendar, /\{r\.name\}/);
  assert.match(calendar, /\{r\.project\}/);
  assert.match(calendar, /onclick=\{\(\) => onSelect\(rowKey\(r\)\)\}/);
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
    /if \(expandedDayKey !== null && \(byDay\.get\(expandedDayKey\)\?\.length \?\? 0\) <= 3\)/,
  );
});
