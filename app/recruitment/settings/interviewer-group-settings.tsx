import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { GROUP_MEMBERS_MAX, GROUP_NAME_MAX, GROUPS_MAX, interviewerGroupSettings, type InterviewerGroupSettings } from '@/packs/recruitment/service';
import { deleteInterviewerGroupAction, saveInterviewerGroupFormAction } from '../actions';
import { ActionForm, FieldProblem } from '../action-form';
import { Pill, klDateTime } from '../shared';

/**
 * Settings › Interviewer groups (slice 18, administrators): named lists of people who interview together. When scheduling or adding
 * interviewers, "Add group" adds each current member once as an individual interviewer; the group gives nobody access and is not
 * kept on the interview, so editing a group later changes no interview. A member who has lost access to the company stays listed
 * (marked) and is skipped. Each form keeps what was typed when a save is refused.
 */
export async function InterviewerGroupSettingsSection({ s, companyId }: { s: SessionContext; companyId: string }) {
  const [t, locale, settings] = await Promise.all([getTranslations('recruitment.setup'), getLocale(), interviewerGroupSettings(s, companyId)]);
  const problem = { required: t('fieldRequired'), invalid: t('fieldInvalid') };
  const memberBoxes = (group: InterviewerGroupSettings['groups'][number] | null) => {
    const kept = group ? group.members.filter((m) => !settings.people.some((p) => p.id === m.userId)) : [];
    return (
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('groups.members', { max: GROUP_MEMBERS_MAX })}</legend>
        <div className="grid max-h-56 gap-1 overflow-y-auto text-sm sm:grid-cols-2 lg:grid-cols-3">
          {settings.people.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5">
              <input type="checkbox" name="memberIds" value={p.id} defaultChecked={!!group?.members.some((m) => m.userId === p.id)} className="accent-primary" />{p.name}
            </label>
          ))}
          {kept.map((m) => (
            <label key={m.userId} className="flex items-center gap-1.5 text-muted-foreground">
              <input type="checkbox" name="memberIds" value={m.userId} defaultChecked className="accent-primary" />{m.name ?? t('unnamedUser')} <Pill tone="warn">{t('groups.noAccess')}</Pill>
            </label>
          ))}
        </div>
        <FieldProblem name="memberIds" {...problem} />
      </fieldset>
    );
  };
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('groups.note')}</p>
      {settings.groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('groups.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {settings.groups.map((g) => (
            <li key={g.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{g.name}</span>
                  <span className="text-xs text-muted-foreground">{t('groups.memberCount', { count: g.members.length })} · {t('changedAt', { at: klDateTime(locale, g.updatedAt) })}</span>
                </summary>
                <ActionForm action={saveInterviewerGroupFormAction} className="mt-3 space-y-3">
                  <input type="hidden" name="groupId" value={g.id} /><input type="hidden" name="companyId" value={companyId} />
                  <Field label={t('groups.name')} required requiredAriaLabel={t('fieldRequired')}>
                    <Input name="name" defaultValue={g.name} maxLength={GROUP_NAME_MAX} required />
                    <FieldProblem name="name" {...problem} />
                  </Field>
                  {memberBoxes(g)}
                  <button type="submit" className={btnPrimary}>{t('save')}</button>
                </ActionForm>
              </details>
              <p className="text-xs text-muted-foreground">
                {g.members.length ? g.members.map((m) => `${m.name ?? t('unnamedUser')}${m.hasAccess ? '' : ` (${t('groups.noAccess')})`}`).join(', ') : t('groups.noMembers')}
              </p>
              <form action={deleteInterviewerGroupAction}>
                <input type="hidden" name="groupId" value={g.id} /><input type="hidden" name="companyId" value={companyId} />
                <button type="submit" className={btnGhost} aria-label={t('deleteNamed', { name: g.name })}>{t('delete')}</button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {settings.groups.length < GROUPS_MAX && (
        <ActionForm action={saveInterviewerGroupFormAction} className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('groups.newTitle')}</h2>
          <input type="hidden" name="companyId" value={companyId} />
          <Field label={t('groups.name')} required requiredAriaLabel={t('fieldRequired')}>
            <Input name="name" maxLength={GROUP_NAME_MAX} required />
            <FieldProblem name="name" {...problem} />
          </Field>
          {memberBoxes(null)}
          <button type="submit" className={btnPrimary}>{t('add')}</button>
        </ActionForm>
      )}
    </div>
  );
}
