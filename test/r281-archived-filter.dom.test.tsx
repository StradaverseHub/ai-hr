/**
 * a3411394 (r281) — THE ARCHIVED LIST, RENDERED.
 *
 * ⚠️ THE REPORT WAS RIGHT AND THE DIAGNOSIS IN IT WAS NOT, which is why this file renders rather than
 * greps. "The archived record is not appearing in the archived list" reads like a query defect, and it is
 * not one: `app/admin/leave-config/types/page.tsx` has always passed `includeArchived: true`, sorted the
 * archived rows last and handed `archived: boolean` down per row, and the workspace has always drawn them
 * with `opacity-60`. The row was on the screen. What did not exist was the LIST — no filter, no section,
 * no count, and the word "Archived" nowhere on the page — so with nineteen leave types the only archived
 * one sat below the fold of a `max-h-[28rem]` scroll panel, marked by nothing but being a little fainter.
 *
 * Every one of those facts passes tsc, `next build` and a static source scan. The only thing that can see
 * "a dimmed row below the fold is not a list" is something that renders the component and looks.
 *
 * WHAT IS PINNED, and §A is the one that matters most:
 *
 *  §A THE BEHAVIOUR CHANGE. The default view is Active, so an archived leave type is NO LONGER IN THE RAIL
 *    AT ALL. Before this change it could be found by scrolling to the bottom. That is a real regression for
 *    anyone who relied on the scroll, it is the deliberate point of the item, and it is pinned here so that
 *    nobody later "fixes" the default back to All without meaning to.
 *
 *  §B/§C the other two views, and §D the counts — which come off the SAME `items` array, so a count that
 *    disagrees with the rows it counts is the first thing to catch.
 *
 *  §E the word on the row. The dimming stays as a secondary cue; the badge is what a reader can look for.
 *
 *  §F THE TRAP THE PLAN NAMED: the Unarchive button lives INSIDE the type's own panel, so archiving
 *    something hides the way to undo it. Choosing Archived must therefore not merely list the type — it
 *    has to put its panel, and that button, on screen. §J checks the real panel really carries it, so this
 *    case is not a claim about the fixture.
 *
 *  §G THE DEEP LINK. `#type-<id>` is a standing contract (097de541) and every stay-on-save redirect
 *    carries one — including for an archived type. A view that hid the row the deep link just selected
 *    would be this item's own version of the defect it fixes.
 *
 *  §H THE PHONE, which is the easy half to forget: a native <option> can carry neither a badge nor
 *    `opacity-60`, so without the word in the option TEXT the dropdown says nothing about archived at all.
 *
 *  §I all six locales, because a filter whose chips paint `MISSING_MESSAGE` is not a filter.
 *
 * Scope: presentation only. No server change, no new prop, no query touched — `archived` was already on
 * every row, it just had nothing that counted it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

// The SHIPPING catalogues, not fixtures: a key missing from one of these six files is exactly the defect
// §I exists to catch.
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LeaveTypeWorkspace, type LeaveTypeWorkspaceItem } from '../components/leave-type-workspace';

/** Off `process.cwd()`, not `import.meta.url`: the jsdom project rewrites `import.meta.url` to an http URL,
 *  so the usual `new URL('..', import.meta.url)` resolves to nothing a file read can use. */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
/** `admin.leave` holds nested objects as well as strings (subStep, dayTypeInclusion, …), so the cast goes
 *  through `unknown`: every key this file reads IS a string, and §I asserts that rather than assuming it. */
const leaveStrings = (loc: Locale) =>
  (CATALOGUES[loc] as unknown as { admin: { leave: Record<string, string> } }).admin.leave;
const EN = leaveStrings('en');

/**
 * The fixture mirrors what the SERVER sends: active types A–Z, then archived types A–Z (page.tsx's
 * `Number(!!a.archivedAt) - Number(!!b.archivedAt)` then name). The component does not re-sort — §K —
 * so the order the rail shows is this order, and a test that fed it a shuffled list would be asserting
 * about a sort that lives somewhere else.
 */
const ACTIVE_NAMES = ['Annual Leave', 'Hospitalisation Leave', 'Sick Leave'] as const;
const ARCHIVED_NAMES = ['Replacement Leave', 'Study Leave'] as const;
const idOf = (name: string) => `lt-${name.toLowerCase().replace(/\s+/g, '-')}`;

const row = (name: string, archived: boolean): LeaveTypeWorkspaceItem => ({
  id: idOf(name),
  name,
  code: name.slice(0, 3).toUpperCase(),
  archived,
  color: null,
  icon: null,
});
const ITEMS: LeaveTypeWorkspaceItem[] = [
  ...ACTIVE_NAMES.map((n) => row(n, false)),
  ...ARCHIVED_NAMES.map((n) => row(n, true)),
];

/**
 * A stand-in for the server-rendered `<LeaveTypeTabs>` slot: the only property this component has over
 * `panels` is that it mounts the SELECTED id's node, and the archived ones carry the same Unarchive
 * control the real panel does (leave-type-tabs.tsx — asserted for real in §J).
 */
const UNARCHIVE = EN.unarchive;
const panelsFor = (items: LeaveTypeWorkspaceItem[]) =>
  Object.fromEntries(
    items.map((i) => [
      i.id,
      <div key={i.id}>
        <span>{`Configuring ${i.name}`}</span>
        {i.archived ? <button type="button">{UNARCHIVE}</button> : null}
      </div>,
    ]),
  );

function mount(loc: Locale = 'en', items: LeaveTypeWorkspaceItem[] = ITEMS, onError?: (e: unknown) => void) {
  return render(
    <NextIntlClientProvider locale={loc} messages={CATALOGUES[loc]} onError={onError ?? (() => {})}>
      <LeaveTypeWorkspace items={items} panels={panelsFor(items)} addForm={<div>add form</div>} />
    </NextIntlClientProvider>,
  );
}

/** The DESKTOP rail. jsdom applies no CSS, so `md:hidden` hides nothing here and the mobile dropdown is in
 *  the same document — every rail query is scoped to the <nav> for that reason. */
const rail = (loc: Locale = 'en') =>
  screen.getByRole('navigation', { name: leaveStrings(loc).workspaceTypeListLabel });
const filterGroup = (scope: HTMLElement, loc: Locale = 'en') =>
  within(scope).getByRole('group', { name: leaveStrings(loc).workspaceFilterLabel });
/** The chip for one view. Matched on the leading LABEL because the accessible name also carries the count,
 *  and the count is what several of these cases are about. */
const chip = (scope: HTMLElement, label: string, loc: Locale = 'en') => {
  const found = within(filterGroup(scope, loc))
    .getAllByRole('button')
    .find((b) => (b.textContent ?? '').startsWith(label));
  if (!found) throw new Error(`no filter chip labelled ${label}`);
  return found;
};
const countOn = (button: HTMLElement) => Number(/(\d+)$/.exec(button.textContent ?? '')?.[1] ?? NaN);
const railNames = () =>
  within(rail())
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
    .filter((txt) => [...ACTIVE_NAMES, ...ARCHIVED_NAMES].some((n) => txt.startsWith(n)))
    .map((txt) => [...ACTIVE_NAMES, ...ARCHIVED_NAMES].find((n) => txt.startsWith(n)) as string);

beforeEach(() => {
  // A hash left behind by §G would silently re-select — and re-widen — in every later case.
  window.history.replaceState(null, '', '/admin/leave-config/types');
});

describe('§A a3411394 · the default view is Active — and that HIDES archived types', () => {
  it('opens on Active with only the active types in the rail', () => {
    mount();
    expect(chip(rail(), EN.workspaceFilterActive)).toHaveAttribute('aria-pressed', 'true');
    for (const name of ACTIVE_NAMES) expect(within(rail()).getByText(name)).toBeInTheDocument();
  });

  it('THE BEHAVIOUR CHANGE: an archived type is absent from the rail, not merely faded at the bottom', () => {
    mount();
    for (const name of ARCHIVED_NAMES) expect(within(rail()).queryByText(name)).toBeNull();
    expect(railNames()).toEqual([...ACTIVE_NAMES]);
  });
});

describe('§B a3411394 · Archived — the list the reporter could not find', () => {
  it('lists every archived type and no active one', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(chip(rail(), EN.workspaceFilterArchived));
    expect(chip(rail(), EN.workspaceFilterArchived)).toHaveAttribute('aria-pressed', 'true');
    expect(railNames()).toEqual([...ARCHIVED_NAMES]);
    for (const name of ACTIVE_NAMES) expect(within(rail()).queryByText(name)).toBeNull();
  });
});

describe('§C a3411394 · All — everything, in the order the server sent', () => {
  it('lists active then archived, unchanged: the component still does not re-sort', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(chip(rail(), EN.workspaceFilterAll));
    expect(railNames()).toEqual(ITEMS.map((i) => i.name));
  });
});

describe('§D a3411394 · the counts, read off the same array as the rows', () => {
  it('each chip counts exactly what its view lists', async () => {
    const user = userEvent.setup();
    mount();
    expect(countOn(chip(rail(), EN.workspaceFilterActive))).toBe(ACTIVE_NAMES.length);
    expect(countOn(chip(rail(), EN.workspaceFilterArchived))).toBe(ARCHIVED_NAMES.length);
    expect(countOn(chip(rail(), EN.workspaceFilterAll))).toBe(ITEMS.length);
    // …and the count is the row count, checked by walking each view rather than by trusting the label.
    for (const [label, expected] of [
      [EN.workspaceFilterActive, [...ACTIVE_NAMES]],
      [EN.workspaceFilterArchived, [...ARCHIVED_NAMES]],
      [EN.workspaceFilterAll, ITEMS.map((i) => i.name)],
    ] as const) {
      await user.click(chip(rail(), label));
      expect(railNames()).toEqual(expected);
      expect(countOn(chip(rail(), label))).toBe(expected.length);
    }
  });

  it('a catalogue with nothing archived says Archived 0 rather than saying nothing', async () => {
    const user = userEvent.setup();
    const activeOnly = ACTIVE_NAMES.map((n) => row(n, false));
    mount('en', activeOnly);
    expect(countOn(chip(rail(), EN.workspaceFilterArchived))).toBe(0);
    // Clicking into the empty view must not claim the CATALOGUE is empty — a different sentence entirely.
    await user.click(chip(rail(), EN.workspaceFilterArchived));
    expect(within(rail()).getByText(EN.workspaceFilterEmpty)).toBeInTheDocument();
    expect(within(rail()).queryByText(EN.noLeaveTypes)).toBeNull();
  });
});

describe('§E a3411394 · the row says the word, it does not only look faded', () => {
  it('every archived row carries the badge and no active row does', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(chip(rail(), EN.workspaceFilterAll));
    for (const name of ARCHIVED_NAMES) {
      const button = within(rail()).getByText(name).closest('button');
      expect(button).not.toBeNull();
      expect(button as HTMLElement).toHaveTextContent(EN.archivedBadge);
      // The dimming STAYS — it is a useful secondary cue, and removing it was explicitly not the job.
      expect((button as HTMLElement).className).toContain('opacity-60');
    }
    for (const name of ACTIVE_NAMES) {
      const button = within(rail()).getByText(name).closest('button') as HTMLElement;
      expect(button).not.toHaveTextContent(EN.archivedBadge);
      expect(button.className).not.toContain('opacity-60');
    }
  });
});

describe('§F a3411394 · the trap: Unarchive lives inside the row, so the row has to open', () => {
  it('choosing Archived selects an archived type and puts its panel — with Unarchive — on screen', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.queryByRole('button', { name: UNARCHIVE })).toBeNull();
    await user.click(chip(rail(), EN.workspaceFilterArchived));
    expect(screen.getByText(`Configuring ${ARCHIVED_NAMES[0]}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: UNARCHIVE })).toBeInTheDocument();
  });

  it('clicking a different archived row switches the panel to that type', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(chip(rail(), EN.workspaceFilterArchived));
    await user.click(within(rail()).getByText(ARCHIVED_NAMES[1]));
    expect(screen.getByText(`Configuring ${ARCHIVED_NAMES[1]}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: UNARCHIVE })).toBeInTheDocument();
    expect(within(rail()).getByText(ARCHIVED_NAMES[1]).closest('button')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('going back to Active re-selects a visible type, so the rail never shows a panel it cannot point at', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(chip(rail(), EN.workspaceFilterArchived));
    await user.click(chip(rail(), EN.workspaceFilterActive));
    expect(screen.getByText(`Configuring ${ACTIVE_NAMES[0]}`)).toBeInTheDocument();
    expect(within(rail()).getAllByRole('button').some((b) => b.getAttribute('aria-current') === 'true')).toBe(
      true,
    );
  });
});

describe('§G a3411394 · a #type-<id> deep link to an ARCHIVED type still lands on a visible row', () => {
  it('widens the view to All so the selected row is in the rail beside its panel', () => {
    window.history.replaceState(null, '', `/admin/leave-config/types#type-${idOf(ARCHIVED_NAMES[1])}`);
    mount();
    expect(chip(rail(), EN.workspaceFilterAll)).toHaveAttribute('aria-pressed', 'true');
    expect(within(rail()).getByText(ARCHIVED_NAMES[1]).closest('button')).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: UNARCHIVE })).toBeInTheDocument();
  });

  it('a deep link to an ACTIVE type leaves the default view alone', () => {
    window.history.replaceState(null, '', `/admin/leave-config/types#type-${idOf(ACTIVE_NAMES[2])}`);
    mount();
    expect(chip(rail(), EN.workspaceFilterActive)).toHaveAttribute('aria-pressed', 'true');
    expect(within(rail()).getByText(ACTIVE_NAMES[2]).closest('button')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
});

describe('§H a3411394 · the phone: one filter drives both controls, and the option says the word', () => {
  it('the dropdown lists the same rows as the rail and marks an archived one in its TEXT', async () => {
    const user = userEvent.setup();
    mount();
    const select = screen.getByRole('combobox', { name: EN.workspaceTypeListLabel });
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([...ACTIVE_NAMES]);
    await user.click(chip(rail(), EN.workspaceFilterArchived));
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(
      ARCHIVED_NAMES.map((n) => `${n} — ${EN.archivedBadge}`),
    );
    // The <select> keeps a value that IS one of its options — otherwise a phone shows the first option
    // while the workspace renders a different type's panel.
    expect(ARCHIVED_NAMES.map(idOf)).toContain((select as HTMLSelectElement).value);
  });
});

describe('§I a3411394 · every locale can read the filter', () => {
  it.each(LOCALES)('%s renders three chips and the badge with no unresolved key', async (loc) => {
    const errors: string[] = [];
    const user = userEvent.setup();
    mount(loc, ITEMS, (e) => errors.push(String(e)));
    const L = leaveStrings(loc);
    for (const label of [L.workspaceFilterActive, L.workspaceFilterArchived, L.workspaceFilterAll]) {
      expect(label.length).toBeGreaterThan(0);
      expect(chip(rail(loc), label, loc)).toBeInTheDocument();
    }
    await user.click(chip(rail(loc), L.workspaceFilterArchived, loc));
    expect(within(rail(loc)).getByText(ARCHIVED_NAMES[0]).closest('button')).toHaveTextContent(
      L.archivedBadge,
    );
    expect(errors.join('\n')).toBe('');
  });

  it('the five new keys exist and are non-empty in all six catalogues', () => {
    for (const loc of LOCALES) {
      const L = leaveStrings(loc);
      for (const key of [
        'workspaceFilterLabel',
        'workspaceFilterActive',
        'workspaceFilterArchived',
        'workspaceFilterAll',
        'workspaceFilterEmpty',
      ]) {
        expect(typeof L[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((L[key] ?? '').trim().length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
      // The three views must be three DIFFERENT words in every locale — one string for two of them is a
      // filter that has stopped saying which view you are in.
      expect(new Set([L.workspaceFilterActive, L.workspaceFilterArchived, L.workspaceFilterAll]).size).toBe(3);
    }
  });
});

describe('§J/§K a3411394 · the two facts a render cannot reach', () => {
  it('§J the REAL panel carries Unarchive, so §F is not a claim about the fixture', () => {
    const tabs = read('app/admin/leave-config/types/leave-type-tabs.tsx');
    expect(tabs).toContain("t('unarchive')");
    expect(tabs).toContain('name="archived" value="false"');
  });

  it('§K presentation only: no re-sort, no new prop, and the page is untouched by this item', () => {
    const workspace = read('components/leave-type-workspace.tsx');
    // The server's ordering stays the SINGLE ordering (the component's own header says so).
    expect(workspace).not.toMatch(/\.sort\(/);
    // The counts and the rows come off the one `items` array the page already sends.
    expect(workspace).toContain('const visibleItems = items.filter((i) => matchesFilter(i, filter));');
    expect(workspace).toContain("const [filter, setFilter] = useState<LeaveTypeFilter>('active');");
    // No new prop crossed the server/client boundary: `archived` was already on the row.
    expect(workspace).toMatch(/items: LeaveTypeWorkspaceItem\[\];/);
    const page = read('app/admin/leave-config/types/page.tsx');
    expect(page).toContain('archived: !!lt.archivedAt');
    expect(page).toContain('includeArchived: true');
  });
});
