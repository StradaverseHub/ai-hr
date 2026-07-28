/**
 * Feedback 29710798 — one success notification after a leave submission, not two.
 *
 * WHY THERE WERE TWO. `requestLeaveAction` redirected with the opaque marker `?toast=leaveSubmitted`, and two
 * independent listeners answered it: `ToastFromQuery`, mounted globally in app/layout.tsx, which fires
 * `toast.success(params.get('toast'))` for ANY `?toast=` on ANY page — so it showed the raw word
 * "leaveSubmitted" — and a /leave-only client component that translated the marker into the proper sentence.
 * Deleting the global one was never an option: every other redirect in the app relies on it. So the marker
 * went instead, and the action now passes the already-localised text the global listener was built to render.
 *
 * This is a static-source guard (DB-free, jsdom-free) because the defect is a WIRING duplicate: a future edit
 * that re-adds a page-local listener, or reverts the redirect to a marker, brings both toasts back without
 * changing a single figure any behavioural test measures.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const actions = read('app/leave/actions.ts');
const page = read('app/leave/page.tsx');
const layout = read('app/layout.tsx');

describe('29710798: the submit path has exactly one success emitter', () => {
  it('requestLeaveAction redirects with LOCALISED text, not the ?toast=leaveSubmitted marker', () => {
    const fn = actions.slice(actions.indexOf('export async function requestLeaveAction'));
    // Read the redirect STATEMENTS, not the prose — the comment above the redirect names the old marker in
    // order to explain why it went, and a plain substring search would trip over its own history note.
    const redirects = [...fn.matchAll(/redirect\((.*)\);/g)].map((m) => m[1]);
    expect(redirects.some((r) => r.includes('leaveSubmitted'))).toBe(false);
    // The global ToastFromQuery renders the raw query string, so the value must be resolved server-side and
    // encoded — an i18n key in the URL would put "submittedToast" on screen.
    expect(fn.includes("await getTranslations('leave')")).toBe(true);
    expect(fn.includes("encodeURIComponent(tToast('submittedToast'))")).toBe(true);
    // The holiday-warning query must still be able to ride along with it.
    expect(fn.includes("`/leave${warnQuery}${warnQuery ? '&' : '?'}toast=${done}`")).toBe(true);
  });

  it('the marker-translating component is gone and nothing imports it', () => {
    expect(existsSync(root + 'components/leave/submit-toast.tsx')).toBe(false);
    expect(page.includes('LeaveSubmitToast')).toBe(false);
    expect(page.includes('submit-toast')).toBe(false);
  });

  it('ToastFromQuery is still mounted globally — the one emitter that survives', () => {
    expect(layout.includes('<ToastFromQuery />')).toBe(true);
  });

  it('no OTHER component raises a leave-submission toast on the client', () => {
    // A sonner `toast.success` anywhere under components/leave would be a second emitter by another name.
    const dir = root + 'components/leave/';
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      .filter((f) => readFileSync(dir + f, 'utf8').includes('toast.success'));
    expect(offenders).toEqual([]);
  });
});

describe('29710798: the confirmation still says the right thing, in every locale', () => {
  it('leave.submittedToast is present in all six message files', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const msgs = JSON.parse(read(`messages/${loc}.json`)) as { leave: Record<string, unknown> };
      expect(typeof msgs.leave.submittedToast, loc).toBe('string');
      expect((msgs.leave.submittedToast as string).length, loc).toBeGreaterThan(0);
    }
  });
});
