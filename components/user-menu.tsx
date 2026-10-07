'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown, UserRound } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { LogoutButton } from '@/components/logout-button';
import { TourLauncher } from '@/components/tour-launcher';
import { UiThemeSwitcher } from '@/components/ui-theme-switcher';
import { cn } from '@/lib/utils';

/**
 * WHO IS SIGNED IN — the topbar's account corner (feedback fbf6abd0).
 *
 * The reporter's complaint was that nothing on any screen says which account you are working under, and
 * that it matters most for an HR administrator, who spends the day inside other people's records. So the
 * name and the Employee ID are ALWAYS ON THE PAGE, not only inside the menu: the menu exists to hold the
 * profile link, the tour launcher and Log out (all of which moved here) without crowding the header.
 *
 * ── PROPS ARE ALREADY-RESOLVED VALUES, DELIBERATELY ───────────────────────────────────────────────────
 * `name` / `employeeCode` / `employed` come from `lib/viewer.ts`, i.e. the signed-in person's own
 * employment and person rows, resolved on the server. This component takes strings and a boolean and no
 * session, so it can be rendered in a DOM test exactly as the shell renders it, and so nothing
 * session-shaped is dragged into the client bundle.
 *
 * ── THE FOUR CASES, ALL NAMED, NONE OF THEM BLANK ─────────────────────────────────────────────────────
 *   1. employed, with an Employee ID → name over the ID. The ordinary case.
 *   2. employed, NO Employee ID → name alone in the corner; the menu says "No Employee ID" rather than
 *      printing an empty line. `employment.employee_code` is nullable, so this is reachable in real data.
 *   3. NOT employed but NAMED → their own name, and the menu adds "No employee record". This is a seeded
 *      HR administrator who was never hired into a company, and equally a leaver whose login still
 *      resolves — a named human either way, so labelling them "Platform account" would be wrong. A
 *      dev-server render is what surfaced this case; it is not hypothetical.
 *   4. NOT employed and NOT named (`name == null`) → a login attached to no person at all. `app_user`
 *      carries neither name nor email, so there is nothing to show but the localized "Platform account"
 *      beside a neutral glyph.
 * In every case the corner renders a real, readable control — never an empty span, and never nothing.
 *
 * ── THE PROFILE LINK IS UNCONDITIONAL, AND THAT IS THE FIX, NOT THE OVERSIGHT ─────────────────────────
 * It was first gated on `employed`, on the reasoning that /me would only tell an unlinked account it is
 * not linked. But the LEFT RAIL already offers "My workspace" → /me to every viewer, so gating it here
 * made two surfaces disagree about the same route for the same person — and the persona this item was
 * raised for (the seeded HR administrator: a person row, no employment) was exactly the one the corner
 * withheld it from. /me answers the unlinked case with a written explanation, which is a better
 * destination than a menu that quietly has one fewer row than the rail promised.
 *
 * ── NARROW WINDOWS: ONE LINE, NEVER ZERO ──────────────────────────────────────────────────────────────
 * Below `md` the column keeps exactly ONE line: the Employee ID when there is one (it is the shorter,
 * more precise identifier and the avatar already carries the initials), otherwise the name — or, in case
 * 4, the "Platform account" label, which is the only identifying text a login with no person behind it
 * has. It used to keep NONE for cases 2-4, so an account with no Employee ID showed two initials and an
 * arrow. The pair is one click away in the menu at every width.
 *
 * ⚠️ THAT IS THE RULE; BELOW md THERE IS CURRENTLY NO ROOM FOR IT, and the rule is not a claim that
 * there is. Measured at 390px: the header's right track is 129px while the bell + language + theme
 * buttons alone want 124px and the account pill wants 65 more — the cluster is ~65px over capacity
 * before the identity is given a single pixel, so every text line in it renders at zero width and the
 * trigger itself is squeezed to 14px. That is a header with no narrow-window design rather than a class
 * to tweak (the rail is 232px from `sm` up; the search track is 320px at 768), it predates this feature,
 * and r256 improved it by ~80px by taking two controls out of the cluster without curing it. It needs
 * its own item. What this rule buys today is that nothing has to change here when that item lands.
 *
 * ── IT IS THE ONE COMPRESSIBLE CHILD OF THE RIGHT CLUSTER (overlap guard d9b81f8d) ────────────────────
 * min-w-0 on the wrapper + max-w-full on the trigger + truncating labels: this control compresses
 * instead of spilling leftward over the centre search track. That is also why the header had to make
 * ROOM for it rather than trust the classes — being compressible is what let it compress to nothing.
 * r256 measured the corner in a real browser and found the name and the Employee ID at ZERO width on
 * every laptop-class viewport (0px of 87 needed at 1280 and 1440; whole only at 1920), because the
 * cluster it lives in was already saturated. The fix is the header's, not this file's: the
 * CompanySwitcher moved to the left cluster and the TourLauncher into this menu, and the centre search
 * track gave back 64px below 2xl. test/topbar-identity-width.browser.test.tsx re-measures it at 1280
 * and 1440 in real Chromium with real Tailwind, and test/topbar-overlap-guard.test.ts pins the child
 * list of the cluster so a new control cannot arrive without a fresh measurement.
 */

/** The signed-in person's own profile screen — the same route the sidebar's "My workspace" row opens. */
export const PROFILE_HREF = '/me';

export function UserMenu({
  name,
  employeeCode,
  employed,
}: {
  name: string | null;
  employeeCode: string | null;
  employed: boolean;
}) {
  const t = useTranslations('topbar');
  const [open, setOpen] = useState(false);

  // Escape closes, as it does for every other popover chrome in the header.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const named = name != null && name.trim() !== '';
  const displayName = named ? name!.trim() : t('platformAccount');
  // Only case 1 has an Employee ID to show.
  const code = employed && employeeCode != null && employeeCode.trim() !== '' ? employeeCode.trim() : null;

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('accountMenu')}
        data-tour="account"
        className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-2 text-left transition duration-150 ease-snappy hover:bg-muted active:scale-[0.98]"
      >
        {named ? (
          <Avatar name={displayName} className="size-7" />
        ) : (
          // No person, so no initials to derive: a neutral glyph rather than a blank circle or a letter
          // taken from a translated label (which would differ in each of the six locales).
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
            <UserRound className="size-4" aria-hidden="true" />
          </span>
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          {/* Below md the name yields ONLY when the Employee ID is there to take its place. With no code
              (cases 2-4) the name — or the "Platform account" label — is the one identifying string that
              exists, so it stays at every width; hiding it left a login with no employment showing two
              initials and nothing else. The narrow ceiling is tighter than the wide one for the same
              reason the whole control is min-w-0: it truncates, it never sets a width floor. */}
          <span
            className={cn(
              'max-w-[7rem] truncate text-xs font-semibold text-foreground md:max-w-[10rem]',
              code && 'hidden md:block',
            )}
          >
            {displayName}
          </span>
          {code && (
            <span className="max-w-[7rem] truncate text-[11px] font-medium text-muted-foreground md:max-w-[10rem]">
              {code}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-snappy',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={t('accountMenu')}
            className="absolute right-0 z-50 mt-1 w-64 origin-top-right scale-100 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground opacity-100 shadow-lg transition duration-150 ease-snappy starting:scale-95 starting:opacity-0"
          >
            <div className="px-2 py-1.5">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('signedInAs')}
              </div>
              <div className="mt-0.5 truncate text-sm font-semibold text-foreground">{displayName}</div>
              {/* The label is translated; the code is a VALUE and is never translated. */}
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {code ? (
                  <>
                    {t('employeeIdLabel')} <span className="font-medium text-foreground">{code}</span>
                  </>
                ) : employed ? (
                  t('noEmployeeId')
                ) : (
                  t('noEmployeeRecord')
                )}
              </div>
            </div>
            <div className="my-1 h-px bg-border" />
            <Link
              href={PROFILE_HREF}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              {t('viewProfile')}
            </Link>
            {/* Moved out of the header (r256) so the corner has room to say who you are on a laptop. */}
            <TourLauncher variant="menu" onSelect={() => setOpen(false)} />
            {/* r396 — the UI theme (Monolith | Classic). Here, not in the header: the right cluster is a
                full, measured budget, and light/dark keeps its own header button. */}
            <div className="my-1 h-px bg-border" />
            <UiThemeSwitcher />
            <div className="my-1 h-px bg-border" />
            <LogoutButton variant="menu" />
          </div>
        </>
      )}
    </div>
  );
}
