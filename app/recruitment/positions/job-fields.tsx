import { getTranslations } from 'next-intl/server';
import { Field, Input } from '@/components/ui';
import { JOB_EMPLOYMENT_TYPES, RECRUITMENT_TYPES, type JobFormOptions } from '@/packs/recruitment/service';
import { selectCls } from '../shared';

export type JobValues = {
  title?: string; description?: string | null; jobGradeIds?: string[]; workLocation?: string; recruitmentType?: string;
  employmentType?: string; businessUnitId?: string | null; departmentId?: string | null;
};

/** Job info fields, shared by the new-position form and the Job info tab. Required marks mirror the service. */
export async function JobInfoFields({ options, values = {} }: { options: JobFormOptions; values?: JobValues }) {
  const t = await getTranslations('recruitment.job');
  const required = t('required');
  const chosen = new Set(values.jobGradeIds ?? []);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('title')} required requiredAriaLabel={required} className="sm:col-span-2">
        <Input name="title" defaultValue={values.title ?? ''} maxLength={200} required />
      </Field>
      <Field label={t('description')} className="sm:col-span-2">
        <textarea name="description" defaultValue={values.description ?? ''} maxLength={20000} rows={5}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20" />
      </Field>
      <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
        <legend className="text-xs font-medium text-muted-foreground">{t('jobLevel')}<span className="ml-0.5 text-destructive" aria-label={required}>*</span></legend>
        {options.grades.length === 0 ? <p className="text-sm text-muted-foreground">{t('noGrades')}</p> : (
          <div className="flex flex-wrap gap-2">
            {options.grades.map((g) => (
              <label key={g.id} className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm">
                <input type="checkbox" name="jobGradeIds" value={g.id} defaultChecked={chosen.has(g.id)} />{g.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <Field label={t('workLocation')} required requiredAriaLabel={required}>
        <Input name="workLocation" defaultValue={values.workLocation ?? ''} maxLength={200} required />
      </Field>
      <Field label={t('recruitmentType')} required requiredAriaLabel={required}>
        <select name="recruitmentType" defaultValue={values.recruitmentType ?? ''} className={selectCls} required>
          <option value="">{t('choose')}</option>
          {RECRUITMENT_TYPES.map((v) => <option key={v} value={v}>{t(`recruitmentTypes.${v}`)}</option>)}
        </select>
      </Field>
      <Field label={t('employmentType')} required requiredAriaLabel={required}>
        <select name="employmentType" defaultValue={values.employmentType ?? ''} className={selectCls} required>
          <option value="">{t('choose')}</option>
          {JOB_EMPLOYMENT_TYPES.map((v) => <option key={v} value={v}>{t(`employmentTypes.${v}`)}</option>)}
        </select>
      </Field>
      <Field label={t('businessUnit')}>
        <select name="businessUnitId" defaultValue={values.businessUnitId ?? ''} className={selectCls}>
          <option value="">{t('none')}</option>
          {options.businessUnits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label={t('department')}>
        <select name="departmentId" defaultValue={values.departmentId ?? ''} className={selectCls}>
          <option value="">{t('none')}</option>
          {options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
    </div>
  );
}
