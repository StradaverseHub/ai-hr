'use client';

/**
 * SOCSO & EIS — number plus the two contribution CATEGORY selects. The SEVENTH shared field group of item
 * 35b7af0a (Create New Employee wizard ↔ Personnel (Admin) Bank & Statutory tab). Same shape as groups
 * 1–6: one definition, a discriminated `mode`, both screens render it.
 *
 * ## THE WIZARD WAS A WHOLE CONSOLIDATION BEHIND, and that is not cosmetic
 *
 * Item `a7271737` made the CATEGORY the single per-scheme control on the Personnel screen, replacing the
 * old Subject-to-SOCSO / Subject-to-EIS booleans — 'No contribution' is the scheme off, 'Auto' keeps the
 * PERKESO age/citizenship derivation, and SOCSO additionally offers First and Second category.
 * `setStatutoryProfileMY` derives the legacy booleans FROM the category so the stored row stays
 * internally consistent.
 *
 * The wizard never followed. It still offered a single "EIS eligible" yes/no — the legacy boolean — and
 * no SOCSO category at all. So a hire created through the wizard could not be put in SOCSO First or
 * Second category at all, and whoever opened the same employee on the Personnel screen a minute later
 * saw a different question with more answers.
 *
 * It also had no SOCSO NUMBER default. The Personnel card has long defaulted a Malaysian employee's blank
 * SOCSO/EIS number to their (normalised) IC, because PERKESO registers locals under their MyKad. The
 * wizard left it blank, so hires created there arrived with an empty number that someone had to notice.
 *
 * ## BACK-COMPAT WITH DRAFTS SAVED BEFORE THIS CHANGE
 *
 * A draft may hold the legacy `eisEligible: 'yes' | 'no'` and no categories. `completeEmployeeDraft` maps
 * it forward ('no' ⇒ eisCategory 'none', anything else ⇒ 'auto'), so an old draft creates exactly the
 * employee it always would have. That mapping lives in the writer, not here — this component only
 * renders what it is given, and a draft that carries no category shows the same 'Auto' default the
 * Personnel card shows for a row that has none.
 *
 *   mode: 'form'        → `name`d inputs read out of FormData by setStatutoryAction (the Personnel card).
 *   mode: 'controlled'  → value/onChange bound to the wizard's draft state, and NO `name` at all.
 *
 * LABELS ARE READ WHERE THEY LIVE — `people.detail.*`, the Personnel card's own keys. The wizard's
 * `fields.socsoNumber` and `fields.eisEligible` are retired with this change. Checked first, per the trap
 * that nearly cost three keys in r159: `missingByTab` never returns either name, so the Review step's
 * computed t(`fields.${f}`) cannot ask for them.
 */
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import { PersonnelField } from '@/components/personnel-field';
import { personnelControl,personnelInput,personnelFormChoices,personnelFormLabel } from '@/lib/personnel-form-contract';
import { PERSONNEL_SOCSO_CATEGORIES,PERSONNEL_EIS_CATEGORIES } from '@/lib/personnel-choice-vocabulary';
import { clientPackFor } from '@/localization/registry.client';

/** SOCSO contribution categories, in the order both screens show them. */
export const SOCSO_CATEGORIES = PERSONNEL_SOCSO_CATEGORIES;
/** EIS has no First/Second split — only automatic derivation or off. */
export const EIS_CATEGORIES = PERSONNEL_EIS_CATEGORIES;

export type SocsoEisValue = {
  socsoNumber?: string | null;
  socsoCategory?: string | null;
  eisCategory?: string | null;
};

type Common = {
  /** Drives the Malaysian-IC default for a blank number; both screens pass what they know. */
  icNumber?: string | null;
  nationality?: string | null;
  /** ISO alpha-2 of the employing company, so the default comes from that country's pack, not a guess. */
  country?: string | null;
};

export function SocsoEisFields(
  props:
    | (Common & { mode: 'form'; defaults: SocsoEisValue })
    // The wizard's draft is `string | undefined` (JSON, no nulls), while the Personnel card reads
    // nullable db columns — so the controlled patch is narrowed to what a draft can actually hold.
    | (Common & {
        mode: 'controlled';
        value: SocsoEisValue;
        onChange: (patch: { socsoNumber?: string; socsoCategory?: string; eisCategory?: string }) => void;
      }),
) {
  const t = useTranslations('people.detail');
  const mode=props.mode==='controlled'?'draft':'edit';
  const label=(id:string)=>personnelFormLabel(id,(key,fallback)=>key.startsWith('people.detail.')?t(key.slice(14)):fallback);
  const current = props.mode === 'form' ? props.defaults : props.value;

  // The SAME default the Personnel card applies, from the company's own country pack rather than a
  // hardcoded jurisdiction. Undefined when the pack has no opinion (non-Malaysian, or a value already
  // entered), in which case the field simply shows what is stored.
  const pack = clientPackFor(props.country);
  const numberDefault =
    pack?.statutory?.defaultSocsoEisNumber({
      socsoNumber: current.socsoNumber,
      icNumber: props.icNumber,
      nationality: props.nationality,
    }) ?? current.socsoNumber ?? '';

  const socsoCat = current.socsoCategory ?? 'auto';
  const eisCat = current.eisCategory ?? 'auto';

  return (
    <>
      <PersonnelField fieldId="bank_statutory.socso_eis_and_others_statutory.socsonumber" mode={mode}>
        {props.mode === 'form' ? (
          <input {...personnelInput('bank_statutory.socso_eis_and_others_statutory.socsonumber',mode)} defaultValue={numberDefault} className={inputCls} />
        ) : (
          <input {...personnelInput('bank_statutory.socso_eis_and_others_statutory.socsonumber',mode)}
            value={numberDefault}
            onChange={(e) => props.onChange({ socsoNumber: e.target.value })}
            className={inputCls}
            aria-label={label('bank_statutory.socso_eis_and_others_statutory.socsonumber')}
          />
        )}
      </PersonnelField>

      <PersonnelField fieldId="bank_statutory.socso_eis_and_others_statutory.socsocategory" mode={mode}>
        {props.mode === 'form' ? (
          <select {...personnelControl('bank_statutory.socso_eis_and_others_statutory.socsocategory',mode)} defaultValue={socsoCat} title={t('socsoCategoryHint')} className={inputCls}>
            {personnelFormChoices('bank_statutory.socso_eis_and_others_statutory.socsocategory').map(({value:c,labelKey}) => (
              <option key={c} value={c}>
                {t(labelKey.slice(14))}
              </option>
            ))}
          </select>
        ) : (
          <select {...personnelControl('bank_statutory.socso_eis_and_others_statutory.socsocategory',mode)}
            value={socsoCat}
            onChange={(e) => props.onChange({ socsoCategory: e.target.value })}
            title={t('socsoCategoryHint')}
            className={inputCls}
            aria-label={label('bank_statutory.socso_eis_and_others_statutory.socsocategory')}
          >
            {personnelFormChoices('bank_statutory.socso_eis_and_others_statutory.socsocategory').map(({value:c,labelKey}) => (
              <option key={c} value={c}>
                {t(labelKey.slice(14))}
              </option>
            ))}
          </select>
        )}
      </PersonnelField>

      <PersonnelField fieldId="bank_statutory.socso_eis_and_others_statutory.eiscategory" mode={mode}>
        {props.mode === 'form' ? (
          <select {...personnelControl('bank_statutory.socso_eis_and_others_statutory.eiscategory',mode)} defaultValue={eisCat} title={t('eisCategoryHint')} className={inputCls}>
            {personnelFormChoices('bank_statutory.socso_eis_and_others_statutory.eiscategory').map(({value:c,labelKey}) => (
              <option key={c} value={c}>
                {t(labelKey.slice(14))}
              </option>
            ))}
          </select>
        ) : (
          <select {...personnelControl('bank_statutory.socso_eis_and_others_statutory.eiscategory',mode)}
            value={eisCat}
            onChange={(e) => props.onChange({ eisCategory: e.target.value })}
            title={t('eisCategoryHint')}
            className={inputCls}
            aria-label={label('bank_statutory.socso_eis_and_others_statutory.eiscategory')}
          >
            {personnelFormChoices('bank_statutory.socso_eis_and_others_statutory.eiscategory').map(({value:c,labelKey}) => (
              <option key={c} value={c}>
                {t(labelKey.slice(14))}
              </option>
            ))}
          </select>
        )}
      </PersonnelField>
    </>
  );
}
