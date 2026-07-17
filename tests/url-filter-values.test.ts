import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStatusList } from '../src/lib/url-filter-values';

test('validates current status values and migrates legacy links', () => {
  assert.deepEqual(parseStatusList('开放,已结束'), ['开放', '已结束']);
  assert.deepEqual(parseStatusList('已开营,已结营'), ['开放', '已结束']);
  assert.deepEqual(parseStatusList('开放,已开营,无效,已结束'), ['开放', '已结束']);
  assert.deepEqual(parseStatusList(null), []);
});
