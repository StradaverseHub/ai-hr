import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, btnGhost, btnPrimary } from '@/components/ui';
import { jobAgencyContracts, RecruitmentError, REQUIREMENTS_MAX } from '@/packs/recruitment/service';
import { assignAgencyContractAction, removeAgencyAssignmentAction, updateAgencyAssignmentAction } from '../actions';
import { Pill, selectCls, textareaCls } from '../shared';

/**
 * Position › Job settings › Agencies (slice 10, EV-045 "Post to agency/RPO"): the contracts this job is released to, with
 * requirements for the agency. The job's recruiter and administrators assign contracts usable today (Public, or Restricted
 * with them listed) and change or remove assignments; the job's assistants read them. Removing an assignment stops new
 * submissions; those already recorded stay. Nobody else sees this section (the service refuses; nothing renders).
 */
export async function AgencyAssignmentSection({ s, jobId, here }: { s: SessionContext; jobId: string; here: string }) {
  const data = await jobAgencyContracts(s, jobId).catch((e) => { if (e instanceof RecruitmentError) return null; throw e; });
  if (!data) return null;
  const t = await getTranslations('recruitment.agency');
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <section aria-labelledby="agency-assign-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div>
        <h2 id="agency-assign-title" className="text-sm font-semibold">{t('jobTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('jobNote')}</p>
      </div>
      {data.assigned.length === 0 ? <p className="text-sm text-muted-foreground">{t('noAssignments')}</p> : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.assigned.map((a) => (
            <li key={a.id} className="space-y-2 px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{a.agencyName} · {a.contractName} <span className="text-xs font-normal text-muted-foreground">({t(`types.${a.contractType}`)})</span></p>
                <Pill tone={a.usableToday ? 'good' : 'warn'}>{a.usableToday ? t('usable') : t('notUsable')}</Pill>
              </div>
              {data.canAssign ? (
                <div className="flex flex-wrap items-end gap-2">
                  <form action={updateAgencyAssignmentAction} className="flex flex-1 flex-wrap items-end gap-2">
                    {hidden('assignmentId', a.id)}{hidden('returnTo', here)}
                    <Field label={t('requirements')} className="min-w-64 flex-1">
                      <textarea name="requirements" defaultValue={a.requirements ?? ''} maxLength={REQUIREMENTS_MAX} rows={2} className={textareaCls} />
                    </Field>
                    <button type="submit" className={btnGhost}>{t('save')}</button>
                  </form>
                  <form action={removeAgencyAssignmentAction}>
                    {hidden('assignmentId', a.id)}{hidden('returnTo', here)}
                    <button type="submit" className="text-sm text-destructive hover:underline">{t('removeAssignment')}</button>
                  </form>
                </div>
              ) : a.requirements && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{a.requirements}</p>}
            </li>
          ))}
        </ul>
      )}
      {data.canAssign && (data.available.length === 0 ? <p className="text-xs text-muted-foreground">{t('noneAvailable')}</p> : (
        <form action={assignAgencyContractAction} className="grid gap-3 border-t border-border pt-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          {hidden('jobId', jobId)}{hidden('returnTo', here)}
          <Field label={t('contract')}>
            <select name="contractId" required defaultValue="" className={selectCls}>
              <option value="" disabled>{t('choose')}</option>
              {data.available.map((c) => <option key={c.contractId} value={c.contractId}>{c.label}</option>)}
            </select>
          </Field>
          <Field label={t('requirements')}><textarea name="requirements" maxLength={REQUIREMENTS_MAX} rows={2} className={textareaCls} /></Field>
          <button type="submit" className={btnPrimary}>{t('assign')}</button>
        </form>
      ))}
    </section>
  );
}
