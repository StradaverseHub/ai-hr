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
import { Field, inputCls } from '@/components/ui';
import { clientPackFor } from '@/localization/registry.client';

/** SOCSO contribution categories, in the order both screens show them. */
export const SOCSO_CATEGORIES = ['auto', 'first', 'second', 'none'] as const;
/** EIS has no First/Second split — only automatic derivation or off. */
export const EIS_CATEGORIES = ['auto', 'none'] as const;

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
      <Field label={t('socsoEisNumber')}>
        {props.mode === 'form' ? (
          <input name="socsoNumber" defaultValue={numberDefault} className={inputCls} />
        ) : (
          <input
            value={numberDefault}
            onChange={(e) => props.onChange({ socsoNumber: e.target.value })}
            className={inputCls}
            aria-label={t('socsoEisNumber')}
          />
        )}
      </Field>

      <Field label={t('socsoCategoryLabel')}>
        {props.mode === 'form' ? (
          <select name="socsoCategory" defaultValue={socsoCat} title={t('socsoCategoryHint')} className={inputCls}>
            {SOCSO_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`socsoCategory${c[0].toUpperCase()}${c.slice(1)}`)}
              </option>
            ))}
          </select>
        ) : (
          <select
            value={socsoCat}
            onChange={(e) => props.onChange({ socsoCategory: e.target.value })}
            title={t('socsoCategoryHint')}
            className={inputCls}
            aria-label={t('socsoCategoryLabel')}
          >
            {SOCSO_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`socsoCategory${c[0].toUpperCase()}${c.slice(1)}`)}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label={t('eisCategoryLabel')}>
        {props.mode === 'form' ? (
          <select name="eisCategory" defaultValue={eisCat} title={t('eisCategoryHint')} className={inputCls}>
            {EIS_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`eisCategory${c[0].toUpperCase()}${c.slice(1)}`)}
              </option>
            ))}
          </select>
        ) : (
          <select
            value={eisCat}
            onChange={(e) => props.onChange({ eisCategory: e.target.value })}
            title={t('eisCategoryHint')}
            className={inputCls}
            aria-label={t('eisCategoryLabel')}
          >
            {EIS_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`eisCategory${c[0].toUpperCase()}${c.slice(1)}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}
