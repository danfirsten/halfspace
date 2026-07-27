/**
 * Capture the phase player animating, frame by frame, for the README hero GIF.
 * Deterministic: playback is paused and the timeline is scrubbed to evenly
 * spaced instants, so every frame is the same distance apart in match time.
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';

const EXE = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/';
const PHASE = process.env.PHASE ?? '3943043-0135';
const OUT = process.env.OUT ?? '/tmp/claude-0/-home-user-halfspace/a694d7b9-aa9e-541f-bd07-c557653c0680/scratchpad/frames';
const N = Number(process.env.N ?? 54);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));

await page.goto(`${BASE}#phase=${PHASE}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.player-pitch', { timeout: 90000 });
await page.waitForFunction(() => !document.querySelector('.player .status-line'), null, { timeout: 90000 });
await page.waitForFunction(() => document.querySelectorAll('.player-pitch circle').length > 8, null, {
  timeout: 60000,
});
await page.waitForTimeout(1500); // let the modal's entry animation settle

// Pause, then scrub.
await page.keyboard.press(' ');
await page.waitForTimeout(200);

const duration = await page.evaluate(
  () => Number(document.querySelector('.timeline-input').max),
);
console.log('duration', duration, 's');

const el = await page.locator('.player');
for (let i = 0; i < N; i++) {
  const t = (duration * i) / (N - 1);
  // Set the range through the native setter so React's onChange (= seek) fires;
  // Playwright's fill() rejects range inputs.
  await page.evaluate((value) => {
    const input = document.querySelector('.timeline-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, t);
  // Longer than CROSSFADE_MS (250) so the freeze-frame layer is fully faded in
  // and the capture shows the same opacity it would during real playback.
  await page.waitForTimeout(300);
  await el.screenshot({ path: `${OUT}/f${String(i).padStart(3, '0')}.png` });
}
console.log('captured', N, 'frames to', OUT);

await browser.close();
