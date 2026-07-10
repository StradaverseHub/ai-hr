/**
 * Career Movement tab (feedback 5296d984) — the Personnel (Admin) employee-detail page must expose a
 * dedicated "Career Movement" tab that centralises the employment-lifecycle actions previously buried in
 * the Employment (`job`) tab: Assignment History, Transfer (Effective-Dated) and Terminate. The section
 * cards are relocated WHOLE — the const definitions (assignmentHistoryCard, transferTerminateCards which
 * bundles BOTH transferAction and terminateAction) stay byte-identical; only the render reference moves.
 * The Employment tab must no longer render the relocated cards; it keeps reporting lines + delegations.
 *
 * A source-static test (precedent: test/personnel-attendance-tab.test.ts, test/personnel-bank-statutory-tab.test.ts)
 * is the cheapest guard against a future refactor silently un-relocating a card or dropping the new tab.
 * It also pins the i18n label present in all six locales so tab navigation never renders a raw key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
  'utf8',
);
const TABS = fs.readFileSync(path.resolve(__dirname, '../components/personnel-tabs.tsx'), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// Slice out the panels object body so we can assert WHICH panel each card lives in, not just that the
// reference exists somewhere on the page (the const definitions also mention the card names).
function panelBody(key: string): string {
  const start = PAGE.indexOf(`${key}: (`);
  if (start === -1) {
    // Single-node panel form: `key: someCard,`
    const single = PAGE.indexOf(`${key}: `);
    return single === -1 ? '' : PAGE.slice(single, PAGE.indexOf('\n', single));
  }
  // Balance the fragment from the opening `(` to its matching `),`.
  const from = PAGE.indexOf('(', start);
  return PAGE.slice(from, PAGE.indexOf('    ),', from) + 6);
}

describe('Personnel — Career Movement tab (5296d984)', () => {
  it('registers the career-movement tab in the tab strip', () => {
    expect(PAGE.includes("{ key: 'careerMovement', label: t('tabs.careerMovement') }")).toBe(true);
    // The union type the tab array is annotated with must include the key too.
    expect(PAGE.includes("'careerMovement'")).toBe(true);
  });

  it('positions the career-movement tab immediately after Employment (job)', () => {
    const jobIdx = PAGE.indexOf("{ key: 'job', label: t('tabs.job') }");
    const cmIdx = PAGE.indexOf("{ key: 'careerMovement', label: t('tabs.careerMovement') }");
    const attIdx = PAGE.indexOf("{ key: 'attendance', label: t('tabs.attendance') }");
    expect(jobIdx).toBeGreaterThan(-1);
    expect(cmIdx).toBeGreaterThan(jobIdx);
    expect(attIdx).toBeGreaterThan(cmIdx);
  });

  it('mirrors the new key in the ClientTabs PersonnelTabKey union', () => {
    expect(TABS.includes("'careerMovement'")).toBe(true);
  });

  it('renders Assignment History + Transfer/Terminate inside the career-movement panel', () => {
    const cm = panelBody('careerMovement');
    expect(cm.includes('{assignmentHistoryCard}')).toBe(true);
    // transferTerminateCards bundles BOTH the Transfer (Effective-Dated) form and the Terminate form,
    // so one reference satisfies the reporter's Transfer + Termination relocations.
    expect(cm.includes('{transferTerminateCards}')).toBe(true);
  });

  it('relocates the three lifecycle functions OUT of the Employment (job) tab', () => {
    const job = panelBody('job');
    expect(job.includes('{assignmentHistoryCard}')).toBe(false);
    expect(job.includes('{transferTerminateCards}')).toBe(false);
    // Employment tab keeps the "how they work" master data (relocation only removed the lifecycle ones).
    expect(job.includes('{reportingLinesCard}')).toBe(true);
    expect(job.includes('{delegationsCard}')).toBe(true);
  });

  it('preserves the relocated cards WHOLE — const defs + their server-action <form>s untouched', () => {
    // Assignment history card is defined once and not admin-gated (visible to any viewer).
    expect(PAGE.includes('const assignmentHistoryCard = (')).toBe(true);
    // Transfer + Terminate card bundle: both effective-dated actions preserved with their events.
    expect(PAGE.includes('const transferTerminateCards = !emp.terminatedOn ?')).toBe(true);
    expect(PAGE.includes('transferAction')).toBe(true);
    expect(PAGE.includes('terminateAction')).toBe(true);
    // Anchor id for assignment history stays so deep-links keep working.
    expect(PAGE.includes('id="section-assignment-history"')).toBe(true);
  });

  it('has the tabs.careerMovement label in all six locales (no raw key at runtime)', () => {
    for (const loc of LOCALES) {
      const msg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      );
      const label = msg?.people?.detail?.tabs?.careerMovement;
      expect(
        typeof label,
        `messages/${loc}.json missing people.detail.tabs.careerMovement`,
      ).toBe('string');
      expect(label.length, `messages/${loc}.json careerMovement label is empty`).toBeGreaterThan(0);
    }
  });
});
