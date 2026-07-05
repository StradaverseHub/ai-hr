import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MATRIX_ROLES, SCREENS, canReach, type Role, type ScreenEntry } from '@/lib/permissions';

/**
 * The Function Access reference grid (rows = roles, columns = screens). Pure presentational: the page
 * resolves all i18n labels/notes and passes them in, so this component pulls no translations itself and
 * stays trivially reusable. Access truth comes from lib/permissions (canReach) — this only draws it.
 *
 * Honesty guardrails (see lib/permissions header): the grid shows page-level REACHABILITY only, plus a
 * per-screen `scopeNote` where data visibility is narrower than "can open". It never renders a
 * per-action (View/Create/Edit/Delete/Approve) breakdown the system does not enforce.
 */
export function FunctionAccessGrid({
  roleLabel,
  screenLabel,
  scopeNote,
  labels,
}: {
  /** role enum value -> translated role label */
  roleLabel: (role: Role) => string;
  /** screen -> translated column label */
  screenLabel: (screen: ScreenEntry) => string;
  /** screen -> translated scope note (or null when none authored) */
  scopeNote: (screen: ScreenEntry) => string | null;
  /** static UI strings resolved by the caller */
  labels: { accessible: string; notAccessible: string; screenColumn: string };
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
              {labels.screenColumn}
            </th>
            {MATRIX_ROLES.map((role) => (
              <th
                key={role}
                scope="col"
                className="px-3 py-2.5 text-center text-xs font-medium capitalize text-muted-foreground"
              >
                {roleLabel(role)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SCREENS.map((screen) => {
            const note = scopeNote(screen);
            return (
              <tr key={screen.screenKey} className="border-t border-border">
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-t border-border bg-card px-4 py-2.5 text-left align-top font-normal"
                >
                  <div className="font-medium text-foreground">{screenLabel(screen)}</div>
                  {note && <div className="mt-0.5 max-w-xs text-[11px] leading-snug text-muted-foreground">{note}</div>}
                </th>
                {MATRIX_ROLES.map((role) => {
                  const ok = canReach(role, screen);
                  return (
                    <td key={role} className="border-t border-border px-3 py-2.5 text-center align-top">
                      <span
                        title={ok ? labels.accessible : labels.notAccessible}
                        className={cn(
                          'inline-flex size-6 items-center justify-center rounded-full',
                          ok
                            ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                            : 'bg-muted text-muted-foreground/50',
                        )}
                      >
                        {ok ? <Check className="size-3.5" strokeWidth={2.5} /> : <Minus className="size-3.5" />}
                        <span className="sr-only">{ok ? labels.accessible : labels.notAccessible}</span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
