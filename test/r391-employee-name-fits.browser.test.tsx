/**
 * r391 — THE ORG-CHART NAME STILL OVERSPILT AFTER r286. MEASURED HERE, IN A REAL BROWSER.
 *
 * Reported again on 2026-10-06 with a screenshot of production: "CHCE0292 ADLI BIN DAUD" and "CHCE0085
 * CHONG SOOK FUN" running through the right border of their org-chart cards, while the role line under each
 * ellipsised correctly. r286 had "fixed" exactly this, and its guard (test/r286-employee-name-truncation
 * .test.ts) is green: it pins class names in the source, because jsdom has no layout engine.
 *
 * What r286 missed: `EmployeeName` is an INLINE-flex group. An inline-level box is sized shrink-to-fit, and
 * its min-content width here is the WHOLE line — the code plus a `nowrap` name. `min-w-0` on the name lowers
 * the floor the flex algorithm uses inside the group, but it does not change the group's own min-content
 * contribution, so the group takes its full text width, never gets narrower than the card, and the name's
 * `truncate` never has anything to clip against. A ceiling is what was missing: `max-w-full` caps the group
 * at its container, then the name (min-w-0) shrinks and ellipsises while the code (shrink-0) stays whole.
 *
 * This renders the REAL OrgChart with the screenshot's people. A test browser has no Plus Jakarta Sans, so
 * the assertions are about room, not glyphs: one name is long enough to overflow in any font, one is short
 * enough to fit in any font.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '../messages/en.json';
import '../app/globals.css';
import { OrgChart, type OrgEmp } from '../components/org-chart';
import { EmployeeName } from '../components/ui';

const LONG = 'NUR AISYAH BINTI MOHAMAD ABDUL RAHMAN SHAHRIZAL';
const SHORT = 'Li Na';
const PEOPLE: OrgEmp[] = [
  { employmentId: 'e1', name: 'ADLI BIN DAUD', employeeCode: 'CHCE0292', role: 'EQUIPMENT CONTROLLER', department: 'ASSET' },
  { employmentId: 'e2', name: 'ADLI BIN DAUD', employeeCode: 'XXX0292', role: 'EQUIPMENT CONTROLLER', department: 'ASSET' },
  { employmentId: 'e3', name: 'CHONG SOOK FUN', employeeCode: 'CHCE0085', role: 'CONTRACT DIRECTOR', department: 'CONTRACT' },
  { employmentId: 'e4', name: LONG, employeeCode: 'CHCE0999', role: 'SENIOR QUANTITY SURVEYOR', department: 'COMMERCIAL' },
  { employmentId: 'e5', name: SHORT, employeeCode: 'E1', role: 'CLERK', department: 'ADMIN' },
];

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={en as never} onError={(e: unknown) => { throw e; }}>
      {ui}
    </NextIntlClientProvider>,
  );

const rect = (el: Element) => el.getBoundingClientRect();
/** The name span is the one whose own text is the name; its parent is the EmployeeName group. */
function nameParts(root: ParentNode, name: string) {
  const nameEl = [...root.querySelectorAll<HTMLElement>('span')].find((s) => s.textContent === name && s.children.length === 0)!;
  const group = nameEl.parentElement!;
  const code = group.firstElementChild as HTMLElement;
  return { nameEl, group, code };
}
const clipped = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;

describe('an employee name never runs out of its org-chart card', () => {
  beforeAll(() => {
    document.body.style.margin = '0';
  });
  afterEach(() => cleanup());

  it('every card keeps its whole content inside its border', () => {
    wrap(<OrgChart employees={PEOPLE} edges={[]} />);
    const cards = [...document.querySelectorAll<HTMLElement>('a[href^="/personnel/"]')];
    expect(cards).toHaveLength(PEOPLE.length);
    for (const card of cards) {
      const c = rect(card);
      expect(c.width, 'the card has a real width').toBeGreaterThan(150);
      for (const el of card.querySelectorAll('*')) {
        expect(rect(el).right, `${card.textContent} — <${el.tagName.toLowerCase()} class="${el.getAttribute('class')}">`).toBeLessThanOrEqual(c.right + 0.5);
      }
    }
  });

  it('a long name is clipped with an ellipsis, and the employee ID beside it stays whole', () => {
    wrap(<OrgChart employees={PEOPLE} edges={[]} />);
    const { nameEl, code } = nameParts(document, LONG);
    expect(rect(nameEl).width, 'the name keeps visible room').toBeGreaterThan(20);
    expect(clipped(nameEl), 'the long name is truncated rather than overflowing').toBe(true);
    expect(getComputedStyle(nameEl).textOverflow).toBe('ellipsis');
    expect(code.textContent).toBe('CHCE0999');
    expect(clipped(code), 'the ID is never eaten').toBe(false);
  });

  it('a short name is not clipped at all', () => {
    wrap(<OrgChart employees={PEOPLE} edges={[]} />);
    const { nameEl } = nameParts(document, SHORT);
    expect(clipped(nameEl)).toBe(false);
  });

  it('the shared component fits a plain narrow block too (it is rendered from 31 places)', () => {
    wrap(
      <div style={{ width: 140 }} data-testid="box">
        <EmployeeName code="CHCE0085" name={LONG} className="text-sm font-semibold" />
      </div>,
    );
    const box = document.querySelector('[data-testid="box"]')!;
    const { nameEl, group, code } = nameParts(box, LONG);
    expect(rect(group).right).toBeLessThanOrEqual(rect(box).right + 0.5);
    expect(clipped(nameEl)).toBe(true);
    expect(clipped(code)).toBe(false);
  });
});
