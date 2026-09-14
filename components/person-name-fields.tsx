'use client';

/**
 * SALUTATION · FIRST NAME · LAST NAME · PREFERRED NAME · RELIGION · RACE — the Personnel Profile tab's
 * own Personal Details fields, shared with the Create New Employee draft (item a72610af).
 *
 * THE NINTH GROUP IN THE 35b7af0a SERIES, and it follows the same shape as the eight before it: one
 * definition, a discriminated `mode`, both screens render it, and the LABELS ARE READ WHERE THEY LIVE —
 * `people.detail.*`, the Personnel card's own keys. That is what keeps the two screens saying the same
 * words, and it is also why this change adds no message key: every string here already exists.
 *
 *   mode: 'form'        → `name`d inputs read out of FormData by `setPersonAction` (the Personnel card).
 *                         No function prop, so the card stays renderable from a server page (the r123
 *                         RSC-boundary fault).
 *   mode: 'controlled'  → value/onChange bound to the draft's React state, and NO `name` at all — the
 *                         wizard submits its draft as JSON, and a guard grepping for `name="religion"`
 *                         must not be able to conclude that this copy posts (the r159 lesson).
 *
 * THREE OF THE SIX ARE CATALOG-BACKED (`profile_option`: salutation / religion / race), and the catalog
 * is passed in rather than fetched, because this component renders on both a server page and a client
 * screen and only the caller knows which session to read it with. `ProfileOptionSelectControlled` carries
 * the legacy-value tolerance into the controlled rendering, so an off-catalog value stored on an older
 * record is still shown and still saved rather than silently blanked.
 *
 * EVERY FIELD IS OPTIONAL ON BOTH SCREENS. On the draft that is load-bearing: item 06f0cb8f split
 * creation from completion so that details stop blocking creation, and `missingByTab` judges none of
 * these. `fullName` is NOT here — it is required at Create and is the one name the record cannot be
 * without, so it keeps its own control on each screen.
 */
import { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import {
  ProfileOptionSelect,
  ProfileOptionSelectControlled,
  type ProfileOptionChoice,
} from '@/components/profile-option-select';

export type PersonNameValue = {
  salutation?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
  religion?: string | null;
  race?: string | null;
};

/**
 * What a controlled caller RECEIVES on a change. Deliberately narrower than `PersonNameValue`: reading a
 * value tolerates `null` (that is what a database column holds), but a control can only ever emit a
 * string, and the draft blob stores strings. Typing the patch as the wide shape would force every caller
 * to widen its own state to accept a `null` this component cannot produce.
 */
export type PersonNamePatch = { [K in keyof PersonNameValue]?: string };

/** The tenant's ACTIVE options for the three catalog-backed fields, resolved by the caller. */
export type PersonNameCatalogs = {
  salutation: ProfileOptionChoice[];
  religion: ProfileOptionChoice[];
  race: ProfileOptionChoice[];
};

type Common = {
  catalogs: PersonNameCatalogs;
  value: PersonNameValue;
  /**
   * Rendered between Salutation and First Name. It exists for ONE caller and one reason: the Personnel
   * card puts Full Name there (item 8c284478 fixed the order deliberately — Salutation, then the name),
   * and Full Name is not part of this group because it is REQUIRED and the draft asks for it at Create.
   * A slot keeps both screens' field order exactly as it is while the six fields around it have one
   * definition; moving Full Name to the end instead would have been a visible change to a live screen
   * that nobody asked for. It is an RSC subtree, passed straight through and never inspected.
   */
  afterSalutation?: ReactNode;
};

export function PersonNameFields(
  props:
    | (Common & { mode: 'form' })
    | (Common & { mode: 'controlled'; onChange: (patch: PersonNamePatch) => void }),
) {
  const t = useTranslations('people.detail');
  const v = props.value;

  /** One catalog dropdown, in whichever of the two shapes this screen needs. */
  const catalog = (key: 'salutation' | 'religion' | 'race') =>
    props.mode === 'form' ? (
      <ProfileOptionSelect
        name={key}
        value={v[key]}
        // Both renderings take the same narrow shape: the Personnel page passes full catalog rows (which
        // satisfy it), the wizard passes the trimmed rows it ships to the browser.
        options={props.catalogs[key]}
        placeholder={t('optionNotSet')}
        legacySuffix={t('optionLegacySuffix')}
      />
    ) : (
      <ProfileOptionSelectControlled
        value={v[key]}
        options={props.catalogs[key]}
        placeholder={t('optionNotSet')}
        legacySuffix={t('optionLegacySuffix')}
        onChange={(value) => props.onChange({ [key]: value })}
      />
    );

  /** One plain text box, in whichever of the two shapes this screen needs. */
  const text = (key: 'firstName' | 'lastName' | 'preferredName') => (
    <input
      className={inputCls}
      {...(props.mode === 'form'
        ? { name: key, defaultValue: v[key] ?? '' }
        : { value: v[key] ?? '', onChange: (e) => props.onChange({ [key]: e.target.value }) })}
    />
  );

  return (
    <>
      {/* 8c284478 — Salutation BEFORE the names, which is the natural data-entry order and the order the
          Personnel card has used since that item. */}
      <Field label={t('salutation')}>{catalog('salutation')}</Field>
      {props.afterSalutation}
      <Field label={t('firstName')}>{text('firstName')}</Field>
      <Field label={t('lastName')}>{text('lastName')}</Field>
      <Field label={t('preferredName')}>{text('preferredName')}</Field>
      {/* PDPA 2010 s.40 sensitive demographics. Catalog-backed like Salutation, and optional: nothing in
          the product requires either, and a blank one stores null. */}
      <Field label={t('religion')}>{catalog('religion')}</Field>
      <Field label={t('race')}>{catalog('race')}</Field>
    </>
  );
}

/**
 * HOME PHONE + PERSONAL E-MAIL — the two Contact & Address fields the draft did not have.
 *
 * SEPARATE FROM THE GROUP ABOVE because they belong to a different CARD on both screens: the Personnel
 * record puts the names and demographics on "Personal details" and the contact details on
 * "Contact & address", and the draft's tabs mirror that. One component per card section, so neither
 * screen has to split a group across two headings.
 *
 * `phone` IS NOT HERE. bf953339 renamed it to Mobile Phone Number and it already exists on both screens;
 * on Personnel it additionally carries the `perm-mobile-phone` / `perm-home-phone` ids that the
 * "Same as Permanent Address" island coordinates by, so that pair stays where it is.
 */
export type PersonContactExtraValue = { homePhone?: string | null; personalEmail?: string | null };
/** The emitted shape, narrowed for the same reason `PersonNamePatch` is. */
export type PersonContactExtraPatch = { [K in keyof PersonContactExtraValue]?: string };

export function PersonContactExtraFields(
  props:
    | { mode: 'form'; value: PersonContactExtraValue; homePhoneId?: string }
    | { mode: 'controlled'; value: PersonContactExtraValue; onChange: (patch: PersonContactExtraPatch) => void },
) {
  const t = useTranslations('people.detail');
  const v = props.value;
  return (
    <>
      <Field label={t('homePhone')}>
        <input
          className={inputCls}
          {...(props.mode === 'form'
            ? { id: props.homePhoneId, name: 'homePhone', defaultValue: v.homePhone ?? '' }
            : { value: v.homePhone ?? '', onChange: (e) => props.onChange({ homePhone: e.target.value }) })}
        />
      </Field>
      <Field label={t('personalEmail')}>
        <input
          type="email"
          className={inputCls}
          {...(props.mode === 'form'
            ? { name: 'personalEmail', defaultValue: v.personalEmail ?? '' }
            : {
                value: v.personalEmail ?? '',
                onChange: (e) => props.onChange({ personalEmail: e.target.value }),
              })}
        />
      </Field>
    </>
  );
}
