import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { PNG } from 'pngjs';

const FIXED_NOW = Date.parse('2026-07-16T12:00:00+08:00');
const KEYS = {
  redwood: '2028|红杉大学|人工智能学院|夏令营',
  orange: '2028|橙川大学|计算机科学学院|科研训练营',
  silver: '2028|银湖大学|数据科学学院|夏令营',
  pine: '2028|松岭大学|电子信息学院|开放日',
  cloud: '2028|云海大学|智能系统研究院|暑期学校',
  bluebay: '2028|蓝湾大学|计算机学院|预推免',
  greenfield: '2028|青禾大学|软件学院|开放日',
  farmountain: '2028|远山大学|网络空间安全学院|夏令营',
} as const;
const EXPECTED_KEYS = [
  KEYS.redwood,
  KEYS.orange,
  KEYS.silver,
  KEYS.pine,
  KEYS.cloud,
  KEYS.bluebay,
  KEYS.greenfield,
  KEYS.farmountain,
];
const CROWDED_DAY_ITEMS = [
  { name: '红杉大学', project: '2026年优秀大学生夏令营' },
  { name: '橙川大学', project: '2026年量子智算训练计划' },
  { name: '银湖大学', project: '2026年数据智能夏令营' },
  { name: '松岭大学', project: '2026年电子信息开放日' },
  { name: '云海大学', project: '2026年智能系统暑期学校' },
] as const;

async function openFixture(page: Page): Promise<void> {
  await page.addInitScript((now) => {
    Date.now = () => now;
  }, FIXED_NOW);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.goto('/');
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }',
  });
  await expect(page.locator('[data-row-key]')).toHaveCount(8);
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth, `${label}: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(
    dimensions.clientWidth,
  );
}

async function expectContentFits(locator: Locator, label: string): Promise<void> {
  const dimensions = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(dimensions.scrollWidth, `${label}: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
  expect(dimensions.left, `${label}: ${JSON.stringify(dimensions)}`).toBeGreaterThanOrEqual(-1);
  expect(dimensions.right, `${label}: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(
    dimensions.viewportWidth + 1,
  );
}

async function expectWcagAaContrast(locator: Locator, label: string): Promise<void> {
  const ratio = await locator.evaluate((element) => {
    const rgba = (value: string): [number, number, number, number] => {
      const values = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1];
    };
    const foreground = rgba(getComputedStyle(element).color);
    let background: [number, number, number, number] = [255, 255, 255, 1];
    let current: Element | null = element;
    while (current) {
      const candidate = rgba(getComputedStyle(current).backgroundColor);
      if (candidate[3] > 0) {
        background = candidate;
        break;
      }
      current = current.parentElement;
    }
    const luminance = ([red, green, blue]: [number, number, number, number]) => {
      const channels = [red, green, blue].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return (
      (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
    );
  });
  expect(ratio, `${label}: contrast ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
}

async function expectRowKeys(page: Page, expected: readonly string[]): Promise<void> {
  await expect
    .poll(() =>
      page.locator('[data-row-key]').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-row-key')),
      ),
    )
    .toEqual(expected);
}

async function filterPanel(page: Page, projectName: string): Promise<Locator> {
  if (projectName === 'desktop') {
    return page.locator('aside').getByLabel('筛选条件');
  }
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '筛选条件' });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function closeMobileFilterPanel(page: Page, projectName: string): Promise<void> {
  if (projectName === 'desktop') return;
  await page.getByRole('button', { name: '查看结果' }).click();
  await expect(page.getByRole('dialog', { name: '筛选条件' })).toBeHidden();
}

function assertNonBlankPng(buffer: Buffer, minimumWidth: number, minimumHeight: number): void {
  const png = PNG.sync.read(buffer);
  expect(png.width).toBeGreaterThanOrEqual(minimumWidth);
  expect(png.height).toBeGreaterThanOrEqual(minimumHeight);

  const colors = new Set<number>();
  let minimumLuminance = 255;
  let maximumLuminance = 0;
  let opaquePixels = 0;
  const stride = Math.max(1, Math.floor((png.width * png.height) / 20_000));
  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    const red = png.data[offset];
    const green = png.data[offset + 1];
    const blue = png.data[offset + 2];
    const alpha = png.data[offset + 3];
    if (alpha === 0) continue;
    opaquePixels += 1;
    colors.add((red << 16) | (green << 8) | blue);
    const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    minimumLuminance = Math.min(minimumLuminance, luminance);
    maximumLuminance = Math.max(maximumLuminance, luminance);
  }
  expect(opaquePixels).toBeGreaterThan(100);
  expect(colors.size).toBeGreaterThan(12);
  expect(maximumLuminance - minimumLuminance).toBeGreaterThan(24);
}

async function captureReviewed(
  locator: Locator,
  testInfo: TestInfo,
  name: string,
  minimumWidth: number,
  minimumHeight: number,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  const buffer = await locator.screenshot({ path, animations: 'disabled' });
  assertNonBlankPng(buffer, minimumWidth, minimumHeight);
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

test('uses the fixture and renders exact ordered groups and active deadlines', async ({ page }) => {
  const groups = await page.locator('[data-row-group]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      group: node.getAttribute('data-row-group'),
      rows: node.querySelectorAll('[data-row-key]').length,
    })),
  );
  expect(groups).toEqual([
    { group: 'active-timed', rows: 6 },
    { group: 'active-unknown', rows: 1 },
    { group: 'expired', rows: 1 },
  ]);

  const rows = page.locator('[data-row-key]');
  expect(await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-row-key'))))
    .toEqual(EXPECTED_KEYS);

  const activeDeadlines = await page
    .locator('[data-row-group="active-timed"] [data-row-key]')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-deadline-ms'))));
  expect(activeDeadlines).toEqual([
    1784368800000,
    1784372400000,
    1784376000000,
    1784379600000,
    1784390399000,
    1785513540000,
  ]);
  expect(activeDeadlines).toEqual([...activeDeadlines].sort((a, b) => a - b));
  await expect(
    page.locator('[data-row-group="active-unknown"] [data-row-key]'),
  ).not.toHaveAttribute('data-deadline-ms', /.+/);

  for (const [key, label] of [
    [KEYS.redwood, '线上'],
    [KEYS.orange, '线下'],
    [KEYS.silver, '混合'],
    [KEYS.pine, '未核验'],
  ] as const) {
    const badge = page.locator(`[data-row-key="${key}"]`).getByLabel(`活动形式：${label}`);
    await expect(badge).toContainText(label);
    await expect(badge.locator('svg')).toHaveCount(1);
  }
});

test('opens deterministic details with ordered facts and the official website CTA', async ({ page }) => {
  await page.getByRole('button', { name: '查看项目详情：红杉大学 人工智能学院' }).click();
  const dialog = page.getByRole('dialog', { name: '项目详情' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText([
    '截止与日期',
    '活动安排',
    '食宿与交通',
    '推荐信',
    '材料',
  ]);
  await expect(dialog.getByText('报名截止', { exact: true })).toBeVisible();
  await expect(dialog.getByText('活动日期', { exact: true })).toBeVisible();
  await expect(dialog.getByText('线上', { exact: true })).toBeVisible();
  await expect(dialog.getByText('2026年8月3日至8月5日')).toBeVisible();
  await expect(dialog.getByText('腾讯会议，链接另行通知')).toBeVisible();
  await expect(dialog.getByText(/2026年8月3日至8月5日\s*· 已核验/)).toBeVisible();
  await expect(dialog.getByText(/腾讯会议，链接另行通知\s*· 已核验/)).toBeVisible();
  const officialCta = dialog
    .locator('.detail-panel__footer')
    .getByRole('link', { name: '打开红杉大学官网' });
  await expect(officialCta).toContainText('打开官网');
  await expect(officialCta).toHaveAttribute(
    'href',
    'https://admissions.redwood.example.test/2026/summer-camp',
  );

  await expect(dialog.getByText('本站信息仅供参考', { exact: false })).toBeVisible();
  await expect(dialog.getByText('信息来源', { exact: true })).toHaveCount(0);
});

test('shows date-only source precision without presenting the normalized cutoff as official', async ({ page }) => {
  await page
    .getByRole('button', { name: '查看项目详情：云海大学 智能系统研究院 2026年智能系统暑期学校' })
    .click();
  const dialog = page.getByRole('dialog', { name: '项目详情' });
  await expect(
    dialog.getByText('2026年7月18日截止；官方未公布具体时刻', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText('2026 年 7月 18 日 · 按当日末排序（官方未公布具体时刻）', { exact: true }),
  ).toHaveCount(0);
});

test('keeps desktop sidebar and mobile panels within their viewport', async ({ page }, testInfo) => {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const sidebar = page.locator('aside');
  const drawerTrigger = page.getByRole('button', { name: '筛选', exact: true });

  if (testInfo.project.name === 'desktop') {
    await expect(sidebar).toBeVisible();
    await expect(drawerTrigger).toBeHidden();
  } else {
    await expect(sidebar).toBeHidden();
    await expect(drawerTrigger).toBeVisible();
    await drawerTrigger.click();
    const drawer = page.getByRole('dialog', { name: '筛选条件' });
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.width)).toBe(viewport!.width);
    expect(Math.round(box!.x)).toBe(0);
    expect(Math.round(box!.y + box!.height)).toBe(viewport!.height);
    expect(box!.height).toBeLessThanOrEqual(viewport!.height * 0.85 + 1);
    await page.keyboard.press('Escape');
    const sourceSelect = page.getByLabel('数据源');
    const sourceBox = await sourceSelect.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(sourceBox!.width).toBeGreaterThanOrEqual(104);
  }

  await page.getByRole('button', { name: '查看项目详情：红杉大学 人工智能学院' }).click();
  const detail = page.locator('.detail-panel');
  await expect(detail).toBeVisible();
  await expect
    .poll(async () => {
      const box = await detail.boundingBox();
      return box && Math.round(box.x + box.width);
    })
    .toBe(viewport!.width);
  const detailBox = await detail.boundingBox();
  expect(detailBox).not.toBeNull();
  expect(Math.round(detailBox!.width)).toBe(testInfo.project.name === 'desktop' ? 460 : viewport!.width);
  expect(Math.round(detailBox!.height)).toBe(viewport!.height);
});

test('search matches project names and activity types', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: '搜索学校、学院、项目和活动类型' });

  await search.fill('量子智算');
  await expectRowKeys(page, [KEYS.orange]);
  await search.fill('科研训练营');
  await expectRowKeys(page, [KEYS.orange]);
});

test('event mode filters use OR semantics and clear completely', async ({ page }, testInfo) => {
  let panel = await filterPanel(page, testInfo.project.name);
  const online = panel.getByRole('button', { name: '筛选形式：线上' });
  await online.click();
  await expect(online).toHaveAttribute('aria-pressed', 'true');
  await closeMobileFilterPanel(page, testInfo.project.name);
  await expectRowKeys(page, [KEYS.redwood, KEYS.cloud]);
  const onlineChip = page.getByRole('button', { name: '线上', exact: true });
  await expect(onlineChip).toBeVisible();
  await onlineChip.click();
  await expect(onlineChip).toHaveCount(0);
  await expectRowKeys(page, EXPECTED_KEYS);
  await expect.poll(() => new URL(page.url()).searchParams.get('modes')).toBeNull();

  panel = await filterPanel(page, testInfo.project.name);
  await panel.getByRole('button', { name: '筛选形式：线上' }).click();
  const hybrid = panel.getByRole('button', { name: '筛选形式：混合' });
  await hybrid.click();
  await expect(hybrid).toHaveAttribute('aria-pressed', 'true');
  await closeMobileFilterPanel(page, testInfo.project.name);
  await expectRowKeys(page, [KEYS.redwood, KEYS.silver, KEYS.cloud]);
  await expect.poll(() => new URL(page.url()).searchParams.get('modes')).toBe('online,hybrid');

  await page.getByRole('button', { name: '清空全部' }).click();
  await expectRowKeys(page, EXPECTED_KEYS);
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('browser back and forward restore mode and status filter history', async ({ page }, testInfo) => {
  let panel = await filterPanel(page, testInfo.project.name);
  await panel.getByRole('button', { name: '筛选形式：线上' }).click();
  await closeMobileFilterPanel(page, testInfo.project.name);
  await expect.poll(() => new URL(page.url()).searchParams.get('modes')).toBe('online');

  panel = await filterPanel(page, testInfo.project.name);
  await panel.getByRole('button', { name: '筛选状态：开放' }).click();
  await closeMobileFilterPanel(page, testInfo.project.name);
  await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('开放');

  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('modes')).toBe('online');
  await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBeNull();
  await expect(page.getByRole('button', { name: '线上', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开放', exact: true })).toHaveCount(0);
  await expectRowKeys(page, [KEYS.redwood, KEYS.cloud]);

  await page.goBack();
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await expect(page.locator('.filter-chip')).toHaveCount(0);
  await expectRowKeys(page, EXPECTED_KEYS);

  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('modes')).toBe('online');
  await expect(page.getByRole('button', { name: '线上', exact: true })).toBeVisible();
  await expectRowKeys(page, [KEYS.redwood, KEYS.cloud]);

  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('开放');
  await expect(page.getByRole('button', { name: '开放', exact: true })).toBeVisible();
  await expectRowKeys(page, [KEYS.redwood, KEYS.cloud]);
});

test('search typing replaces history while every discrete filter pushes', async ({ page }, testInfo) => {
  const search = page.getByRole('searchbox', { name: '搜索学校、学院、项目和活动类型' });
  let expectedHistoryLength = await page.evaluate(() => window.history.length);
  const expectHistoryLength = async () => {
    await expect.poll(() => page.evaluate(() => window.history.length)).toBe(expectedHistoryLength);
  };

  await search.pressSequentially('大学', { delay: 50 });
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('大学');
  await expectHistoryLength();

  let panel = await filterPanel(page, testInfo.project.name);
  await panel.getByRole('button', { name: '筛选档次：C9' }).click();
  await closeMobileFilterPanel(page, testInfo.project.name);
  expectedHistoryLength += 1;
  await expect.poll(() => new URL(page.url()).searchParams.get('tags')).toBe('C9');
  await expectHistoryLength();

  panel = await filterPanel(page, testInfo.project.name);
  await panel.getByRole('button', { name: '筛选形式：线上' }).click();
  await closeMobileFilterPanel(page, testInfo.project.name);
  expectedHistoryLength += 1;
  await expect.poll(() => new URL(page.url()).searchParams.get('modes')).toBe('online');
  await expectHistoryLength();

  panel = await filterPanel(page, testInfo.project.name);
  await panel.getByRole('button', { name: '筛选状态：开放' }).click();
  await closeMobileFilterPanel(page, testInfo.project.name);
  expectedHistoryLength += 1;
  await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('开放');
  await expectHistoryLength();

  panel = await filterPanel(page, testInfo.project.name);
  await panel.getByRole('button', { name: '筛选院校所在地：北京' }).click();
  await closeMobileFilterPanel(page, testInfo.project.name);
  expectedHistoryLength += 1;
  await expect.poll(() => new URL(page.url()).searchParams.get('prov')).toBe('北京');
  await expectHistoryLength();

  await search.focus();
  await search.press('End');
  await search.pressSequentially('院', { delay: 50 });
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('大学院');
  await expectHistoryLength();

  await page.getByLabel('数据源').selectOption('e2e-no-tier');
  expectedHistoryLength += 1;
  await expect.poll(() => new URL(page.url()).searchParams.get('src')).toBe('e2e-no-tier');
  await expectHistoryLength();

  await page.getByRole('button', { name: '截止日历视图' }).click();
  expectedHistoryLength += 1;
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('calendar');
  await expectHistoryLength();
});

test('restores URL filters, migrates legacy status values and clears them', async ({ page }, testInfo) => {
  const historyLengthBeforeNavigation = await page.evaluate(() => window.history.length);
  await page.goto(
    '/?q=%E5%A4%A7%E5%AD%A6&tags=985&status=%E5%B7%B2%E5%BC%80%E8%90%A5,%E5%B7%B2%E7%BB%93%E8%90%A5&modes=online,hybrid&prov=%E5%8C%97%E4%BA%AC,%E4%B8%8A%E6%B5%B7',
  );
  const search = page.getByRole('searchbox', { name: '搜索学校、学院、项目和活动类型' });
  await expect(search).toHaveValue('大学');
  await expectRowKeys(page, [KEYS.redwood, KEYS.silver]);
  await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('开放,已结束');
  await expect.poll(() => page.evaluate(() => window.history.length)).toBe(
    historyLengthBeforeNavigation + 1,
  );

  let panel = await filterPanel(page, testInfo.project.name);
  await expect(panel.getByRole('button', { name: '筛选状态：开放' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(panel.getByRole('button', { name: '筛选状态：已结束' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(panel.getByRole('button', { name: '筛选形式：线上' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(panel.getByRole('button', { name: '筛选形式：混合' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await closeMobileFilterPanel(page, testInfo.project.name);

  await page.reload();
  await expect(search).toHaveValue('大学');
  await expectRowKeys(page, [KEYS.redwood, KEYS.silver]);
  await page.getByRole('button', { name: '清空全部' }).click();
  await expectRowKeys(page, EXPECTED_KEYS);
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('hides the tier hierarchy when every tier count is zero', async ({ page }, testInfo) => {
  await page.getByLabel('数据源').selectOption('e2e-no-tier');
  await expect(page.locator('[data-row-key]')).toHaveCount(1);

  const panel = await filterPanel(page, testInfo.project.name);
  await expect(panel.getByRole('heading', { name: '档次' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^筛选档次：/ })).toHaveCount(0);
});

test('view switch is a pressed-state segmented control instead of incomplete tabs', async ({ page }) => {
  const switcher = page.getByRole('group', { name: '视图切换' });
  const list = switcher.getByRole('button', { name: '列表视图' });
  const calendar = switcher.getByRole('button', { name: '截止日历视图' });

  await expect(switcher.getByRole('tab')).toHaveCount(0);
  await expect(list).toHaveAttribute('aria-pressed', 'true');
  await expect(calendar).toHaveAttribute('aria-pressed', 'false');
  await calendar.click();
  await expect(list).toHaveAttribute('aria-pressed', 'false');
  await expect(calendar).toHaveAttribute('aria-pressed', 'true');
});

test('deadline calendar opens every crowded-day item and clears expansion on month and data changes', async ({ page }) => {
  await page.getByRole('button', { name: '截止日历视图' }).click();
  const calendar = page.getByRole('region', { name: '截止日历' });
  await expect(calendar).toBeVisible();
  await expectNoHorizontalOverflow(page, 'deadline calendar');

  const more = calendar.getByRole('button', {
    name: /^(展开|收起) 2026年7月18日全部 5 个截止项目$/,
  });
  await expect(more).toHaveText('+2');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toHaveAttribute('aria-controls', 'deadline-calendar-day-2026-07-18');
  const hitTarget = await more.boundingBox();
  expect(hitTarget).not.toBeNull();
  expect(hitTarget!.width).toBeGreaterThanOrEqual(24);
  expect(hitTarget!.height).toBeGreaterThanOrEqual(24);

  const redwoodPreview = calendar.locator(
    '[data-calendar-preview][aria-label="查看 2026年7月18日截止项目详情：红杉大学 人工智能学院 2026年优秀大学生夏令营"]',
  );
  await expect(redwoodPreview).toHaveAttribute(
    'aria-label',
    '查看 2026年7月18日截止项目详情：红杉大学 人工智能学院 2026年优秀大学生夏令营',
  );
  await expect(redwoodPreview).toHaveAttribute('aria-haspopup', 'dialog');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveAttribute('aria-expanded', 'true');

  const expanded = page.locator('#deadline-calendar-day-2026-07-18');
  await expect(expanded).toBeVisible();
  const expandedItems = expanded.getByRole('button', { name: /^查看截止项目详情：/ });
  await expect(expandedItems).toHaveCount(5);
  await expect(expandedItems.first()).toBeFocused();
  for (const [index, item] of CROWDED_DAY_ITEMS.entries()) {
    await expect(expandedItems.nth(index)).toContainText(item.name);
    await expect(expandedItems.nth(index)).toContainText(item.project);
  }
  await expectNoHorizontalOverflow(page, 'expanded deadline calendar');

  const detail = page.getByRole('dialog', { name: '项目详情' });
  for (const [index, item] of CROWDED_DAY_ITEMS.entries()) {
    await expandedItems.nth(index).click();
    await expect(detail).toContainText(item.name);
    await expect(detail).toContainText(item.project);
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await expect(expandedItems.nth(index)).toBeFocused();
  }

  await calendar.getByRole('button', { name: '下个月' }).click();
  await expect(calendar.getByText('2026 年 8 月')).toBeVisible();
  await expect(expanded).toHaveCount(0);
  await calendar.getByRole('button', { name: '上个月' }).click();
  await expect(calendar.getByText('2026 年 7 月')).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(expanded).toBeVisible();
  await page.getByLabel('数据源').selectOption('e2e-no-tier');
  await expect(expanded).toHaveCount(0);
});

test('mobile calendar uses readable day disclosures instead of clipped school previews', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop');
  await page.getByRole('button', { name: '截止日历视图' }).click();
  const calendar = page.getByRole('region', { name: '截止日历' });
  const preview = calendar.locator('[data-calendar-preview]').first();
  await expect(preview).toBeHidden();

  const disclosure = calendar.getByRole('button', {
    name: '展开 2026年7月18日全部 5 个截止项目',
  });
  await expect(disclosure).toHaveText('+2');
  const box = await disclosure.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);
  await expectContentFits(disclosure, `${testInfo.project.name} calendar disclosure`);
});

test('row and detail dialogs support keyboard entry, trap, escape and focus restore', async ({ page }) => {
  const row = page.getByRole('button', { name: '查看项目详情：红杉大学 人工智能学院' });
  await row.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '项目详情' });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: '关闭项目详情' });
  await expect(close).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(row).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('link').last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(row).toBeFocused();
});

test('global shortcuts navigate rows and the help dialog isolates and restores focus', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: '搜索学校、学院、项目和活动类型' });
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).not.toBeFocused();

  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  const detail = page.getByRole('dialog', { name: '项目详情' });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('橙川大学');

  const detailClose = detail.getByRole('button', { name: '关闭项目详情' });
  await expect(detailClose).toBeFocused();
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: '键盘快捷键' });
  const helpClose = help.getByRole('button', { name: '关闭键盘快捷键', exact: true });
  await expect(help).toBeVisible();
  await expect(helpClose).toBeFocused();
  await expect(page.locator('[data-layer="detail"]')).toHaveAttribute('inert', '');

  await page.keyboard.press('Shift+Tab');
  await expect(helpClose).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(helpClose).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(detail).toBeVisible();
  await expect(detailClose).toBeFocused();
  await page.keyboard.press('Escape');

  await page.keyboard.press('k');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '项目详情' })).toContainText('红杉大学');
  await page.keyboard.press('Escape');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '项目详情' })).toContainText('红杉大学');
});

test('mobile filter dialog traps focus, escapes and restores its trigger', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop');
  const trigger = page.getByRole('button', { name: '筛选', exact: true });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const drawer = page.getByRole('dialog', { name: '筛选条件' });
  const c9 = drawer.getByRole('button', { name: '筛选档次：C9' });
  await expect(c9).toBeFocused();

  await c9.press('Enter');
  await expect(c9).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: '项目详情' })).toHaveCount(0);

  const focusable = drawer.locator(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const first = focusable.first();
  const last = focusable.last();
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('list, chips, drawer and long detail facts never overflow horizontally', async ({ page }, testInfo) => {
  await expectNoHorizontalOverflow(page, 'list');
  const longQuery = `NO_MATCH_${'UNBROKEN'.repeat(35)}`;
  await page
    .getByRole('searchbox', { name: '搜索学校、学院、项目和活动类型' })
    .fill(longQuery);
  const searchChip = page.getByRole('button', { name: /搜索:/ });
  await expect(searchChip).toBeVisible();
  await expect(page.locator('[data-row-key]')).toHaveCount(0);
  await expect(page.getByText('没有匹配的项目')).toBeVisible();
  await expectNoHorizontalOverflow(page, 'long active-filter chip');
  await expectContentFits(searchChip, 'long active-filter chip content');
  await page.getByRole('button', { name: '清空全部' }).click();

  if (testInfo.project.name !== 'desktop') {
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expectNoHorizontalOverflow(page, 'mobile filter drawer');
    await page.keyboard.press('Escape');
  }

  await page.getByRole('button', { name: '查看项目详情：红杉大学 人工智能学院' }).click();
  const longFact = page.getByText(/LONG_UNBROKEN_FACT_/);
  await expect(longFact).toBeVisible();
  await expectNoHorizontalOverflow(page, 'long detail fact');
  await expectContentFits(longFact, 'long detail fact content');
});

test('has no serious or critical axe violations in list and open panels', async ({ page }, testInfo) => {
  const assertAxe = async (state: string) => {
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(blocking, `${state}: ${JSON.stringify(blocking, null, 2)}`).toEqual([]);
  };

  await assertAxe('list');
  if (testInfo.project.name !== 'desktop') {
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await assertAxe('filter drawer');
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: '查看项目详情：红杉大学 人工智能学院' }).click();
  await assertAxe('detail dialog');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeVisible();
  await assertAxe('keyboard help dialog');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '截止日历视图' }).click();
  const lightCalendar = page.getByRole('region', { name: '截止日历' });
  await lightCalendar
    .getByRole('button', { name: '展开 2026年7月18日全部 5 个截止项目' })
    .click();
  await assertAxe('light expanded deadline calendar');
  await expectWcagAaContrast(
    lightCalendar.locator('[data-calendar-date]').first(),
    'light calendar date',
  );
  await expectWcagAaContrast(
    lightCalendar.locator('[data-calendar-day-trigger]').first(),
    'light calendar day trigger',
  );
  await expectWcagAaContrast(
    lightCalendar.locator('[data-calendar-expanded-count]'),
    'light calendar expanded count',
  );
  await page.getByRole('button', { name: '切换主题' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await assertAxe('dark expanded deadline calendar');
});

test('emits reviewed nonblank list, panel and expanded-calendar screenshots', async ({ page }, testInfo) => {
  const isDesktop = testInfo.project.name === 'desktop';
  await captureReviewed(
    page.locator('main'),
    testInfo,
    `${testInfo.project.name}-list`,
    isDesktop ? 800 : testInfo.project.name === 'narrow-mobile' ? 280 : 300,
    250,
  );

  if (!isDesktop) {
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await captureReviewed(
      page.getByRole('dialog', { name: '筛选条件' }),
      testInfo,
      'mobile-drawer',
      testInfo.project.name === 'narrow-mobile' ? 300 : 380,
      300,
    );
    await page.keyboard.press('Escape');
  }

  await page.getByRole('button', { name: '查看项目详情：红杉大学 人工智能学院' }).click();
  await captureReviewed(
    page.locator('.detail-panel'),
    testInfo,
    `${testInfo.project.name}-detail`,
    isDesktop ? 450 : testInfo.project.name === 'narrow-mobile' ? 300 : 380,
    600,
  );
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '截止日历视图' }).click();
  const calendar = page.getByRole('region', { name: '截止日历' });
  await calendar
    .getByRole('button', { name: '展开 2026年7月18日全部 5 个截止项目' })
    .click();
  await captureReviewed(
    page.locator('main'),
    testInfo,
    `${testInfo.project.name}-calendar-expanded`,
    isDesktop ? 800 : testInfo.project.name === 'narrow-mobile' ? 280 : 300,
    700,
  );
});
