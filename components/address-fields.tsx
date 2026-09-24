'use client';

/**
 * ONE ADDRESS BLOCK — the seven fields the activated employee's Contact & Address card has rendered since
 * item 3a25f5ee, extracted here by item da7463b4 so the Create New Employee DRAFT renders the SAME seven
 * rather than a second arrangement of them.
 *
 * WHY EXTRACT RATHER THAN COPY. The ticket behind this component is a DRIFT complaint: the draft screen
 * and the activated screen ask different questions about the same person. Answering it by writing a
 * second address form on the draft would recreate the complaint one release later — two label sets, two
 * field orders, two ideas of which values are catalog-backed. So the block is defined once and both
 * screens render it, exactly as items 35b7af0a and a72610af did for the eight groups before it.
 *
 * TWO MODES, the shape every shared group in this directory uses:
 *
 *   mode: 'form'        → `name`d, uncontrolled inputs read out of FormData by `setContactAddressAction`,
 *                         plus the `perm-`/`corr-` DOM ids the "Same as Permanent Address" island
 *                         coordinates by (components/same-as-permanent-address.tsx). NO function props,
 *                         so the RSC Personnel page can render it (test/server-client-boundary.test.ts
 *                         pins that class of fault — a closure crossing the boundary 500s every request
 *                         while tsc, the suite and `next build` stay green).
 *   mode: 'controlled'  → `value` + `onChange` bound to the draft's React state, and NO `name` at all
 *                         (the r159 lesson: the draft posts JSON, so a guard grepping for a form name
 *                         must never be able to conclude that this copy submits).
 *
 * THE IDS ARE A CONTRACT, NOT DECORATION. `perm-<suffix>` / `corr-<suffix>` is what the island resolves,
 * and the suffixes are declared in lib/address-blocks.ts alongside the field-key pairing the draft copies
 * by. test/address-block-parity.test.ts pins the two halves together.
 *
 * DISABLED IS PART OF THE PRODUCT HERE. On the draft, while "same as permanent" is ticked, the
 * Correspondence side is a DERIVED view of the Permanent side — see the header of
 * SameAsPermanentAddressControlled for why a copy you can type into is how the pair drifts apart.
 *
 * ONE NAMESPACE PER FILE and every key a literal: test/i18n-coverage.test.ts check C silently SKIPS any
 * file using more than one translation namespace and cannot see a computed key. The keys are
 * `people.detail.*` — the activated card's OWN words, so no catalogue gains a key and the draft cannot
 * word an address question differently from the record it becomes.
 */

import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import { SameAsPermanentAddressControlled } from '@/components/same-as-permanent-address';
import { ProfileOptionSelect, ProfileOptionSelectControlled, type ProfileOptionChoice } from '@/components/profile-option-select';

/** The seven values one block holds, keyed by the id suffix rather than by column, so ONE type serves
 *  both the `permanent*` and the `correspondence*` columns without naming either. */
export type AddressBlockValue = {
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
};

type Common = {
  /** 'perm' or 'corr' — decides the DOM ids, and in form mode the `permanent`/`correspondence` name stem. */
  side: 'perm' | 'corr';
  value: AddressBlockValue;
  stateOptions: ProfileOptionChoice[];
  countryOptions: ProfileOptionChoice[];
  /** Classes for the three address LINES, which the activated card widens across its four-column grid.
   *  Defaulted rather than hardcoded so a caller's grid decides the layout, not this file. */
  lineClassName?: string;
};

export type AddressBlockFieldsProps = Common &
  (
    | { mode: 'form' }
    | {
        mode: 'controlled';
        onChange: (patch: AddressBlockValue) => void;
        /** Ticked "same as permanent" makes the correspondence side a derived view, not an input. */
        disabled?: boolean;
      }
  );

/** form mode's `name` stem. The columns are `permanentAddressLine1` / `correspondenceAddressLine1`, so
 *  the stem is the long word and the id prefix is the short one; both are declared here rather than
 *  assembled at three call sites. */
const NAME_STEM = { perm: 'permanent', corr: 'correspondence' } as const;

export function AddressBlockFields(props: AddressBlockFieldsProps) {
  const t = useTranslations('people.detail');
  const { side, value, stateOptions, countryOptions } = props;
  const id = (suffix: string) => `${side}-${suffix}`;
  const name = (suffix: string) => `${NAME_STEM[side]}${suffix[0].toUpperCase()}${suffix.slice(1)}`;
  const lineCls = props.lineClassName ?? inputCls;
  const disabled = props.mode === 'controlled' ? props.disabled === true : false;

  /** One free-text row. The two modes differ only in how the value is held, so the difference is a spread
   *  rather than two JSX trees that could fall out of step. */
  const text = (suffix: 'addressLine1' | 'addressLine2' | 'addressLine3' | 'postcode' | 'city', cls: string) => (
    <input
      id={id(suffix)}
      className={cls}
      {...(props.mode === 'form'
        ? { name: name(suffix), defaultValue: value[suffix] ?? '' }
        : {
            value: value[suffix] ?? '',
            disabled,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => props.onChange({ [suffix]: e.target.value }),
          })}
    />
  );

  return (
    <>
      <Field label={t('addressLine1')}>{text('addressLine1', lineCls)}</Field>
      <Field label={t('addressLine2')}>{text('addressLine2', lineCls)}</Field>
      <Field label={t('addressLine3')}>{text('addressLine3', lineCls)}</Field>
      <Field label={t('postcode')}>{text('postcode', inputCls)}</Field>
      <Field label={t('city')}>{text('city', inputCls)}</Field>
      {/* State and Country are CATALOG-BACKED on both screens (7d309da7), including the legacy-value
          tolerance that keeps an off-catalog stored value selected so a save can never blank it. The two
          renderings of that rule already exist as one pair of components; this group only chooses between
          them, it does not restate the rule. */}
      <Field label={t('stateLabel')}>
        {props.mode === 'form' ? (
          <ProfileOptionSelect
            id={id('state')}
            name={name('state')}
            value={value.state}
            options={stateOptions}
            placeholder={t('optionNotSet')}
            legacySuffix={t('optionLegacySuffix')}
          />
        ) : (
          <ProfileOptionSelectControlled
            id={id('state')}
            value={value.state}
            options={stateOptions}
            disabled={disabled}
            placeholder={t('optionNotSet')}
            legacySuffix={t('optionLegacySuffix')}
            onChange={(v) => props.onChange({ state: v })}
          />
        )}
      </Field>
      <Field label={t('country')}>
        {props.mode === 'form' ? (
          <ProfileOptionSelect
            id={id('country')}
            name={name('country')}
            value={value.country}
            options={countryOptions}
            placeholder={t('optionNotSet')}
            legacySuffix={t('optionLegacySuffix')}
          />
        ) : (
          <ProfileOptionSelectControlled
            id={id('country')}
            value={value.country}
            options={countryOptions}
            disabled={disabled}
            placeholder={t('optionNotSet')}
            legacySuffix={t('optionLegacySuffix')}
            onChange={(v) => props.onChange({ country: v })}
          />
        )}
      </Field>
    </>
  );
}


/**
 * The two block headings and the tick's label — read HERE, in a single-namespace file, rather than passed
 * down as props (the precedent is `PassportSectionTitle`, components/passport-fields.tsx).
 *
 * THAT IS NOT A STYLE CHOICE. app/admin/personnel/new/wizard.tsx uses `people.wizard` and nothing else;
 * the moment it reads a second namespace, test/i18n-coverage.test.ts check C SKIPS THE WHOLE FILE and
 * every `people.wizard.*` key in that screen silently stops being checked. So the record's own words come
 * across inside components that already speak `people.detail`, and the draft gains no key of its own —
 * which also means it cannot word an address question differently from the record it becomes.
 */
export function PermanentAddressTitle({ className }: { className?: string }) {
  const t = useTranslations('people.detail');
  return <p className={className ?? 'text-sm font-medium text-foreground'}>{t('permanentAddressTitle')}</p>;
}

export function CorrespondenceAddressTitle({ className }: { className?: string }) {
  const t = useTranslations('people.detail');
  return <p className={className ?? 'text-sm font-medium text-foreground'}>{t('correspondenceAddressTitle')}</p>;
}

/** The tick, labelled with the record's own `people.detail.sameAsPermanent`. See
 *  SameAsPermanentAddressControlled for what it promises on a draft and how that differs from the
 *  activated record's transient version. */
export function SameAsPermanentTick({
  checked,
  onChange,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  const t = useTranslations('people.detail');
  return <SameAsPermanentAddressControlled label={t('sameAsPermanent')} checked={checked} onChange={onChange} className={className} />;
}

/**
 * The Correspondence block's OWN Mobile / Home phone pair (item bf953339), as the activated record
 * renders it: independent of the person's `phone` / `homePhone` so the correspondence contact may differ,
 * and copied together with the address by "same as permanent" (lib/address-blocks.ts pairs them).
 *
 * CONTROLLED ONLY. The activated record's copy of this pair is plain `name`d inputs inside its own
 * server-action form, written inline in that page beside the `corr-` ids the island needs; there is
 * nothing for a `form` mode here to add that the page does not already say more directly.
 */
export function CorrespondencePhoneFields({
  mobile,
  home,
  disabled,
  onChange,
}: {
  mobile?: string;
  home?: string;
  disabled?: boolean;
  onChange: (patch: { correspondenceMobilePhone?: string; correspondenceHomePhone?: string }) => void;
}) {
  const t = useTranslations('people.detail');
  return (
    <>
      <Field label={t('phone')}>
        <input
          id="corr-mobile-phone"
          className={inputCls}
          value={mobile ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ correspondenceMobilePhone: e.target.value })}
        />
      </Field>
      <Field label={t('homePhone')}>
        <input
          id="corr-home-phone"
          className={inputCls}
          value={home ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ correspondenceHomePhone: e.target.value })}
        />
      </Field>
    </>
  );
}
