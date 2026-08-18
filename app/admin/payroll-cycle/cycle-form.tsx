import { getTranslations } from 'next-intl/server';
import { PAYROLL_CYCLE_RUN_TYPES, type PayrollCycleRow } from '@/core/payroll-cycle';
import { Card, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { upsertCycleAction } from './actions';
import { cycleCompanyHref } from './nav';

/**
 * 6df24751 — the Add / Edit Payroll Cycle form, extracted from the bottom of the list page so it can be
 * rendered as a screen of its own (app/admin/pay-components/component-form.tsx is the precedent).
 *
 * SAME FIELDS, SAME RULES, SAME VALIDATION AS BEFORE — the plan promises exactly that, so this is a move,
 * not a redesign of the form. It still posts to `upsertCycleAction`, which still calls
 * `upsertPayrollCycle`; only where the action redirects afterwards has changed.
 *
 * `companyName` is rendered read-only rather than as a picker: the company is now part of the ROUTE, so
 * offering it as an editable field would be a second, contradictory way to choose one. `companyId` rides
 * as a hidden input because the action needs it (and RLS re-checks it server-side either way).
 *
 * `q` is threaded through as a hidden input so the action's redirect can put the admin back on a listing
 * that still carries their search.
 */
export async function CycleForm({
  companyId,
  companyName,
  cycle,
  q,
}: {
  companyId: string;
  companyName: string;
  cycle: PayrollCycleRow | null;
  q?: string;
}) {
  const t = await getTranslations('payrollCycleConfig');
  return (
    <Card>
      <SectionHeader title={cycle ? t('editTitle', { name: cycle.name }) : t('addTitle')} />
      <form action={upsertCycleAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="q" value={q ?? ''} />
        {cycle && <input type="hidden" name="id" value={cycle.id} />}

        <div className="sm:col-span-3">
          <Field label={t('company')}>
            {/* Read-only: the company is the route. `disabled` so it cannot be posted, and
                `defaultValue` rather than `value` so React does not warn about a valued field with no
                change handler. The company still rides as the hidden input above, which is what the
                action reads. */}
            <input defaultValue={companyName} disabled className={inputCls} />
          </Field>
        </div>

        <Field label={t('colName')}>
          <input name="name" required defaultValue={cycle?.name ?? ''} placeholder={t('namePlaceholder')} className={inputCls} />
        </Field>
        <Field label={t('colCode')}>
          <input
            name="code"
            defaultValue={cycle?.code ?? ''}
            placeholder={t('codePlaceholder')}
            maxLength={16}
            className={inputCls}
          />
        </Field>
        <Field label={t('colRunType')}>
          <select name="runType" defaultValue={cycle?.runType ?? 'regular'} className={inputCls}>
            {PAYROLL_CYCLE_RUN_TYPES.map((rt) => (
              <option key={rt} value={rt}>
                {t(`runType.${rt}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('colSort')}>
          <input name="sortOrder" type="number" min={0} defaultValue={cycle?.sortOrder ?? 0} className={inputCls} />
        </Field>
        <Field label={t('colRemarks')}>
          <input name="remarks" defaultValue={cycle?.remarks ?? ''} placeholder={t('remarksPlaceholder')} className={inputCls} />
        </Field>
        <div className="sm:col-span-3">
          <Field label={t('colBehaviour')}>
            <textarea
              name="description"
              rows={2}
              defaultValue={cycle?.description ?? ''}
              placeholder={t('behaviourPlaceholder')}
              className={inputCls}
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-3">{t('runTypeHelp')}</p>
        {/* 4157a498 — say what the code is FOR, or nobody fills it in and every import file fails. */}
        <p className="text-xs text-muted-foreground sm:col-span-3">{t('codeHelp')}</p>
        <div className="flex items-center gap-3 sm:col-span-3">
          <button className={btnPrimary}>{cycle ? t('saveChanges') : t('addCycle')}</button>
          <a
            href={cycleCompanyHref(companyId, q)}
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {t('cancelEdit')}
          </a>
        </div>
      </form>
    </Card>
  );
}
