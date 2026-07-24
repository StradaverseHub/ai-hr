/**
 * f71dcafd — Notification bell: one combined count bubble (static-source guard).
 *
 * The topbar bell used to carry TWO absolutely-positioned badges on the same size-9 button: a rose
 * unread badge pinned top-right and an amber taskCount badge pinned bottom-right. When a viewer had
 * unread notifications AND open tasks at once the two bubbles collided and the numbers became
 * unreadable. This item merges them into a single primary-coloured bubble showing unread + taskCount,
 * anchored at the one existing top-right spot, and reconciles the bell's aria-label so screen-reader
 * users hear the same combined total that sighted users see.
 *
 * The two underlying counts stay SEPARATE inputs — the in-panel per-tab pills still show unread and
 * taskCount individually (test/notification-tabs.test.ts remains the data-layer parity guard for how
 * those counts are computed; nothing here changes them).
 *
 * This guard is DB-free / jsdom-free (the suite has no DOM runner) so it runs fast and
 * deterministically. It fails loudly if a future edit (a) reintroduces a second corner-anchored badge
 * on the bell, (b) un-sums the badge back to a single raw count, (c) drops the 99+ overflow cap, or
 * (d) loses the {total} placeholder from the ariaBell string in any of the 6 locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const BELL = 'components/notification-center.tsx';
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

const src = read(BELL);
/** The bell trigger only — from its aria-label through its closing tag (excludes the panel below). */
const bellButton = (() => {
  const start = src.indexOf("aria-label={t('ariaBell'");
  if (start < 0) throw new Error(`${BELL}: bell trigger (aria-label ariaBell) not found`);
  const end = src.indexOf('</button>', start);
  if (end < 0) throw new Error(`${BELL}: bell trigger has no closing </button>`);
  return src.slice(start, end);
})();

describe('Notification bell: a single combined count badge', () => {
  it('sums the two counts into one total', () => {
    expect(src).toMatch(/const total = unread \+ taskCount;/);
  });

  it('renders exactly ONE absolutely-positioned badge on the bell', () => {
    const absolute = bellButton.match(/className="absolute/g) ?? [];
    expect(absolute).toHaveLength(1);
  });

  it('the surviving badge is the top-right one — no bottom-anchored second bubble', () => {
    expect(bellButton).toMatch(/className="absolute right-1 top-1/);
    expect(bellButton.includes('bottom-1')).toBe(false);
  });

  it('the badge is gated on the summed total, not on either count alone', () => {
    expect(bellButton).toMatch(/\{total > 0 && \(/);
    expect(bellButton.includes('{unread > 0 &&')).toBe(false);
    expect(bellButton.includes('{taskCount > 0 &&')).toBe(false);
  });

  it('the badge prints the total with the 99+ cap used by the in-panel tab pills', () => {
    expect(bellButton).toMatch(/\{total > 99 \? '99\+' : total\}/);
    // The old per-badge 9-cap is gone.
    expect(bellButton.includes("'9+'")).toBe(false);
  });

  it('the badge uses the neutral primary token, not the old rose/amber pair', () => {
    expect(bellButton).toMatch(/bg-primary\b/);
    expect(bellButton).toMatch(/text-primary-foreground\b/);
    expect(bellButton.includes('bg-rose-500')).toBe(false);
    expect(bellButton.includes('bg-amber-500')).toBe(false);
    // Wide enough for three glyphs ('99+'), matching the tab pills.
    expect(bellButton).toMatch(/min-w-\[16px\]/);
  });

  it('the accessible name is given the same total the badge shows (a11y parity)', () => {
    expect(bellButton).toMatch(/aria-label=\{t\('ariaBell', \{ total, unread, tasks: taskCount \}\)\}/);
  });

  it('the per-tab pills still receive the two counts separately', () => {
    expect(src).toMatch(/tabBtn\('notifications', t\('tabNotifications'\), unread\)/);
    expect(src).toMatch(/tabBtn\('tasks', t\('tabTasks'\), taskCount\)/);
  });
});

describe('Notification bell: ariaBell announces the total in all 6 locales', () => {
  for (const loc of LOCALES) {
    it(`${loc}.json notifications.ariaBell carries {total}, {unread} and {tasks}`, () => {
      const msgs = JSON.parse(read(`messages/${loc}.json`)) as {
        notifications: Record<string, string>;
      };
      const s = msgs.notifications.ariaBell;
      expect(typeof s).toBe('string');
      expect(s).toContain('{total}');
      expect(s).toContain('{unread}');
      expect(s).toContain('{tasks}');
    });
  }
});
