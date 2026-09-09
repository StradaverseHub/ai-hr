'use client';

/**
 * FAMILY ON A DRAFT — item 759dfc7d, work item 1.
 *
 * The same Add / Edit / View / Delete the active employee's Family tab offers, against a record that has
 * no person yet. `employee_dependent` is keyed to a PERSON and a draft deliberately creates none, so what
 * this screen edits is the draft's own jsonb blob (`EmployeeDraftData.family`); `completeEmployeeDraft`
 * turns those entries into real rows at Activate.
 *
 * WHY THIS IS NOT THE PERSONNEL SCREEN'S COMPONENT, and it is a scope decision rather than an oversight:
 * that screen's dialog is a SERVER-rendered form posting to a server action per row, because every row it
 * edits already exists in the database. A draft has one row — itself — saved as a whole, so its family is
 * client state from the first keystroke to Save Draft. The two cannot share a form without first turning
 * that one into a controlled component, which is the plan's own later step (work item 2 re-points the
 * shared sections). What they DO share, today, is everything that could actually drift:
 *   - the value sets and the panel routing (`lib/dependent-vocabulary.ts` — one definition, both screens);
 *   - the labels (`people.detail.family.*` — literally the Personnel screen's strings, in all six
 *     locales), so a section name or a field name cannot read differently on the two screens;
 *   - the age rule (`childAgeYears`), so the read-only Age cannot disagree.
 * The FIELDS themselves are pinned to the writer's input type by a test, not by this file
 * (test/employee-draft-family.test.ts §2), which is the guarantee that actually matters: a column the
 * Personnel screen gains and this form forgets fails a test instead of quietly vanishing at Activate.
 *
 * NOTHING HERE VALIDATES BEYOND WHAT A DRAFT ALLOWS. A half-typed family member saves with the rest of
 * the draft; `missingByTab(...).family` is what names it as outstanding, and the server re-runs that
 * rule (plus the catalog rules in `assertDependentsValid`) before Activate creates anything at all.
 */

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, inputCls } from '@/components/ui';
import {
  CHILD_RELIEF_CATEGORIES,
  DEPENDENT_GENDERS,
  DEPENDENT_MARRIAGE_STATUSES,
  DEPENDENT_RELATIONSHIPS,
  childAgeYears,
  dependentPanelOf,
} from '@/lib/dependent-vocabulary';
import type { EmployeeDraftFamilyMember } from '@/lib/employee-draft-schema';

type Opt = { value: string; label: string };

/** Same order the Personnel table sorts by: spouse, children, parents, siblings, then everything else. */
const rank = (r: string) => (r === 'spouse' ? 0 : r === 'child' ? 1 : r === 'parent' ? 2 : r === 'sibling' ? 3 : 4);

export function DraftFamilyStep({
  members,
  onChange,
  relationshipOptions,
  countryOptions,
}: {
  members: EmployeeDraftFamilyMember[];
  onChange: (next: EmployeeDraftFamilyMember[]) => void;
  /** The tenant's `dependentRelationship` catalog, active options only — the SAME list the Personnel
   *  dialog offers, so a value picked here is one `assertDependentsValid` will accept at Activate. Falls
   *  back to the five built-ins when the catalog is unseeded, exactly as that screen does. */
  relationshipOptions: Opt[];
  /** The `country` catalog, for a child's study country. */
  countryOptions: Opt[];
}) {
  const t = useTranslations('people.detail.family');
  // `null` closed; `{ at: null }` is Add; `{ at: n }` is Edit/View of the nth member as ORIGINALLY given.
  const [editing, setEditing] = useState<{ at: number | null; draft: EmployeeDraftFamilyMember; readOnly: boolean } | null>(
    null,
  );
  const [confirmAt, setConfirmAt] = useState<number | null>(null);

  const relLabel = (r: string) => {
    if ((DEPENDENT_RELATIONSHIPS as readonly string[]).includes(r)) return t(`rel.${r}` as 'rel.spouse');
    return relationshipOptions.find((o) => o.value === r)?.label ?? r;
  };
  /**
   * The catalog, LABELLED THE WAY THE PERSONNEL TAB LABELS IT (`activeRelationshipOptions` on
   * app/admin/personnel/[employmentId]/page.tsx): a BUILT-IN value keeps its static i18n label whatever
   * the catalog row carries, and only a CUSTOM value is data-labelled. Passing `o.label` straight through
   * is not cosmetic — migration 0305 seeded every existing tenant's `dependentRelationship` rows with
   * `label = value`, so the raw catalog label is the lowercase machine value. That put an untranslated
   * "spouse" in this dropdown one click away from a table cell (and a Personnel tab) reading "Pasangan".
   * Same rule, same fallback: an unseeded catalog gives the five built-ins.
   */
  const activeOptions =
    relationshipOptions.length > 0
      ? relationshipOptions.map((o) => ({ value: o.value, label: relLabel(o.value) }))
      : DEPENDENT_RELATIONSHIPS.map((r) => ({ value: r, label: relLabel(r) }));
  // An EDITED member whose stored relationship is no longer an active catalog option must still render and
  // still re-save — the same legacy tolerance `relationshipOptionsFor` gives the Personnel dialog.
  const optionsFor = (m: EmployeeDraftFamilyMember | null) => {
    const cur = (m?.relationship ?? '').trim();
    return cur !== '' && !activeOptions.some((o) => o.value === cur)
      ? [...activeOptions, { value: cur, label: relLabel(cur) }]
      : activeOptions;
  };

  // Display order only. The stored array keeps insertion order, so `at` indexes the ORIGINAL array and a
  // re-sort of the table can never edit the wrong row.
  const ordered = members
    .map((m, at) => ({ m, at }))
    .sort(
      (x, y) =>
        rank(x.m.relationship ?? '') - rank(y.m.relationship ?? '') ||
        (x.m.relationship ?? '').localeCompare(y.m.relationship ?? '') ||
        (x.m.fullName ?? '').localeCompare(y.m.fullName ?? ''),
    );

  const commit = () => {
    if (!editing) return;
    const next = [...members];
    if (editing.at === null) next.push(editing.draft);
    else next[editing.at] = editing.draft;
    onChange(next);
    setEditing(null);
  };
  const remove = (at: number) => {
    onChange(members.filter((_, i) => i !== at));
    setConfirmAt(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t('title')}</h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t('note')}</p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() =>
            setEditing({ at: null, readOnly: false, draft: { key: `${Date.now()}-${members.length}` } })
          }
        >
          {t('add')}
        </Button>
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{t('name')}</th>
                <th className="py-2 pr-3 font-medium">{t('relationship')}</th>
                <th className="py-2 pr-3 font-medium">{t('dateOfBirth')}</th>
                <th className="py-2 pr-3 font-medium">{t('childAge')}</th>
                <th className="py-2 pr-3 font-medium">{t('contactNumber')}</th>
                <th className="py-2 text-right font-medium">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map(({ m, at }) => (
                <tr key={m.key ?? at} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3 font-medium">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {(m.fullName ?? '').trim() || <span className="text-muted-foreground">—</span>}
                      {m.isBeneficiary && <Badge variant="success">{t('beneficiary')}</Badge>}
                      {m.isDeceased && <Badge variant="default">{t('deceased')}</Badge>}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{(m.relationship ?? '').trim() ? relLabel(m.relationship!) : '—'}</td>
                  <td className="whitespace-nowrap py-2 pr-3">{m.dateOfBirth || '—'}</td>
                  <td className="py-2 pr-3">{childAgeYears(m.dateOfBirth) ?? '—'}</td>
                  <td className="py-2 pr-3">{m.phone || '—'}</td>
                  <td className="py-2">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing({ at, readOnly: true, draft: m })}
                      >
                        {t('view')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing({ at, readOnly: false, draft: m })}
                      >
                        {t('edit')}
                      </Button>
                      {/* A draft's family is client state, so removal is immediate and local — there is no
                          server action to confirm against. The confirmation is inline for that reason: a
                          modal over a modal-less list would be heavier than the thing it guards. */}
                      {confirmAt === at ? (
                        <span className="inline-flex items-center gap-2 text-xs">
                          {t('deleteFamilyConfirmTitle')}
                          <Button type="button" size="sm" variant="destructive" onClick={() => remove(at)}>
                            {t('yes')}
                          </Button>
                          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmAt(null)}>
                            {t('no')}
                          </Button>
                        </span>
                      ) : (
                        <Button type="button" size="sm" variant="destructive" onClick={() => setConfirmAt(at)}>
                          {t('delete')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t('hint')}</p>

      <Dialog.Root open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
          >
            <div className="flex items-start justify-between gap-4">
              <Dialog.Title className="text-base font-semibold">
                {editing?.readOnly
                  ? t('viewFamilyTitle')
                  : editing?.at === null
                    ? t('addFamilyTitle')
                    : t('editFamilyTitle')}
              </Dialog.Title>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="sm" aria-label={t('cancel')}>
                  ✕
                </Button>
              </Dialog.Close>
            </div>
            {editing && (
              <div className="mt-4 space-y-4">
                <MemberFields
                  value={editing.draft}
                  readOnly={editing.readOnly}
                  relationshipOptions={optionsFor(editing.at === null ? null : editing.draft)}
                  countryOptions={countryOptions}
                  onChange={(patch) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e))}
                />
                {!editing.readOnly && (
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                      {t('cancel')}
                    </Button>
                    <Button type="button" onClick={commit}>
                      {editing.at === null ? t('add') : t('save')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/**
 * ONE member's fields, relationship first and the panel beneath it — the shape of the Personnel dialog.
 *
 * `dependentPanelOf` is the SAME routing function the server's column gating and the Personnel island use,
 * so the panel a relationship gets here is by construction the panel whose columns the writer will keep.
 * Unlike the Personnel dialog this renders only the ACTIVE panel: nothing is posted, so there are no
 * duplicate field names to disable out of a form body, and an unmounted control cannot leave a value
 * behind — the draft object is the only state there is.
 */
function MemberFields({
  value,
  readOnly,
  relationshipOptions,
  countryOptions,
  onChange,
}: {
  value: EmployeeDraftFamilyMember;
  readOnly: boolean;
  relationshipOptions: Opt[];
  countryOptions: Opt[];
  onChange: (patch: Partial<EmployeeDraftFamilyMember>) => void;
}) {
  const t = useTranslations('people.detail.family');
  // One key only, and it lives a level up: the legacy-value suffix is shared with every other
  // catalog-backed select on the Personnel screen, so it is NOT re-worded here.
  const tDetail = useTranslations('people.detail');
  const rel = (value.relationship ?? '').trim();
  const panel = rel === '' ? null : dependentPanelOf(rel);

  /**
   * LEGACY TOLERANCE FOR THE STUDY COUNTRY, the same one `ProfileOptionSelect` gives the Personnel
   * dialog: `countryOptions` is loaded active-only, so a stored country whose catalog option has since
   * been deactivated matches nothing and a plain `<select>` collapses to the placeholder — the screen
   * then reads "not set" while the blob still holds the value and Activate still writes it. Rendered as
   * an extra, pre-selected option instead, suffixed so HR can see it is off-catalog. Same order as
   * ProfileOptionSelect: the legacy row sits directly under the placeholder.
   */
  const storedCountry = (value.studyCountry ?? '').trim();
  const countryChoices =
    storedCountry !== '' && !countryOptions.some((o) => o.value === storedCountry)
      ? [{ value: storedCountry, label: `${storedCountry} ${tDetail('optionLegacySuffix')}` }, ...countryOptions]
      : countryOptions;
  const ro = readOnly ? { disabled: true } : {};
  const box = `${inputCls}${readOnly ? ' bg-muted/50' : ''}`;

  const text = (
    name: 'fullName' | 'phone' | 'icOrPassport' | 'remarks' | 'passportNumber' | 'occupation' | 'companyName' | 'schoolName' | 'studyLevel',
    label: string,
    type = 'text',
  ) => (
    <Field label={label}>
      <input
        type={type}
        className={box}
        value={value[name] ?? ''}
        onChange={(e) => onChange({ [name]: e.target.value })}
        {...ro}
      />
    </Field>
  );
  const date = (name: 'dateOfBirth' | 'marriageDate', label: string) => (
    <Field label={label}>
      <input
        type="date"
        className={box}
        value={value[name] ?? ''}
        onChange={(e) => onChange({ [name]: e.target.value })}
        {...ro}
      />
    </Field>
  );
  const area = (name: 'residentialAddress' | 'employerAddress', label: string) => (
    <div className="sm:col-span-2">
      <Field label={label}>
        <textarea
          rows={2}
          className={`${box.replace('h-9', 'min-h-16')} py-2`}
          value={value[name] ?? ''}
          onChange={(e) => onChange({ [name]: e.target.value })}
          {...ro}
        />
      </Field>
    </div>
  );
  const check = (name: 'isBeneficiary' | 'isDeceased' | 'isStudent' | 'spouseWorking' | 'childTaxRelief', label: string) => (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <input
        type="checkbox"
        checked={value[name] ?? false}
        onChange={(e) => onChange({ [name]: e.target.checked })}
        {...ro}
      />
      {label}
    </label>
  );

  const genderField = (
    <Field label={t('genderLabel')}>
      <select className={box} value={value.gender ?? ''} onChange={(e) => onChange({ gender: e.target.value })} {...ro}>
        <option value="">{t('genderUnset')}</option>
        {DEPENDENT_GENDERS.map((g) => (
          <option key={g} value={g}>
            {t(`gender.${g}` as 'gender.male')}
          </option>
        ))}
      </select>
    </Field>
  );

  const grid = 'grid grid-cols-1 items-end gap-3 sm:grid-cols-2';
  const fieldsetCls = 'rounded-lg border border-border p-3';
  const legendCls = 'px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

  return (
    <div className="space-y-4">
      <div className={grid}>
        <Field label={t('relationship')}>
          <select
            className={box}
            value={rel}
            onChange={(e) => onChange({ relationship: e.target.value })}
            {...ro}
          >
            <option value="">{t('relationshipPlaceholder')}</option>
            {relationshipOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {panel === 'child' && (
        <>
          <fieldset className={fieldsetCls}>
            <legend className={legendCls}>{t('sectionPersonal')}</legend>
            <div className={grid}>
              {text('fullName', t('name'))}
              {genderField}
              {date('dateOfBirth', t('dateOfBirth'))}
              {text('phone', t('contactNumber'), 'tel')}
              {text('icOrPassport', t('icOrBirthCert'))}
              {text('remarks', t('remarks'))}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 self-end pb-1 sm:col-span-2">
                {check('isBeneficiary', t('beneficiary'))}
                {check('isDeceased', t('deceasedStatus'))}
              </div>
            </div>
          </fieldset>
          <fieldset className={fieldsetCls}>
            <legend className={legendCls}>{t('sectionEducation')}</legend>
            <div className={grid}>
              {text('schoolName', t('schoolName'))}
              {text('studyLevel', t('studyLevel'))}
              <Field label={t('studyCountry')}>
                <select
                  className={box}
                  value={value.studyCountry ?? ''}
                  onChange={(e) => onChange({ studyCountry: e.target.value })}
                  {...ro}
                >
                  <option value="">{t('genderUnset')}</option>
                  {countryChoices.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex items-end pb-1">{check('isStudent', t('studentStatus'))}</div>
            </div>
          </fieldset>
          <fieldset className={fieldsetCls}>
            <legend className={legendCls}>
              <span className="inline-flex items-center gap-1.5">
                {t('sectionTaxRelief')}
                <span
                  className="inline-flex size-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] font-semibold text-muted-foreground"
                  title={t('childReliefGuidance')}
                  aria-label={t('childReliefGuidance')}
                >
                  i
                </span>
              </span>
            </legend>
            <div className={grid}>
              <Field label={t('childReliefCategory')}>
                <select
                  className={box}
                  value={value.childReliefCategory ?? ''}
                  onChange={(e) => onChange({ childReliefCategory: e.target.value })}
                  {...ro}
                >
                  <option value="">{t('childReliefCategoryUnset')}</option>
                  {CHILD_RELIEF_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`childReliefCat_${c}` as 'childReliefCat_under_18')}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('childReliefPercentage')}>
                <select
                  className={box}
                  value={value.childReliefPercentage ?? ''}
                  onChange={(e) => onChange({ childReliefPercentage: e.target.value })}
                  {...ro}
                >
                  <option value="">{t('childReliefCategoryUnset')}</option>
                  <option value="100">{t('childReliefPct_100')}</option>
                  <option value="50">{t('childReliefPct_50')}</option>
                </select>
              </Field>
              <Field label={t('childAge')}>
                <input readOnly disabled value={childAgeYears(value.dateOfBirth) ?? '—'} className={`${inputCls} bg-muted/50`} />
              </Field>
              <div className="flex items-end pb-1">{check('childTaxRelief', t('childTaxRelief'))}</div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('ageHint')}</p>
          </fieldset>
        </>
      )}

      {(panel === 'spouse' || panel === 'other') && (
        <div className={grid}>
          {text('fullName', t('name'))}
          {genderField}
          {date('dateOfBirth', t('dateOfBirth'))}
          {text('phone', t('contactNumber'), 'tel')}
          {text('icOrPassport', t('newIc'))}
          {text('passportNumber', t('passportNumber'))}
          {area('residentialAddress', t('residentialAddress'))}
          {panel === 'spouse' && (
            <>
              {date('marriageDate', t('marriageDate'))}
              <Field label={t('marriageStatusLabel')}>
                <select
                  className={box}
                  value={value.marriageStatus ?? ''}
                  onChange={(e) => onChange({ marriageStatus: e.target.value })}
                  {...ro}
                >
                  <option value="">{t('genderUnset')}</option>
                  {DEPENDENT_MARRIAGE_STATUSES.map((m) => (
                    <option key={m} value={m}>
                      {t(`marriageStatus.${m}` as 'marriageStatus.married')}
                    </option>
                  ))}
                </select>
              </Field>
              {text('occupation', t('occupation'))}
              {text('companyName', t('companyName'))}
              {area('employerAddress', t('employerAddress'))}
            </>
          )}
          {panel === 'other' && text('occupation', t('occupation'))}
          {text('remarks', t('remarks'))}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 self-end pb-1 sm:col-span-2">
            {check('isBeneficiary', t('beneficiary'))}
            {panel === 'spouse' && check('spouseWorking', t('currentlyWorking'))}
            {check('isDeceased', t('deceasedStatus'))}
          </div>
        </div>
      )}
    </div>
  );
}
