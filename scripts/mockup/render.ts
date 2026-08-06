/**
 * Render a mockup HTML file to a PNG for attaching to a board plan (0406).
 *
 *   pnpm mockup <input.html> <output.png> [--width 1280] [--dark]
 *
 * WHY PLAYWRIGHT AND NOT A DRAWING LIBRARY. It is already a devDependency (vitest.browser.config.ts) with
 * chromium already installed, so this adds NOTHING to install. More importantly a mockup written as HTML
 * can import the product's REAL stylesheet, which is the difference between a picture of our app and a
 * picture of a generic form — and the reporter is being asked to judge whether the screen will look right.
 *
 * WHY A FULL-PAGE SCREENSHOT. The board renders the image inline at the width of the plan card, so a
 * viewport-cropped shot would cut the bottom off a tall screen with no indication anything was lost.
 *
 * NO NETWORK. The page is loaded from the filesystem and given no chance to fetch: a mockup that silently
 * depended on a CDN would render here (where the machine has internet) and be missing its font or icons in
 * whatever renders it next. Everything a mockup needs must be inline or local, and this enforces it by
 * failing on the first external request rather than quietly producing a degraded image.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  const [input, output, ...rest] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: pnpm mockup <input.html> <output.png> [--width N] [--dark]');
    process.exit(2);
  }
  const src = resolve(input);
  if (!existsSync(src)) throw new Error(`no such file: ${src}`);
  const widthArg = rest.indexOf('--width');
  const width = widthArg >= 0 ? Number(rest[widthArg + 1]) : 1280;
  if (!Number.isFinite(width) || width < 320) throw new Error(`--width must be a number ≥ 320, got ${width}`);
  const dark = rest.includes('--dark');

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    // 2 keeps text crisp when the board scales the image down into the plan card. Higher just costs bytes
    // against the 10 MB attachment ceiling.
    deviceScaleFactor: 2,
    colorScheme: dark ? 'dark' : 'light',
  });

  const external: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('about:')) return route.continue();
    external.push(url);
    return route.abort();
  });

  await page.goto(pathToFileURL(src).href, { waitUntil: 'load' });
  // Fonts resolve after `load`; screenshotting before they settle bakes in the fallback face and every
  // measurement in the image is then a lie about spacing.
  await page.evaluate(() => document.fonts.ready);

  // `fullPage` captures max(viewport, content), so a mockup shorter than the viewport comes out padded
  // with dead space — and the board renders this inline at the width of the plan card, where half an
  // image of empty background reads as "the design is unfinished". Measure the content and shrink the
  // viewport to it first. Clamped at 200px so a nearly-empty page still produces a sane image.
  //
  // NOT scrollHeight: <html> stretches to fill the viewport, so on a page SHORTER than the viewport it
  // reports the viewport height and the measurement silently does nothing (the first version of this
  // shipped a 900px-tall image of 800px of content and looked like it worked). Measure the furthest
  // bottom edge among the body's own children instead, which is the real content, then add the body's
  // bottom padding back so the design is not cropped flush against the frame.
  const contentHeight = await page.evaluate(() => {
    const kids = [...document.body.children];
    if (kids.length === 0) return document.body.scrollHeight;
    const lowest = Math.max(...kids.map((el) => el.getBoundingClientRect().bottom));
    return Math.ceil(lowest + parseFloat(getComputedStyle(document.body).paddingBottom || '0'));
  });
  await page.setViewportSize({ width, height: Math.max(200, contentHeight) });

  if (external.length) {
    await browser.close();
    throw new Error(
      `mockup reached for ${external.length} external resource(s) and they were BLOCKED, so this image ` +
        `would be missing them:\n  ${[...new Set(external)].slice(0, 10).join('\n  ')}\n` +
        `Inline them (a data: URI for images, a <style> block for CSS) and re-run.`,
    );
  }

  mkdirSync(dirname(resolve(output)), { recursive: true });
  await page.screenshot({ path: resolve(output), fullPage: true });
  await browser.close();
  console.log(`✓ ${output} (${width}px wide @2x, ${dark ? 'dark' : 'light'})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
