'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown, UserRound } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { LogoutButton } from '@/components/logout-button';
import { cn } from '@/lib/utils';

/**
 * WHO IS SIGNED IN — the topbar's account corner (feedback fbf6abd0).
 *
 * The reporter's complaint was that nothing on any screen says which account you are working under, and
 * that it matters most for an HR administrator, who spends the day inside other people's records. So the
 * name and the Employee ID are ALWAYS ON THE PAGE, not only inside the menu: the menu exists to hold the
 * profile link and Log out (which moved here from beside the theme toggle) without crowding the header.
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
 *   3. NOT employed but NAMED → their own name, the menu adds "No employee record", and THE PROFILE LINK
 *      IS HIDDEN (/me would only tell them they are not linked, which the menu already said). This is a
 *      seeded HR administrator who was never hired into a company, and equally a leaver whose login
 *      still resolves — a named human either way, so labelling them "Platform account" would be wrong.
 *      A dev-server render is what surfaced this case; it is not hypothetical.
 *   4. NOT employed and NOT named (`name == null`) → a login attached to no person at all. `app_user`
 *      carries neither name nor email, so there is nothing to show but the localized "Platform account"
 *      beside a neutral glyph.
 * In every case the corner renders a real, readable control — never an empty span, and never nothing.
 *
 * ── NARROW WINDOWS ────────────────────────────────────────────────────────────────────────────────────
 * The NAME gives way below `md` and the avatar + Employee ID remain, so the identification never
 * disappears entirely; the full pair is one click away in the menu. With no ID to keep (cases 2-4) the
 * whole text column drops instead of leaving a zero-width flex item behind the header's gap.
 *
 * ── IT IS A FLEX ITEM OF THE RIGHT CLUSTER (overlap guard d9b81f8d) ───────────────────────────────────
 * min-w-0 on the wrapper + max-w-full on the trigger + truncating labels: this control compresses
 * instead of spilling leftward over the centre search track. test/topbar-overlap-guard.test.ts pins it.
 */

/** The signed-in person's own profile screen — the same route the sidebar's "My Profile" row opens. */
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
  // Only case 1 has a value to keep in the corner on a narrow window.
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
        <span className={cn('flex min-w-0 flex-col leading-tight', !code && 'hidden md:flex')}>
          <span className="hidden max-w-[10rem] truncate text-xs font-semibold text-foreground md:block">
            {displayName}
          </span>
          {code && (
            <span className="max-w-[10rem] truncate text-[11px] font-medium text-muted-foreground">{code}</span>
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
            {employed && (
              <Link
                href={PROFILE_HREF}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                {t('viewProfile')}
              </Link>
            )}
            <LogoutButton variant="menu" />
          </div>
        </>
      )}
    </div>
  );
}
