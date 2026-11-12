import { getTranslations } from 'next-intl/server';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  CANDIDATE_FILE_ACCEPT, CANDIDATE_SOURCES, CONSENT_METHODS, CONSENT_STATUSES, EDUCATION_LEVELS, FILE_KINDS, ID_TYPES, type CandidateProfile,
} from '@/packs/recruitment/service';
import {
  addCandidateEntryAction, addCandidateTagAction, deleteCandidateFileAction, recordConsentAction, removeCandidateEntryAction, removeCandidateTagAction,
  saveCandidateRestrictedAction, updateCandidateProfileAction, uploadCandidateFileAction,
} from '../../actions';
import { Pill, klDate, klDateTime, selectCls } from '../../shared';
import { CustomFieldInputs, CustomFieldValues } from '../../custom-fields-ui';

/**
 * Application › Candidate (slice 5): the candidate record as the viewer may see it — the service and row security decide
 * every part. Hiring managers and interviewers read the profile and the resume; tags are hidden from interviewers;
 * restricted values, other attachments and consent are for administrators and the candidate's job operators only; the
 * "Retention period ended" marker is for administrators. Slice 14: the company's custom candidate fields follow the fixed
 * profile (restricted ones only for administrators and the candidate's job operators). Nothing here infers anything about the
 * candidate.
 */
export async function CandidateSection({ profile: p, applicationId, here, locale }: { profile: CandidateProfile; applicationId: string; here: string; locale: string }) {
  const t = await getTranslations('recruitment.cand');
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const base = <>{hidden('candidateId', p.candidateId)}{hidden('applicationId', applicationId)}{hidden('returnTo', here)}</>;
  const day = (d: string) => klDate(locale, `${d}T00:00:00+08:00`);
  const month = (d: string | null) => (d ? new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(`${d}T00:00:00+08:00`)) : '');
  const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const money = (amount: string | null, currency: string | null) => (amount && currency ? `${currency} ${amount}` : '—');
  const card = 'space-y-3 rounded-xl border border-border bg-card p-4';
  const consent = p.consent?.current ?? null;
  const work = p.entries.filter((e) => e.kind === 'work');
  const education = p.entries.filter((e) => e.kind === 'education');

  return (
    <div className="space-y-4">
      {(p.removed || p.consent || p.retention) && (
        <div className="flex flex-wrap items-center gap-2">
          {p.removed && <Pill tone="neutral">{t('removedNote')}</Pill>}
          {p.consent && (consent === null ? <Pill tone="warn">{t('noConsent')}</Pill>
            : consent.status === 'withdrawn' ? <Pill tone="bad">{t('consentWithdrawn', { date: day(consent.on) })}</Pill>
              : <Pill tone="good">{t('consentGiven', { date: day(consent.on) })}</Pill>)}
          {p.retention?.ended && <Pill tone="bad">{t('retentionEnded')}</Pill>}
          {p.retention && !p.retention.ended && p.retention.dueOn && <Pill tone="neutral">{t('retentionUntil', { date: day(p.retention.dueOn) })}</Pill>}
        </div>
      )}

      <section className={card} aria-labelledby="cand-profile">
        <h2 id="cand-profile" className="text-sm font-semibold">{t('profileTitle')}</h2>
        {p.can.edit ? (
          <form action={updateCandidateProfileAction} className="space-y-4">
            {base}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t('fullName')} required requiredAriaLabel={t('required')}><Input name="fullName" required maxLength={200} defaultValue={p.fullName} /></Field>
              <Field label={t('email')}><Input name="email" type="email" maxLength={254} defaultValue={p.email ?? ''} /></Field>
              <Field label={t('mobile')}><Input name="phone" maxLength={40} defaultValue={p.phone ?? ''} /></Field>
              <Field label={t('location')}><Input name="location" maxLength={200} defaultValue={p.location ?? ''} /></Field>
              <Field label={t('currentCompany')}><Input name="currentCompany" maxLength={200} defaultValue={p.currentCompany ?? ''} /></Field>
              <Field label={t('currentTitle')}><Input name="currentTitle" maxLength={200} defaultValue={p.currentTitle ?? ''} /></Field>
              <Field label={t('education')}>
                <select name="highestEducation" defaultValue={p.highestEducation ?? ''} className={selectCls}>
                  <option value="">{t('notStated')}</option>
                  {EDUCATION_LEVELS.map((v) => <option key={v} value={v}>{t(`educationLevels.${v}`)}</option>)}
                </select>
              </Field>
              <Field label={t('noticePeriod')}><Input name="noticePeriod" maxLength={60} defaultValue={p.noticePeriod ?? ''} placeholder={t('noticePlaceholder')} /></Field>
              <Field label={t('source')}>
                <select name="source" defaultValue={p.source ?? ''} className={selectCls}>
                  <option value="">{t('notStated')}</option>
                  {CANDIDATE_SOURCES.map((v) => <option key={v} value={v}>{t(`sources.${v}`)}</option>)}
                </select>
              </Field>
            </div>
            <CustomFieldInputs fields={p.custom} locale={locale} />
            <p className="text-xs text-muted-foreground">{t('notCollected')}</p>
            <button type="submit" className={btnPrimary}>{t('saveProfile')}</button>
          </form>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {([
              [t('email'), p.email], [t('mobile'), p.phone], [t('location'), p.location], [t('currentCompany'), p.currentCompany],
              [t('currentTitle'), p.currentTitle], [t('education'), p.highestEducation ? t(`educationLevels.${p.highestEducation}`) : null],
              [t('noticePeriod'), p.noticePeriod], [t('source'), p.source ? t(`sources.${p.source}`) : null],
            ] as const).map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd>{value || '—'}</dd></div>)}
          </dl>
        )}
        {!p.can.edit && <CustomFieldValues fields={p.custom} locale={locale} />}
      </section>

      <section className={card} aria-labelledby="cand-entries">
        <h2 id="cand-entries" className="text-sm font-semibold">{t('entriesTitle')}</h2>
        {([['work', work], ['education', education]] as const).map(([kind, list]) => (
          <div key={kind} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`entryKinds.${kind}`)}</h3>
            {list.length === 0 ? <p className="text-sm text-muted-foreground">{t('noEntries')}</p> : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {list.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{e.organisation}</span>{e.title && <> · {e.title}</>}
                      <span className="block text-xs text-muted-foreground">
                        {[month(e.fromMonth), e.isCurrent ? t('present') : month(e.toMonth)].filter(Boolean).join(' – ') || '—'}
                      </span>
                    </span>
                    {p.can.edit && (
                      <form action={removeCandidateEntryAction}>{base}{hidden('entryId', e.id)}
                        <button type="submit" className="text-sm text-destructive hover:underline">{t('remove')}</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {p.can.edit && (
              <form action={addCandidateEntryAction} className="grid gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_1fr_9rem_9rem_auto] sm:items-end">
                {base}{hidden('kind', kind)}
                <Field label={kind === 'work' ? t('employer') : t('school')} required requiredAriaLabel={t('required')}><Input name="organisation" required maxLength={200} /></Field>
                <Field label={kind === 'work' ? t('jobTitle') : t('qualification')}><Input name="title" maxLength={200} /></Field>
                <Field label={t('from')}><Input name="fromMonth" type="month" /></Field>
                <Field label={t('to')}><Input name="toMonth" type="month" /></Field>
                <div className="flex items-center gap-3 pb-1">
                  {kind === 'work' && <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="isCurrent" />{t('present')}</label>}
                  <button type="submit" className={btnGhost}>{t('add')}</button>
                </div>
              </form>
            )}
          </div>
        ))}
      </section>

      {p.restricted && (
        <section className={card} aria-labelledby="cand-restricted">
          <div>
            <h2 id="cand-restricted" className="text-sm font-semibold">{t('restrictedTitle')}</h2>
            <p className="text-xs text-muted-foreground">{t('restrictedNote')}</p>
          </div>
          {p.can.edit ? (
            <form action={saveCandidateRestrictedAction} className="space-y-4">
              {base}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={t('currentSalary')}>
                  <div className="flex gap-2">
                    <Input name="currentSalaryCurrency" maxLength={3} className="w-20 uppercase" defaultValue={p.restricted.currentSalaryCurrency ?? 'MYR'} aria-label={t('currency')} />
                    <Input name="currentSalaryAmount" inputMode="decimal" defaultValue={p.restricted.currentSalaryAmount ?? ''} aria-label={t('amount')} />
                  </div>
                </Field>
                <Field label={t('expectedSalary')}>
                  <div className="flex gap-2">
                    <Input name="expectedSalaryCurrency" maxLength={3} className="w-20 uppercase" defaultValue={p.restricted.expectedSalaryCurrency ?? 'MYR'} aria-label={t('currency')} />
                    <Input name="expectedSalaryAmount" inputMode="decimal" defaultValue={p.restricted.expectedSalaryAmount ?? ''} aria-label={t('amount')} />
                  </div>
                </Field>
                <Field label={t('idNumber')}>
                  <div className="flex gap-2">
                    <select name="idType" defaultValue={p.restricted.idType ?? ''} className={cn(selectCls, 'w-32')} aria-label={t('idType')}>
                      <option value="">{t('idNone')}</option>
                      {ID_TYPES.map((v) => <option key={v} value={v}>{t(`idTypes.${v}`)}</option>)}
                    </select>
                    <Input name="idNumber" maxLength={40} autoComplete="off" defaultValue={p.restricted.idNumber ?? ''} aria-label={t('idNumber')} />
                  </div>
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">{t('peopleEnterPay')}</p>
              <button type="submit" className={btnPrimary}>{t('saveRestricted')}</button>
            </form>
          ) : (
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-muted-foreground">{t('currentSalary')}</dt><dd>{money(p.restricted.currentSalaryAmount, p.restricted.currentSalaryCurrency)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('expectedSalary')}</dt><dd>{money(p.restricted.expectedSalaryAmount, p.restricted.expectedSalaryCurrency)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('idNumber')}</dt><dd>{p.restricted.idType ? `${t(`idTypes.${p.restricted.idType}`)} ${p.restricted.idNumber}` : '—'}</dd></div>
            </dl>
          )}
        </section>
      )}

      <section className={card} aria-labelledby="cand-files">
        <h2 id="cand-files" className="text-sm font-semibold">{t('filesTitle')}</h2>
        {p.files.length === 0 ? <p className="text-sm text-muted-foreground">{t('noFiles')}</p> : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {p.files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <Pill tone={f.kind === 'resume' ? 'info' : 'neutral'}>{t(`fileKinds.${f.kind}`)}</Pill>{' '}
                  <a className="text-primary hover:underline" href={`/recruitment/files/${f.id}`}>{f.fileName}</a>
                  <span className="block text-xs text-muted-foreground">{size(f.sizeBytes)} · {f.byApplicant ? t('uploadedByApplicant', { at: klDateTime(locale, f.uploadedAt) }) : t('uploadedBy', { name: f.uploadedBy ?? t('unnamedUser'), at: klDateTime(locale, f.uploadedAt) })}</span>
                </span>
                {p.can.edit && (
                  <form action={deleteCandidateFileAction}>{base}{hidden('fileId', f.id)}
                    <button type="submit" className="text-sm text-destructive hover:underline">{t('delete')}</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {!p.can.edit && <p className="text-xs text-muted-foreground">{t('filesReaderNote')}</p>}
        {p.can.edit && (
          <form action={uploadCandidateFileAction} className="space-y-3 rounded-lg border border-dashed border-border p-3">
            {base}
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr] sm:items-end">
              <Field label={t('fileKind')}>
                <select name="kind" defaultValue="resume" className={selectCls}>
                  {FILE_KINDS.map((k) => <option key={k} value={k}>{t(`fileKinds.${k}`)}</option>)}
                </select>
              </Field>
              <Field label={t('file')} required requiredAriaLabel={t('required')}>
                <input name="file" type="file" required accept={CANDIDATE_FILE_ACCEPT} className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm" />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">{t('fileRules')}</p>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="permissionConfirmed" required className="mt-0.5" /><span>{t('permission')}</span></label>
            <button type="submit" className={btnPrimary}>{t('upload')}</button>
          </form>
        )}
      </section>

      {p.tags && (
        <section className={card} aria-labelledby="cand-tags">
          <h2 id="cand-tags" className="text-sm font-semibold">{t('tags')}</h2>
          {p.tags.length === 0 ? <p className="text-sm text-muted-foreground">{t('noTags')}</p> : (
            <ul className="flex flex-wrap gap-2">
              {p.tags.map((tag) => (
                <li key={tag.id} className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs', tag.enabled ? 'border-border' : 'border-dashed border-border text-muted-foreground')}>
                  <span>{tag.groupName} · {tag.name}{!tag.enabled && ` (${t('disabled')})`}</span>
                  {p.can.edit && (
                    <form action={removeCandidateTagAction} className="inline">{base}{hidden('tagId', tag.id)}
                      <button type="submit" aria-label={t('removeTag', { name: tag.name })} className="px-1 text-muted-foreground hover:text-destructive">×</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {p.can.edit && p.tagOptions.length > 0 && (
            <form action={addCandidateTagAction} className="flex flex-wrap items-center gap-2">
              {base}
              <label className="sr-only" htmlFor="add-tag">{t('addTag')}</label>
              <select id="add-tag" name="tagId" required defaultValue="" className={cn(selectCls, 'w-64')}>
                <option value="" disabled>{t('chooseTag')}</option>
                {p.tagOptions.map((o) => <option key={o.id} value={o.id}>{o.groupName} · {o.name}</option>)}
              </select>
              <button type="submit" className={btnGhost}>{t('addTag')}</button>
            </form>
          )}
        </section>
      )}

      {p.consent && (
        <section className={card} aria-labelledby="cand-consent">
          <div>
            <h2 id="cand-consent" className="text-sm font-semibold">{t('consentTitle')}</h2>
            <p className="text-xs text-muted-foreground">{t('consentNote')}</p>
          </div>
          {p.consent.history.length === 0 ? <p className="text-sm text-muted-foreground">{t('noConsent')}</p> : (
            <ol className="space-y-1 text-sm">
              {p.consent.history.map((h) => (
                <li key={h.id} className="border-l-2 border-border pl-3">
                  {h.careersNoticeVersion !== null
                    ? <p>{t(`consentStatuses.${h.status}`)} · {t('careersConsent', { version: h.careersNoticeVersion, date: day(h.effectiveOn) })}</p>
                    : <p>{t(`consentStatuses.${h.status}`)} · {day(h.effectiveOn)} · {t(`consentMethods.${h.method}`)}{h.noticeReference && <> · {h.noticeReference}</>}</p>}
                  <p className="text-xs text-muted-foreground">{h.byApplicant ? t('recordedByApplicant', { at: klDateTime(locale, h.recordedAt) })
                    : t('recordedBy', { name: h.recordedBy ?? t('unnamedUser'), at: klDateTime(locale, h.recordedAt) })}</p>
                </li>
              ))}
            </ol>
          )}
          {p.can.edit && (
            <form action={recordConsentAction} className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[10rem_10rem_12rem_1fr_auto] sm:items-end">
              {base}
              <Field label={t('consentStatus')}>
                <select name="status" defaultValue={consent?.status === 'consented' ? 'withdrawn' : 'consented'} className={selectCls}>
                  {CONSENT_STATUSES.map((v) => <option key={v} value={v}>{t(`consentStatuses.${v}`)}</option>)}
                </select>
              </Field>
              <Field label={t('consentDate')} required requiredAriaLabel={t('required')}><Input name="effectiveOn" type="date" required /></Field>
              <Field label={t('consentMethod')}>
                <select name="method" defaultValue="written_form" className={selectCls}>
                  {CONSENT_METHODS.map((v) => <option key={v} value={v}>{t(`consentMethods.${v}`)}</option>)}
                </select>
              </Field>
              <Field label={t('noticeReference')}><Input name="noticeReference" maxLength={200} /></Field>
              <button type="submit" className={btnPrimary}>{t('recordConsent')}</button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
