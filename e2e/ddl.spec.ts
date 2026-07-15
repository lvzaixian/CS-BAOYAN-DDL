import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { PNG } from 'pngjs';

const FIXED_NOW = Date.parse('2026-07-16T12:00:00+08:00');
const EXPECTED_KEYS = [
  '2028|红杉大学|人工智能学院|夏令营',
  '2028|蓝湾大学|计算机学院|预推免',
  '2028|青禾大学|软件学院|开放日',
  '2028|远山大学|网络空间安全学院|夏令营',
];

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
  await expect(page.locator('[data-row-key]')).toHaveCount(4);
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
    { group: 'active-timed', rows: 2 },
    { group: 'active-unknown', rows: 1 },
    { group: 'expired', rows: 1 },
  ]);

  const rows = page.locator('[data-row-key]');
  expect(await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-row-key'))))
    .toEqual(EXPECTED_KEYS);

  const activeDeadlines = await page
    .locator('[data-row-group="active-timed"] [data-row-key]')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-deadline-ms'))));
  expect(activeDeadlines).toEqual([1784368800000, 1785513540000]);
  expect(activeDeadlines).toEqual([...activeDeadlines].sort((a, b) => a - b));
  await expect(
    page.locator('[data-row-group="active-unknown"] [data-row-key]'),
  ).not.toHaveAttribute('data-deadline-ms', /.+/);
});

test('opens deterministic details with ordered facts and exact source links', async ({ page }) => {
  await page.getByRole('button', { name: '查看项目详情：红杉大学 人工智能学院' }).click();
  const dialog = page.getByRole('dialog', { name: '项目详情' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText([
    '截止信息',
    '食宿与交通',
    '推荐信',
    '材料',
    '信息来源',
  ]);

  const sourceSection = dialog.locator('section').last();
  const sourceLinks = sourceSection.getByRole('link');
  await expect(sourceLinks).toHaveCount(2);
  const official = sourceLinks.nth(0);
  const discovery = sourceLinks.nth(1);
  await expect(official).toHaveAttribute(
    'href',
    'https://admissions.redwood.example.test/2026/summer-camp',
  );
  await expect(official).toHaveAttribute('target', '_blank');
  await expect(official).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(discovery).toHaveAttribute(
    'href',
    'https://discovery.example.test/redwood-summer-camp',
  );
  expect(
    await official.evaluate((node, other) =>
      Boolean(node.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
    await discovery.elementHandle()),
  ).toBe(true);
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

test('search and OR filters persist in the URL and clear completely', async ({ page }, testInfo) => {
  const search = page.getByRole('searchbox', { name: '搜索学校和学院' });
  await search.fill('红杉');
  await expectRowKeys(page, [EXPECTED_KEYS[0]]);
  await search.fill('大学');
  await expectRowKeys(page, EXPECTED_KEYS);

  let panel = await filterPanel(page, testInfo.project.name);
  const activeStatus = panel.getByRole('button', { name: '筛选状态：已开营' });
  await activeStatus.click();
  await expect(activeStatus).toHaveAttribute('aria-pressed', 'true');
  await closeMobileFilterPanel(page, testInfo.project.name);
  await expectRowKeys(page, EXPECTED_KEYS.slice(0, 3));

  panel = await filterPanel(page, testInfo.project.name);
  const expiredStatus = panel.getByRole('button', { name: '筛选状态：已结营' });
  await expiredStatus.click();
  await expect(expiredStatus).toHaveAttribute('aria-pressed', 'true');
  await closeMobileFilterPanel(page, testInfo.project.name);
  await expectRowKeys(page, EXPECTED_KEYS);

  panel = await filterPanel(page, testInfo.project.name);
  const tier985 = panel.getByRole('button', { name: '筛选档次：985' });
  await tier985.click();
  await expect(tier985).toHaveAttribute('aria-pressed', 'true');
  await closeMobileFilterPanel(page, testInfo.project.name);
  await expectRowKeys(page, [EXPECTED_KEYS[0], EXPECTED_KEYS[2]]);

  panel = await filterPanel(page, testInfo.project.name);
  const tier211 = panel.getByRole('button', { name: '筛选档次：211' });
  await tier211.click();
  await expect(tier211).toHaveAttribute('aria-pressed', 'true');
  await closeMobileFilterPanel(page, testInfo.project.name);
  await expectRowKeys(page, EXPECTED_KEYS.slice(0, 3));

  panel = await filterPanel(page, testInfo.project.name);
  const beijing = panel.getByRole('button', { name: '筛选省份：北京' });
  const shanghai = panel.getByRole('button', { name: '筛选省份：上海' });
  await beijing.click();
  await shanghai.click();
  await expect(beijing).toHaveAttribute('aria-pressed', 'true');
  await expect(shanghai).toHaveAttribute('aria-pressed', 'true');
  await closeMobileFilterPanel(page, testInfo.project.name);
  await expectRowKeys(page, EXPECTED_KEYS.slice(0, 2));

  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('大学');
  expect(new URL(page.url()).searchParams.get('tags')).toBe('985,211');
  expect(new URL(page.url()).searchParams.get('status')).toBe('已开营,已结营');
  expect(new URL(page.url()).searchParams.get('prov')).toBe('北京,上海');

  await page.reload();
  await expect(search).toHaveValue('大学');
  await expectRowKeys(page, EXPECTED_KEYS.slice(0, 2));
  await page.getByRole('button', { name: '清空全部' }).click();
  await expectRowKeys(page, EXPECTED_KEYS);
  await expect.poll(() => new URL(page.url()).search).toBe('');
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
  const search = page.getByRole('searchbox', { name: '搜索学校和学院' });
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).not.toBeFocused();

  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  const detail = page.getByRole('dialog', { name: '项目详情' });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('蓝湾大学');

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
  await page.getByRole('searchbox', { name: '搜索学校和学院' }).fill(longQuery);
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
  await page.getByRole('button', { name: '切换主题' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await assertAxe('dark list');
});

test('emits reviewed nonblank list and panel screenshots', async ({ page }, testInfo) => {
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
});
