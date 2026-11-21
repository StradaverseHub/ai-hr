'use server';

// Board 511aa74a — the Rehired event's two doors: record it (New Event) and roll it back (Employment History).
// Both go through requireAdmin and then core/rehire.ts, which re-checks the movement admin rule, Workforce
// maintain and the destination company inside its own transaction.
import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { publicErrorMessage } from '@/lib/public-error';
import { movementPageHref } from '@/lib/personnel-movement-navigation';
import { reprojectEntitlementForEmployment } from '@/packs/leave/service';
import { RehireError, rehireEmployment, rollBackRehire, type RehireRefusal } from '@/core/rehire';
import { WorkforceAccessError } from '@/core/workforce-access';

type Translator = (key: string, values?: Record<string, string>) => string;

/** Static keys only: every refusal has its own sentence in all six locales. */
function refusalText(t: Translator, code: RehireRefusal, detail: Record<string, string>): string {
  switch (code) {
    case 'permission': return t('error.permission');
    case 'type_inactive': return t('error.typeInactive');
    case 'not_resigned': return t('error.notResigned');
    case 'blacklisted': return t('error.blacklisted');
    case 'current_employment': return t('error.currentEmployment');
    case 'already_rehired': return t('error.alreadyRehired', { code: detail.code ?? '—' });
    case 'date_invalid': return t('error.dateInvalid');
    case 'date_not_after_end': return t('error.dateNotAfterEnd', { date: detail.date ?? '—' });
    case 'group_join_date_invalid': return t('error.groupJoinDateInvalid');
    case 'company_unavailable': return t('error.companyUnavailable');
    case 'department_required': return t('error.departmentRequired');
    case 'employment_type_invalid': return t('error.employmentTypeInvalid');
    case 'salary_invalid': return t('error.salaryInvalid');
    case 'employee_code_required': return t('error.employeeCodeRequired');
    case 'employee_code_not_allowed': return t('error.employeeCodeNotAllowed');
    case 'employee_code_invalid': return t('error.employeeCodeInvalid');
    case 'employee_code_taken': return t('error.employeeCodeTaken', { code: detail.code ?? '—' });
    case 'manager_invalid': return t('error.managerInvalid');
    case 'reason_required': return t('error.reasonRequired');
    case 'rollback_unavailable': return t('error.rollbackUnavailable');
    case 'rollback_blocked': return t('error.rollbackBlocked', { blockers: blockerText(t, detail.sources ?? '') });
  }
}

/** Name what blocks a Roll Back in HR words; an unrecognised table is named as recorded activity. */
function blockerText(t: Translator, sources: string): string {
  const words = new Set<string>();
  for (const source of sources.split(',').filter(Boolean)) {
    if (source.startsWith('payslip') || source.startsWith('payroll')) words.add(t('blocker.payroll'));
    else if (source.startsWith('attendance') || source.startsWith('clock') || source.startsWith('timesheet') || source.startsWith('roster')) words.add(t('blocker.attendance'));
    else if (source.startsWith('leave')) words.add(t('blocker.leave'));
    else if (source.startsWith('claim') || source.endsWith('request.employment_id') || source.startsWith('approval')) words.add(t('blocker.request'));
    else if (source === 'employment.lifecycle') words.add(t('blocker.lifecycle'));
    else if (source.startsWith('assignment') || source.startsWith('compensation')) words.add(t('blocker.movement'));
    else if (source.startsWith('reporting_line')) words.add(t('blocker.reports'));
    else words.add(t('blocker.other'));
  }
  return [...words].join(', ');
}

async function rehireMessage(e: unknown): Promise<string> {
  const t = (await getTranslations('people.detail.movement.rehire')) as unknown as Translator;
  if (e instanceof RehireError) return refusalText(t, e.code, e.detail);
  if (e instanceof WorkforceAccessError) return t('error.permission');
  return publicErrorMessage(e);
}

const text = (data: FormData, name: string) => {
  const v = data.get(name);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/** New Event → Rehired. On success the new period's Employment History opens. */
export async function rehireEmploymentAction(_state: string | null, data: FormData): Promise<string | null> {
  let created: { employmentId: string } | null = null;
  try {
    const s = await requireAdmin();
    const fromEmploymentId = String(data.get('employmentId') ?? '');
    const salary = (text(data, 'basicSalary') ?? '').replace(/[,_]/g, '');
    const mode = text(data, 'employeeIdMode');
    const result = await rehireEmployment(s, {
      fromEmploymentId,
      effectiveDate: text(data, 'effectiveDate') ?? '',
      groupJoinDate: text(data, 'hiredOn'),
      employeeIdMode: mode === 'auto' || mode === 'manual' ? mode : null,
      employeeCode: text(data, 'employeeCode'),
      companyId: text(data, 'companyId') ?? '',
      businessUnitId: text(data, 'businessUnitId'),
      departmentId: text(data, 'departmentId') ?? '',
      positionId: text(data, 'positionId'),
      gradeId: text(data, 'gradeId'),
      employmentType: text(data, 'employmentType') ?? '',
      basicSalary: salary === '' ? 0 : Number(salary),
      currency: text(data, 'currency'),
      managerEmploymentId: text(data, 'managerEmploymentId'),
      remarks: text(data, 'remarks'),
    });
    created = { employmentId: result.employmentId };
    // An earlier Group Join Date counts earlier service: re-resolve the opening entitlement band, as the
    // Group Join Date Correction movement does. Best-effort and idempotent (it re-runs on the next trigger).
    if (result.groupJoinDateEarlier) {
      try { await reprojectEntitlementForEmployment(s, { employmentId: result.employmentId, trigger: 'movement_recorded' }); } catch { /* non-fatal */ }
    }
    revalidatePath(`/admin/personnel/${fromEmploymentId}`);
  } catch (e) {
    unstable_rethrow(e);
    return rehireMessage(e);
  }
  redirect(movementPageHref(created!.employmentId, 'history'));
}

/** Employment History → Roll Back on a Rehired row. The new period is voided, so the previous one opens. */
export async function rollBackRehireAction(data: FormData): Promise<void> {
  const employmentId = String(data.get('employmentId') ?? '');
  let target = `/admin/personnel/${employmentId}?tab=careerMovement`;
  try {
    const s = await requireAdmin();
    const result = await rollBackRehire(s, { employmentId, reason: String(data.get('reason') ?? '') });
    target = `/admin/personnel/${result.fromEmploymentId}?tab=careerMovement&toast=${encodeURIComponent((await getTranslations('people.detail.movement.rehire'))('rolledBack'))}`;
  } catch (e) {
    unstable_rethrow(e);
    const message = await rehireMessage(e);
    target = data.get('movementPage')
      ? `${movementPageHref(employmentId, 'history')}?error=${encodeURIComponent(message)}`
      : `/admin/personnel/${employmentId}?tab=careerMovement&error=${encodeURIComponent(message)}`;
  }
  redirect(target);
}
