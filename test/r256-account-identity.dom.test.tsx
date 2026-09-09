/**
 * fbf6abd0 — "the system does not clearly indicate which user/employee is currently logged in",
 * PROVED BY RENDERING.
 *
 * WHY A DOM TEST AND NOT A SOURCE SCAN. The whole complaint is about what a person SEES in the corner of
 * every screen, and the pre-change header returned 200 with no identity in it at all. A source scan can
 * say the component is mounted; only a render can say the name and the Employee ID actually reach the
 * page, that the fallback for an account with no employment is a readable label rather than a blank, and
 * that Log out is still reachable after it MOVED into the menu.
 *
 * IT ALSO STANDS IN FOR PART OF THE i18n CHECK, though not all of it. NextIntlClientProvider is given the
 * REAL catalogs and an onError that THROWS, so a key this component asks for and a catalog does not have
 * fails here instead of painting MISSING_MESSAGE — the failure mode that passes tsc, the suite, `next
 * build` and a 200 response. All six locales are swept below; the structural half (every en key present
 * in every locale) stays with test/i18n-coverage.test.ts, and neither replaces reading a dev-server log.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression. The responsive rule — the name
 * gives way below md, the avatar and the Employee ID stay — is a class on an element that is present in
 * the DOM either way, so it is asserted as a class, which is what it is.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

// The logout server action, stubbed. Importing it for real would pull lib/session → db/client, which
// opens a connection at module load; the `dom` project deliberately has no database env (test/dom-setup.ts).
// Nothing here submits the form — the assertion is that the control EXISTS in the menu it moved into.
vi.mock('@/app/auth-actions', () => ({ logoutAction: async () => {} }));

const { UserMenu, PROFILE_HREF } = await import('../components/user-menu');

const wrap = (ui: ReactNode, locale = 'en', messages: Record<string, unknown> = en as never) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages as never}
      // Throwing rather than logging: an unresolved key must fail the test, not paint its own key path.
      onError={(e: unknown) => {
        throw e;
      }}
    >
      {ui}
    </NextIntlClientProvider>,
  );

/** The account corner's trigger — the control that is on screen before anything is clicked. */
const trigger = (container: HTMLElement): HTMLElement =>
  container.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;

/**
 * Elements that render NOTHING: no text, no element children, not decorative. A blank <span> where a name
 * or a code should be is exactly what the plan forbids for an account with no employment, and it is
 * invisible to a text assertion — this is what catches it.
 *
 * Decorative exclusions, each of which is deliberately empty: the click-away backdrop, the 1px menu
 * divider, anything aria-hidden, and SVG internals (lucide icons are <svg><path/></svg>).
 */
const blankElements = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('*')]
    .filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() === '')
    .filter((el) => !(el instanceof SVGElement))
    .filter((el) => !el.hasAttribute('aria-hidden'))
    .filter((el) => !el.className.toString().includes('h-px'))
    .filter((el) => !el.className.toString().includes('inset-0'))
    .map((el) => `<${el.tagName.toLowerCase()} class="${el.className}">`);

describe('fbf6abd0 — the corner says who is signed in', () => {
  it('shows the name AND the Employee ID without opening anything', async () => {
    const { container } = wrap(<UserMenu name="Nurul Aisyah binti Karim" employeeCode="EMP-2201" employed />);
    const t = trigger(container);
    // The reporter asked for both, on every screen, in the place people already look.
    expect(t).toHaveTextContent('Nurul Aisyah binti Karim');
    expect(t).toHaveTextContent('EMP-2201');
    // Initials avatar, from the same name (components/ui.tsx Avatar) — "NA", not an upload.
    expect(t).toHaveTextContent('NA');
    expect(blankElements(container)).toEqual([]);
  });

  it('keeps the Employee ID (and the avatar) when the narrow-window rule drops the name', () => {
    const { container } = wrap(<UserMenu name="Nurul Aisyah binti Karim" employeeCode="EMP-2201" employed />);
    const t = trigger(container);
    const name = [...t.querySelectorAll('span')].find((s) => s.textContent === 'Nurul Aisyah binti Karim')!;
    const code = [...t.querySelectorAll('span')].find((s) => s.textContent === 'EMP-2201')!;
    // The name is the half that gives way; the code carries no `hidden` class at any breakpoint.
    expect(name.className).toContain('hidden');
    expect(name.className).toContain('md:block');
    expect(code.className).not.toContain('hidden');
  });

  it('the menu repeats the pair, links to the viewer’s own profile, and holds Log out', async () => {
    const { container } = wrap(<UserMenu name="Nurul Aisyah binti Karim" employeeCode="EMP-2201" employed />);
    await userEvent.click(trigger(container));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Signed in as');
    expect(menu).toHaveTextContent('Nurul Aisyah binti Karim');
    // Label translated, value not.
    expect(menu).toHaveTextContent('Employee ID');
    expect(menu).toHaveTextContent('EMP-2201');
    expect(within(menu).getByRole('menuitem', { name: 'View my profile' })).toHaveAttribute(
      'href',
      PROFILE_HREF,
    );
    // Log out MOVED here from beside the theme toggle — it is one click further, never gone.
    expect(within(menu).getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
    expect(blankElements(container)).toEqual([]);
  });

  it('an employed person with NO Employee ID says so, and never shows a blank line', async () => {
    // employment.employee_code is nullable, so this is reachable in real data — not a hypothetical.
    const { container } = wrap(<UserMenu name="Wong Mei Ling" employeeCode={null} employed />);
    expect(trigger(container)).toHaveTextContent('Wong Mei Ling');
    await userEvent.click(trigger(container));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('No Employee ID');
    expect(menu).toHaveTextContent('Wong Mei Ling');
    // Still their own record, so the profile link stays.
    expect(within(menu).getByRole('menuitem', { name: 'View my profile' })).toBeInTheDocument();
    expect(blankElements(container)).toEqual([]);
  });

  it('a NAMED principal with no employment keeps their own name — not a generic label', async () => {
    // FOUND BY RENDERING, not by reading the code: the seeded HR administrator — the very persona this
    // item was raised for — is a real person (`app_user.person_id` set) who was never hired into a
    // company, so every employment-shaped read answers null for them. An earlier draft of this component
    // showed them "Platform account". A leaver whose login still resolves lands in the same state.
    const { container } = wrap(<UserMenu name="HR Admin" employeeCode={null} employed={false} />);
    const t = trigger(container);
    expect(t).toHaveTextContent('HR Admin');
    expect(t).not.toHaveTextContent('Platform account');
    await userEvent.click(t);
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('HR Admin');
    expect(menu).toHaveTextContent('No employee record');
    // No employment, so /me has nothing to show them.
    expect(within(menu).queryByRole('menuitem', { name: 'View my profile' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
    expect(blankElements(container)).toEqual([]);
  });

  it('a login attached to NO person at all still gets a readable corner', async () => {
    // session.personId is null: there is no person row to name, and app_user carries neither a name nor
    // an email, so a localized label beside a neutral glyph is the whole of what can honestly be shown.
    const { container } = wrap(<UserMenu name={null} employeeCode={null} employed={false} />);
    const t = trigger(container);
    expect(t).toHaveTextContent('Platform account');
    expect((t.textContent ?? '').trim()).not.toBe('');
    await userEvent.click(t);
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Platform account');
    expect(menu).toHaveTextContent('No employee record');
    // /me would only tell them they are not linked to an employee record, which the menu just said.
    expect(within(menu).queryByRole('menuitem', { name: 'View my profile' })).toBeNull();
    // Log out is the one thing such an account must still be able to do.
    expect(within(menu).getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
    expect(blankElements(container)).toEqual([]);
  });
});

describe('fbf6abd0 — the account corner is translated in all six locales', () => {
  const LOCALES: [string, Record<string, unknown>][] = [
    ['en', en as never],
    ['ms', ms as never],
    ['ta', ta as never],
    ['th', th as never],
    ['vi', vi_ as never],
    ['zh', zh as never],
  ];

  it.each(LOCALES)('%s renders every label from its own catalog', async (locale, messages) => {
    const topbar = (messages as { topbar: Record<string, string> }).topbar;
    // Real translations, not English copied through: only `en` may equal the English string.
    if (locale !== 'en') {
      expect(topbar.platformAccount).not.toBe('Platform account');
      expect(topbar.viewProfile).not.toBe('View my profile');
      expect(topbar.signedInAs).not.toBe('Signed in as');
      expect(topbar.noEmployeeRecord).not.toBe('No employee record');
    }
    // The employed case first (the profile link only exists here), then the fallback.
    const { container, unmount } = wrap(
      <UserMenu name="Nurul Aisyah binti Karim" employeeCode="EMP-2201" employed />,
      locale,
      messages,
    );
    await userEvent.click(trigger(container));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent(topbar.signedInAs);
    expect(menu).toHaveTextContent(topbar.employeeIdLabel);
    expect(menu).toHaveTextContent('EMP-2201'); // a value: identical in every locale
    expect(within(menu).getByRole('menuitem', { name: topbar.viewProfile })).toBeInTheDocument();
    unmount();

    const fallback = wrap(<UserMenu name={null} employeeCode={null} employed={false} />, locale, messages);
    expect(trigger(fallback.container)).toHaveTextContent(topbar.platformAccount);
    await userEvent.click(trigger(fallback.container));
    expect(screen.getByRole('menu')).toHaveTextContent(topbar.noEmployeeRecord);
  });
});
