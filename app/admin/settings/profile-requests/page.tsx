import Link from 'next/link';
import {listEmployees} from '@/core/read';
import {profileRuleApprovers} from '@/lib/profile-routing-policy';
import {readProfileRoutingPolicy} from '@/core/profile-routing';
import {PermissionMatrix} from './permission-matrix';
import {profileVisibilityFingerprint} from '@/lib/profile-policy-fingerprint';
import {isProfileVisibilityPolicyValue,profileFieldApproval} from '@/lib/profile-edit-policy-value';
import {resolveEssVisibleIds,linkedEssFieldIds} from '@/lib/personnel-ess-visibility';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import {getSetting} from '@/core/entitlements';
import {essVisibleFields,resolveEssEditableIds,resolveEssPrimaryEditableIds} from '@/lib/personnel-ess-contract';
import {ESS_PROFILE_TABS,PERSONNEL_ESS_SECTION_LABEL_KEYS} from '@/lib/personnel-ess-model';
import {personnelFieldLabel} from '@/lib/personnel-field-label';
import { pendingProfileChangeCountsByKey } from '@/core/profile';
import { profileChangeApprover } from '@/core/tenant-settings';

import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, pageWideCls } from '@/components/ui';
import { saveProfileRequestFieldsAction,saveOwnPhotoSettingAction } from './actions';

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
  const allowed=resolveEssEditableIds(raw),primaryAllowed=resolveEssPrimaryEditableIds(raw),visible=resolveEssVisibleIds(raw);
  const routing=readProfileRoutingPolicy(s),routingEmployees=routing.rules.length?await listEmployees(s):[];
  const approverNames=new Map(routingEmployees.map(employee=>[employee.employmentId,`${employee.employeeCode} · ${employee.name}`]));
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

      <Card className="p-5"><SectionHeader title={te('approvalRules')}/><p className="mt-2 text-sm text-muted-foreground">{te('photoEditHelp')}</p><form action={saveOwnPhotoSettingAction} className="mt-4 space-y-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={getSetting(s,'ess.profile_photo_edit')===true} disabled={!mayWrite}/>{te('allowOwnPhoto')}</label>{mayWrite&&<button type="submit" className={btnPrimary}>{te('savePhotoPermission')}</button>}</form>

      <div className="mt-5 space-y-3 border-t border-border pt-5"><SectionHeader title={te('namedRouting')}/><p className="text-sm text-muted-foreground">{te('anyApprover')}</p><ul className="list-inside list-disc text-sm">{routing.rules.map(rule=><li key={rule.id}>{rule.name}: {profileRuleApprovers(rule).map(id=>approverNames.get(id)??te('unavailableSelection')).join(', ')}</li>)}</ul><Link href="/admin/settings/profile-requests/rules" className={btnPrimary}>{te('manageApprovalRules')}</Link></div>

      <p className="border-t border-border pt-4 text-sm text-muted-foreground">{te('approvalAuthorityFloor')}: {t(`approverOption.${approver}`)}</p></Card>

      {/* ── WHICH FIELDS ───────────────────────────────────────────────────────────────────────────
          One checkbox per DECLARED field. A field left unticked renders no control at all on the
          employee's own screen — not a disabled one — and a POST naming it is dropped by the service. */}
      <Card className="p-5">
        <SectionHeader title={t('fieldsHeading')} />
        <p className="mt-1 text-xs text-muted-foreground">{t('fieldsHelp')}</p>
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          {t('lockWithdrawsNotice')}
        </p>
        <form action={saveProfileRequestFieldsAction} className="mt-4 space-y-5"><input type="hidden" name="policyFingerprint" value={profileVisibilityFingerprint(raw)}/>
          <PermissionMatrix disabled={!mayWrite} groups={isProfileVisibilityPolicyValue(raw)&&raw.version!==3?{...raw.groups}:{}} rows={essVisibleFields().map(field=>({linked:linkedEssFieldIds(field.id),id:field.id,tab:field.tab,section:field.section,tabLabel:tp(`tabs.${tabKeys[ESS_PROFILE_TABS.indexOf(field.tab as typeof ESS_PROFILE_TABS[number])]}`),label:personnelFieldLabel(field,(key,fallback)=>labels.has(key)?labels(key):fallback),group:`${tp(`tabs.${tabKeys[ESS_PROFILE_TABS.indexOf(field.tab as typeof ESS_PROFILE_TABS[number])]}`)} · ${PERSONNEL_ESS_SECTION_LABEL_KEYS[field.section]?tp(PERSONNEL_ESS_SECTION_LABEL_KEYS[field.section]):field.section}`,approval:profileFieldApproval(raw,field),canEdit:Boolean(field.ess.binding&&['immediate','approval'].includes(field.ess.edit)),permission:isProfileVisibilityPolicyValue(raw)?raw.fields[field.id]??'hide':!visible.has(field.id)?'hide':allowed.has(field.id)?'editable':'viewOnly',primaryOnly:isProfileVisibilityPolicyValue(raw)?raw.primaryOnly.includes(field.id):primaryAllowed.has(field.id),waiting:(pendingByKey.get(field.id)??0)+(field.ess.binding?.legacyKey?pendingByKey.get(field.ess.binding.legacyKey)??0:0)}))} labels={{matrixRegion:te('permissionMatrixRegion'),matrixScrollHelp:te('permissionMatrixScrollHelp'),editable:te('editable'),viewOnly:te('viewOnly'),hide:te('hide'),field:te('field'),all:te('selectAll'),primaryOnly:te('primaryOnly'),primaryApprovalRequiresEditable:te('primaryApprovalRequiresEditable'),waiting:te('waiting'),groupHelp:te('groupPermissionHelp'),tabPermission:te('tabPermission'),sectionPermission:te('sectionPermission'),approvalRequired:te('approvalRequired'),attachment:te('attachmentRequirement'),attachmentRequired:te('requiredAttachedFile'),attachmentOptional:te('notRequiredAttachedFile')}}/>
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
