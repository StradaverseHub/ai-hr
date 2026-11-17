import { getTranslations } from 'next-intl/server';
import { Field, Input } from '@/components/ui';
import { JOB_EMPLOYMENT_TYPES, RECRUITMENT_TYPES, type JobFormOptions } from '@/packs/recruitment/service';
import { selectCls, textareaCls } from '../shared';

export type RequisitionValues = Partial<Record<string, string | number | string[] | null>>;

/** Requisition fields, shared by the new and edit forms. Required marks mirror the service (./hiring-model). */
export async function RequisitionFields({ options, values = {} }: { options: JobFormOptions; values?: RequisitionValues }) {
  const [t, job] = await Promise.all([getTranslations('recruitment.req'), getTranslations('recruitment.job')]);
  const required = job('required');
  const v = (key: string) => (values[key] == null ? '' : String(values[key]));
  const grades = new Set((values.jobGradeIds as string[] | undefined) ?? []);
  const person = (name: string, label: string) => (
    <Field label={label}>
      <select name={name} defaultValue={v(name)} className={selectCls}>
        <option value="">{job('none')}</option>
        {options.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </Field>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={job('title')} required requiredAriaLabel={required} className="sm:col-span-2"><Input name="title" defaultValue={v('title')} maxLength={200} required /></Field>
      <Field label={t('description')} className="sm:col-span-2"><textarea name="description" defaultValue={v('description')} rows={4} maxLength={20000} className={textareaCls} /></Field>
      <Field label={t('vacancies')} required requiredAriaLabel={required}><Input name="vacancies" type="number" min={1} max={10000} defaultValue={v('vacancies') || '1'} required /></Field>
      <Field label={job('workLocation')} required requiredAriaLabel={required}><Input name="workLocation" defaultValue={v('workLocation')} maxLength={200} required /></Field>
      <Field label={job('employmentType')} required requiredAriaLabel={required}>
        <select name="employmentType" defaultValue={v('employmentType')} className={selectCls} required>
          <option value="">{job('choose')}</option>
          {JOB_EMPLOYMENT_TYPES.map((x) => <option key={x} value={x}>{job(`employmentTypes.${x}`)}</option>)}
        </select>
      </Field>
      <Field label={job('recruitmentType')} required requiredAriaLabel={required}>
        <select name="recruitmentType" defaultValue={v('recruitmentType')} className={selectCls} required>
          <option value="">{job('choose')}</option>
          {RECRUITMENT_TYPES.map((x) => <option key={x} value={x}>{job(`recruitmentTypes.${x}`)}</option>)}
        </select>
      </Field>
      <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
        <legend className="text-xs font-medium text-muted-foreground">{job('jobLevel')}</legend>
        <div className="flex flex-wrap gap-2">
          {options.grades.map((g) => (
            <label key={g.id} className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm">
              <input type="checkbox" name="jobGradeIds" value={g.id} defaultChecked={grades.has(g.id)} />{g.name}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={job('department')}>
        <select name="departmentId" defaultValue={v('departmentId')} className={selectCls}>
          <option value="">{job('none')}</option>
          {options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
      {person('hiringManagerUserId', t('hiringManager'))}
      {person('partnerUserId', t('partner'))}
      {person('recruiterUserId', job('recruiter'))}
      <Field label={t('dateOpened')}><Input name="dateOpened" type="date" defaultValue={v('dateOpened')} /></Field>
      <Field label={t('targetOnboardDate')}><Input name="targetOnboardDate" type="date" defaultValue={v('targetOnboardDate')} /></Field>
      <Field label={t('yearsExperience')}><Input name="yearsExperience" type="number" min={0} max={60} defaultValue={v('yearsExperience')} /></Field>
      <Field label={t('education')}><Input name="education" defaultValue={v('education')} maxLength={200} /></Field>
      <fieldset className="grid gap-2 sm:col-span-2 sm:grid-cols-[6rem_1fr_1fr]">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('salaryRange')}</legend>
        <Input name="salaryCurrency" defaultValue={v('salaryCurrency') || 'MYR'} maxLength={3} aria-label={t('currency')} className="uppercase" />
        <Input name="salaryMin" inputMode="decimal" defaultValue={v('salaryMin')} aria-label={t('salaryMin')} placeholder={t('salaryMin')} />
        <Input name="salaryMax" inputMode="decimal" defaultValue={v('salaryMax')} aria-label={t('salaryMax')} placeholder={t('salaryMax')} />
      </fieldset>
      <Field label={t('workingDays')}><Input name="workingDays" defaultValue={v('workingDays')} maxLength={200} /></Field>
      <Field label={t('workingHours')}><Input name="workingHours" defaultValue={v('workingHours')} maxLength={200} /></Field>
      <Field label={t('mandatorySkills')}><textarea name="mandatorySkills" defaultValue={v('mandatorySkills')} rows={2} maxLength={4000} className={textareaCls} /></Field>
      <Field label={t('preferredSkills')}><textarea name="preferredSkills" defaultValue={v('preferredSkills')} rows={2} maxLength={4000} className={textareaCls} /></Field>
      <Field label={t('benefits')} className="sm:col-span-2"><textarea name="benefits" defaultValue={v('benefits')} rows={2} maxLength={4000} className={textareaCls} /></Field>
    </div>
  );
}
