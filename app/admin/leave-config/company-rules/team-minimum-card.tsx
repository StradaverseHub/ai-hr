import { getTranslations } from 'next-intl/server';

import { Button, Card, Input, SectionHeader } from '@/components/ui';
import type { LeaveTeamMinimumRow } from '@/packs/leave/service';
import { setLeaveTeamMinimumAction } from '../../actions';

/**
 * Owner decision 12 November 2026 — the per-company "minimum people present" leave setting (draft migration 9770,
 * core/leave-team-minimum.ts), one row per company the administrator administers.
 *
 * The leave recommendation an approver sees (on Approvals and Manager Today) checks each day of a request against it
 * and names the days on which approving would leave fewer people of the employee's team present. It never decides or
 * blocks a request. An empty box means no minimum, and the recommendation then works exactly as before.
 *
 * SERVER COMPONENT with plain forms: each row posts its own company id and box, so a save never touches another
 * company. The action authorizes, saves and records the change in one transaction and returns here.
 */
export async function LeaveTeamMinimumCard({ rows }: { rows: readonly LeaveTeamMinimumRow[] }) {
  const t = await getTranslations('admin.leaveConfigCompanyRules.teamMinimum');
  return (
    <Card data-tour="leave-team-minimum" data-leave-team-minimum>
      <SectionHeader title={t('title')} count={rows.length} />
      <div className="space-y-1 px-4 pt-3 text-xs text-muted-foreground">
        <p>{t('help')}</p>
        <p>{t('teamHelp')}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            const inputId = `team-minimum-${row.companyId}`;
            return (
              <li key={row.companyId} className="px-4 py-3">
                <form action={setLeaveTeamMinimumAction} className="flex flex-wrap items-end gap-4" data-team-minimum-company={row.companyId}>
                  <input type="hidden" name="companyId" value={row.companyId} />
                  <span className="min-w-[10rem] flex-1 truncate self-center text-sm font-medium text-foreground">{row.name}</span>
                  <div className="grid gap-1">
                    <label htmlFor={inputId} className="text-xs text-muted-foreground">
                      {t('label')}
                    </label>
                    <Input
                      id={inputId}
                      name="minimum"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={10000}
                      step={1}
                      defaultValue={row.minimum ?? ''}
                      className="w-32"
                    />
                  </div>
                  <Button type="submit" size="sm" variant="secondary">
                    {t('save')}
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
