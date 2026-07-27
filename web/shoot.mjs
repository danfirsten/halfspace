/**
 * Screenshot + performance harness.
 *
 * Drives the *production build* served from dist/, not the dev server: the
 * numbers it prints are the ones quoted in the README, so they have to come
 * from the artifact that actually ships.
 *
 *   npm run build && npx vite preview --port 4173
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node shoot.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const EXE = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/';
const OUT = process.env.OUT ?? '../docs/screenshots';
mkdirSync(OUT, { recursive: true });

const errors = [];
const idle = (page) =>
  page.waitForFunction(() => !document.querySelector('.results-head .spinner'), null, {
    timeout: 30000,
  });
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  shot', name);
};

const browser = await chromium.launch({ executablePath: EXE });
const report = {};

// ---------------------------------------------------------------- desktop ---
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // First meaningful paint: header, preset chips and the skeleton pitches —
  // everything the contract requires on screen before DuckDB-WASM is parsed.
  await page.waitForSelector('.preset');
  await page.waitForSelector('.skeleton-card svg, .card svg');
  report.fmp_ms = Date.now() - t0;
  report.paint = await page.evaluate(() =>
    Object.fromEntries(
      performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]),
    ),
  );

  await page.waitForSelector('.card', { timeout: 90000 });
  report.index_ready_ms = Date.now() - t0;
  await page.waitForTimeout(1400);
  await shot(page, 'landing');
  report.cards = await page.locator('.card').count();

  await page.mouse.wheel(0, 620);
  await page.waitForTimeout(900);
  await shot(page, 'results-grid');

  report.preset_ms = {};
  for (const preset of await page.locator('.preset').all()) {
    const label = await preset.innerText();
    await preset.click();
    await idle(page);
    report.preset_ms[label] = await page.locator('.results-head .num').last().innerText();
  }

  await page.mouse.wheel(0, -2000);
  await page.fill(
    '.search input',
    'quick counterattacks by Spain that reached the box against Germany',
  );
  await page.click('.search button');
  await idle(page);
  await page.waitForTimeout(700);
  await shot(page, 'natural-language');
  report.nl_note = (await page.locator('.note-box').first().innerText()).replace(/\s+/g, ' ');

  await page.click('.ghost-btn');
  await page.waitForSelector('.builder');
  await page.waitForTimeout(500);
  await shot(page, 'filter-builder');
  await page.click('.ghost-btn');

  await page.click('.preset >> nth=4');
  await idle(page);
  await page.locator('.card').first().click();
  await page.waitForSelector('.player-pitch', { timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.player-pitch circle').length > 4,
    null,
    { timeout: 30000 },
  );
  await page.waitForTimeout(2200);
  await shot(page, 'phase-player');
  report.player_dots = await page.locator('.player-pitch circle').count();
  report.player_360_coverage = await page.locator('.pstat').last().locator('.v').innerText();

  // Cold "find similar": includes the one-time 2.66 MB similarity.parquet fetch.
  await page.click('.player-head-actions .ghost-btn');
  await idle(page);
  report.similar_cold_ms = await page.locator('.results-head .num').last().innerText();
  await page.waitForTimeout(800);
  await shot(page, 'find-similar');
  report.similar_results = await page.locator('.card').count();

  // Warm: this is the query the < 300 ms budget is actually about.
  await page.locator('.card .mini-btn').nth(3).click();
  await idle(page);
  report.similar_warm_ms = await page.locator('.results-head .num').last().innerText();

  // Deep links must survive a cold reload.
  await page.locator('.card').first().click();
  await page.waitForSelector('.player-pitch', { timeout: 30000 });
  report.deep_link = page.url();
  await page.keyboard.press('Escape');
  await page.goto(report.deep_link, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.player-pitch', { timeout: 90000 });
  report.deep_link_reload_ok = true;
  await page.keyboard.press('Escape');

  await page.locator('.insights').scrollIntoViewIfNeeded();
  await page.waitForSelector('.chart-card canvas', { timeout: 30000 });
  await page.waitForTimeout(1600);
  await shot(page, 'insights');
  report.charts = await page.locator('.chart-card canvas').count();

  await page.locator('.footer').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shot(page, 'footer');
  report.statsbomb_logo_loaded = await page.evaluate(() => {
    const img = document.querySelector('.footer-logo img');
    return Boolean(img && img.naturalWidth > 0);
  });

  await ctx.close();
}

// ----------------------------------------------------------------- mobile ---
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`mobile pageerror: ${e.message}`));

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.preset');
  report.mobile_fmp_ms = Date.now() - t0;
  await page.waitForSelector('.card', { timeout: 90000 });
  await page.waitForTimeout(1400);
  await shot(page, 'mobile-landing');
  await page.mouse.wheel(0, 520);
  await page.waitForTimeout(800);
  await shot(page, 'mobile-results');
  await page.locator('.card').first().click();
  await page.waitForSelector('.player-pitch', { timeout: 30000 });
  await page.waitForTimeout(2200);
  await shot(page, 'mobile-player');
  // Nothing may scroll sideways in portrait.
  report.mobile_horizontal_overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  await ctx.close();
}

await browser.close();
report.console_errors = errors.length ? errors : 'none';
console.log(JSON.stringify(report, null, 1));
