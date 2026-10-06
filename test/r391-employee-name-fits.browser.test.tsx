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
 * Capping alone then clipped almost every name on the card ("Aisyah R…", "ADLI BIN D…"): one line beside the
 * ID leaves about 70px. So the org chart passes `wrap`: the name takes up to two lines, then ellipsises.
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

  const lineHeight = (el: HTMLElement) => parseFloat(getComputedStyle(el).lineHeight);
  const lines = (el: HTMLElement) => Math.round(el.clientHeight / lineHeight(el));
  const hiddenBelow = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1;

  // In the org chart the ID and name flow as one line of text (EmployeeName `wrap`), so the clamp and the line
  // count belong to the GROUP. An inline ID chip reports scrollWidth 0 whatever happens, so "the ID is whole"
  // is measured as geometry: on the first line, inside the group, and as wide as the same ID set on its own.
  const idIsWhole = (code: HTMLElement, group: HTMLElement) => {
    const probe = document.createElement('span');
    probe.className = code.className;
    probe.style.position = 'absolute';
    probe.textContent = code.textContent;
    document.body.appendChild(probe);
    const natural = rect(probe).width;
    probe.remove();
    const c = rect(code);
    const g = rect(group);
    expect(natural, 'a real ID width to compare with').toBeGreaterThan(20);
    expect(c.width, 'the ID is not squeezed').toBeGreaterThanOrEqual(natural - 0.5);
    expect(c.top, 'the ID starts the first line').toBeLessThan(g.top + lineHeight(group));
    expect(c.right).toBeLessThanOrEqual(g.right + 0.5);
  };

  it('a very long name stops at TWO lines with an ellipsis, and the employee ID before it stays whole', () => {
    wrap(<OrgChart employees={PEOPLE} edges={[]} />);
    const { group, code } = nameParts(document, LONG);
    expect(lineHeight(group), 'a real line height to count lines with').toBeGreaterThan(10);
    expect(lines(group)).toBe(2);
    expect(hiddenBelow(group), 'the rest of the very long name is clamped, not spilling down the card').toBe(true);
    expect(clipped(group), 'and never sideways').toBe(false);
    expect(code.textContent).toBe('CHCE0999');
    idIsWhole(code, group);
  });

  it.each(['ADLI BIN DAUD', 'CHONG SOOK FUN'])('%s (from the report) is shown IN FULL', (name) => {
    wrap(<OrgChart employees={PEOPLE} edges={[]} />);
    const { group, code } = nameParts(document, name);
    expect(clipped(group)).toBe(false);
    expect(hiddenBelow(group)).toBe(false);
    expect(lines(group)).toBeLessThanOrEqual(2);
    idIsWhole(code, group);
  });

  it('a short name takes one line and is not clipped', () => {
    wrap(<OrgChart employees={PEOPLE} edges={[]} />);
    const { group } = nameParts(document, SHORT);
    expect(clipped(group)).toBe(false);
    expect(hiddenBelow(group)).toBe(false);
    expect(lines(group)).toBe(1);
  });

  it('everywhere else (no wrap) the name still clips on ONE line inside a narrow block — 31 call sites', () => {
    wrap(
      <div style={{ width: 140 }} data-testid="box">
        <EmployeeName code="CHCE0085" name={LONG} className="text-sm font-semibold" />
      </div>,
    );
    const box = document.querySelector('[data-testid="box"]')!;
    const { nameEl, group, code } = nameParts(box, LONG);
    expect(rect(group).right).toBeLessThanOrEqual(rect(box).right + 0.5);
    expect(clipped(nameEl)).toBe(true);
    expect(getComputedStyle(nameEl).textOverflow).toBe('ellipsis');
    expect(lines(nameEl)).toBe(1);
    expect(clipped(code)).toBe(false);
  });
});
