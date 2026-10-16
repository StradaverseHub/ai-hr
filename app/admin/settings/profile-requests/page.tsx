import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import {getSetting} from '@/core/entitlements';
import {essVisibleFields,resolveEssEditableIds,resolveEssPrimaryEditableIds} from '@/lib/personnel-ess-contract';
import {ESS_PROFILE_TABS} from '@/lib/personnel-ess-model';
import {personnelFieldLabel} from '@/lib/personnel-field-label';
import { pendingProfileChangeCountsByKey } from '@/core/profile';
import { profileChangeAllowedKeys, profileChangeApprover } from '@/core/tenant-settings';
import {
  PROFILE_REQUEST_APPROVERS,
  requestableFieldsForTab,
  type RequestableField,
} from '@/lib/profile-requestable-fields';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, pageWideCls } from '@/components/ui';
import { saveProfileRequestApproverAction, saveProfileRequestFieldsAction } from './actions';

/**
 * ── r261 · STAGE THREE OF BOARD ITEM 9583deac: THE TWO SETTINGS ─────────────────────────────────────
 *
 * The approved plan promises the reporter exactly two things in stage three, and this screen is both:
 *
 *   · "A setting that controls, field by field, which information an employee may ask to change."
 *   · "A setting that controls who approves …"
 *
 * The approval SCREEN itself — the current value beside the requested one, Approve and Reject, and a
 * reason required to reject — shipped in stage two (r260) on /approvals and on the Personnel record.
 * What was missing was the two decisions in front of it, and they are here.
 *
 * ── FIELD BY FIELD, NOT TAB BY TAB ──────────────────────────────────────────────────────────────────
 * The plan's build note is explicit that the reporter asked for per-FIELD control, so the grid below is
 * one row per declared field, grouped by the tab it is read on purely so a reader can find it. The keys
 * are `lib/profile-requestable-fields.ts`'s own — the same keys the request stores, the same keys the
 * approver's queue names, and each labelled by the SAME `people.detail.*` catalogue entry Personnel
 * Management prints it under. There is no second vocabulary anywhere on this screen.
 *
 * ── WHY IT SHOWS "n WAITING" BESIDE A FIELD ─────────────────────────────────────────────────────────
 * Switching a field off REJECTS every request already waiting on it, with a reason the employee reads on
 * their own screen (core/profile.ts `withdrawProfileChangesForLockedFields` — its header carries the
 * whole argument). That is a consequence somebody should see BEFORE they press the button and not only
 * in the toast afterwards, so each field carries the number of requests currently waiting on it. Counts
 * only: whose request, and what they asked for, is not this screen's business.
 *
 * ── READ IS ADMIN, WRITE IS GROUP ADMIN ─────────────────────────────────────────────────────────────
 * Mirrors 0313's `tenant_setting_write` exactly as the agent switchboard does: a company-scoped admin
 * sees the configuration and is told plainly that it is not theirs to change, rather than being handed a
 * control that fails when pressed.
 */
export default async function ProfileRequestSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('profileRequestSettings');
  // Personnel Management's own field labels. The one and only wording for these fields, on every screen.
  const tp = await getTranslations('people.detail');
  const sp = await searchParams;

  /**
   * ⚠️ THIS SCREEN KEEPS THE THROWING READ, AND IT IS THE ONE PLACE UNDER app/ THAT SHOULD (r261 fix
   * pass). /me and /approvals read these two settings the QUIET way — they DISPLAY a decision, so during
   * an entitlement outage they degrade closed and keep rendering. This form is different in kind: the
   * ticked boxes ARE the stored value, and `saveProfileRequestFieldsAction` posts back exactly what is
   * shown. A degraded read here would render every box unticked, and one press of Save would write "an
   * employee may ask to change nothing" as a real configuration — an incident turned into a customer
   * decision nobody made. The action itself has the same reason: it reads the CURRENT allow-list to work
   * out which fields are being switched off, and a quiet `[]` there would withdraw nothing while
   * reporting success. So an unreadable snapshot fails loudly on this screen, which is reachable only by
   * an administrator and never by an employee.
   */
  const raw=getSetting(s,'ess.profile_change_fields');
  const allowed=resolveEssEditableIds(raw),primaryAllowed=resolveEssPrimaryEditableIds(raw);
  const legacyAllowed=profileChangeAllowedKeys(s);
  const te=await getTranslations('essProfile');
  const labels=await getTranslations();
  const tabKeys=['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification','others'];
  const approver = profileChangeApprover(s);
  const pendingByKey = await pendingProfileChangeCountsByKey(s);
  const mayWrite = isGroupAdmin(s);


  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('description')} />

      <ErrorBanner message={sp.error} />
      {sp.toast ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
          {sp.toast}
        </div>
      ) : null}

      {!mayWrite && <Card className="p-4 text-sm text-muted-foreground">{t('readOnlyNotice')}</Card>}

      {/* ── WHO APPROVES ───────────────────────────────────────────────────────────────────────────
          Two options and no third, because the plan sold SINGLE-LEVEL approval and the reporter
          approved it as written. Neither option lets anybody decide their own request, and neither
          shows one employee another employee's request — both are properties of the services, not of
          this form, and both are tested adversarially. */}
      <Card className="p-5">
        <SectionHeader title={t('approverHeading')} />
        <p className="mt-1 text-xs text-muted-foreground">{t('approverHelp')}</p>
        <form action={saveProfileRequestApproverAction} className="mt-4 space-y-3">
          {PROFILE_REQUEST_APPROVERS.map((option) => (
            <label key={option} className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
              <input
                type="radio"
                name="approver"
                value={option}
                defaultChecked={approver === option}
                disabled={!mayWrite}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block font-medium">{t(`approverOption.${option}`)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t(`approverOptionHelp.${option}`)}
                </span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">{t('singleLevelNote')}</p>
          {mayWrite ? (
            <button type="submit" className={btnPrimary}>
              {t('saveApprover')}
            </button>
          ) : null}
        </form>
      </Card>

      {/* ── WHICH FIELDS ───────────────────────────────────────────────────────────────────────────
          One checkbox per DECLARED field. A field left unticked renders no control at all on the
          employee's own screen — not a disabled one — and a POST naming it is dropped by the service. */}
      <Card className="p-5">
        <SectionHeader title={t('fieldsHeading')} />
        <p className="mt-1 text-xs text-muted-foreground">{t('fieldsHelp')}</p>
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          {t('lockWithdrawsNotice')}
        </p>
        <form action={saveProfileRequestFieldsAction} className="mt-4 space-y-5">
          {ESS_PROFILE_TABS.map((tab,index)=>(
            <div key={tab}>
              <h3 className="text-sm font-semibold">{tp(`tabs.${tabKeys[index]}`)}</h3>
              <div className="mt-2 divide-y divide-border">
              {essVisibleFields().filter(field=>field.tab===tab).map(field=>{
                const editable=Boolean(field.ess.binding&&['immediate','approval'].includes(field.ess.edit));
                const waiting=(pendingByKey.get(field.id)??0)+(field.ess.binding?.legacyKey?pendingByKey.get(field.ess.binding.legacyKey)??0:0);
                return <div key={field.id} className="flex flex-wrap items-center gap-3 py-2">
                  <label htmlFor={`permission-${field.id}`} className="min-w-0 flex-1 text-sm">{personnelFieldLabel(field,(key,fallback)=>labels.has(key)?labels(key):fallback)}</label>
                  {waiting>0&&<span className="text-xs text-amber-700 dark:text-amber-300">{t('waitingCount',{count:waiting})}</span>}
                  {editable?<select id={`permission-${field.id}`} name={`permission:${field.id}`} disabled={!mayWrite} defaultValue={allowed.has(field.id)?'editable':primaryAllowed.has(field.id)?'primaryOnly':'viewOnly'} className="rounded-md border border-border bg-background px-2 py-1 text-sm">
                    <option value="viewOnly">{te('viewOnly')}</option>
                    <option value="editable">{te('editable')}</option>
                    {field.ess.legacyPrimaryKey&&<option value="primaryOnly">{te('primaryOnly')}</option>}
                  </select>:<span className="text-xs text-muted-foreground">{field.ess.edit==='specialist'?te('workflowOnly'):te('viewOnly')}</span>}
                </div>;
              })}
              </div>
            </div>
          ))}
          {mayWrite ? (
            <button type="submit" className={btnPrimary}>
              {t('saveFields')}
            </button>
          ) : null}
        </form>
      </Card>
    </div>
  );
}
