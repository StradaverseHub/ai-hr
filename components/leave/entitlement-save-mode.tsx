'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import {
  entitlementEditMode,
  entitlementInPlaceChangesThePast,
  type EntitlementEditMode,
} from '@/lib/entitlement-edit-mode';
import { Field, btnPrimary, inputCls } from '@/components/ui';

/**
 * r224 — THE SAVE BUTTON SAYS WHICH OF THE TWO WRITES IT IS ABOUT TO MAKE, AND THE DATE BOX STOPS
 * CHANGING THE ANSWER BEHIND THE OPERATOR'S BACK.
 *
 * ⚠️ THE DEFECT THIS FIXES WAS NOT THE LABELS. The reporter said the screen forces a new version on every
 * edit, and it did — but not through the Edit control and not through the button. Both editors PRE-FILLED
 * the Effective from box with TODAY when opening a version that was already in force. `entitlementEditMode`
 * returns 'in-place' only when `newValidFrom === openValidFrom`, so a pre-fill of today guaranteed
 * 'supersede' for every version whose start date was in the past. The operator changed the date without
 * touching it, and changing the date is precisely what asks for a new version. In-place saving was built,
 * tested (test/r219-entitlement-effective-date.test.ts §B) and unreachable.
 *
 * So the box now opens on the version's OWN start date, and this module exists because that single change
 * must not ship alone: it silently converts an operator's habitual unchanged Save from supersede to
 * in-place. Two things go with it, both here:
 *
 *   · the BUTTON is labelled from `entitlementEditMode` over the date CURRENTLY in the box, so it says
 *     "Save changes" or "Save as a new version" according to what pressing it will actually do; and
 *   · an in-place save of a version that HAS been in force carries a warning naming the consequence —
 *     three readers resolve entitlement at a past date, so overwriting a long-running version changes what
 *     a closed leave year reports (`entitlementInPlaceChangesThePast`).
 *
 * ⚠️ THE LABEL AND THE WRITE READ THE SAME FUNCTION. `entitlementEditMode` is imported from
 * `lib/entitlement-edit-mode.ts`, which is the very module both service writers call — that is why it was
 * moved out of `core/entitlement-template.ts` (which cannot cross the client boundary). A second copy of
 * "is this a supersede" living in the form is how a button comes to promise one write while the service
 * performs the other, silently, in the one place where the difference is a closed year's figures.
 *
 * ⚠️ IT IS A CLIENT MODULE AND IT RESOLVES ITS OWN LABELS. Nothing but plain strings crosses the boundary
 * from the server component that mounts it — `test/server-client-boundary.test.ts` pins the class after
 * r123 took a production tab down with a translator closure.
 *
 * ⚠️ AND IT DOES NOT ADD A SECOND SUBMIT. ADR-0001 makes the dated version the record of what was true
 * when; a Save that overwrites an in-force version regardless of date is exactly what the supersede arm
 * exists to prevent. ONE button whose label tracks the resolved mode gives the reporter the ordinary edit
 * they asked for without introducing a second write path.
 */

/** What the form should say about the save the operator is one click away from making. */
export type EntitlementSaveMode = {
  /** null ⇒ this is a CREATE form: there is no running version, so there is no mode to resolve. */
  mode: EntitlementEditMode | null;
  /** In-place over a version that has already been in force — the save that reaches backwards. */
  changesThePast: boolean;
  /** The submit button's text. */
  label: string;
  /** The sentence under the form, or null on a create form (there is no version to close). */
  note: string | null;
  /** The consequence of `changesThePast`, in words, or null. */
  warning: string | null;
};

/**
 * Resolve the copy for one form, from the date CURRENTLY in its box.
 *
 * @param openValidFrom the running version's own start date, or null while creating.
 * @param validFrom     what is in the date box right now. An EMPTY box (mid-typing in a `type=date` input)
 *                      is read as the version's own date rather than as a date change — otherwise the
 *                      caption and the button would flap through 'refuse' on the way to every keystroke.
 */
export function useEntitlementSaveMode(p: {
  openValidFrom: string | null;
  validFrom: string;
  today: string;
  /** The button's text while creating — the caller's own ("Create table" / "Create rule"). */
  createLabel: string;
}): EntitlementSaveMode {
  const t = useTranslations('admin.entitlementTemplates');
  if (p.openValidFrom == null) {
    return { mode: null, changesThePast: false, label: p.createLabel, note: null, warning: null };
  }
  const dates = {
    openValidFrom: p.openValidFrom,
    newValidFrom: p.validFrom || p.openValidFrom,
    today: p.today,
  };
  const mode = entitlementEditMode(dates);
  const changesThePast = entitlementInPlaceChangesThePast(dates);
  const label =
    mode === 'supersede' ? t('saveNewVersion') : mode === 'refuse' ? t('saveDateRefused') : t('saveThisVersion');
  const note =
    mode === 'supersede'
      ? t('supersedeNote')
      : mode === 'refuse'
        ? t('refuseNote', { from: p.openValidFrom })
        : changesThePast
          ? t('inPlaceInForceNote')
          : t('editInPlaceNote');
  return {
    mode,
    changesThePast,
    label,
    note,
    warning: changesThePast ? t('inPlaceStartedWarning', { from: p.openValidFrom }) : null,
  };
}

/** The note under the form, and the past-changing warning when there is one. */
export function EntitlementSaveModeCaption({ save }: { save: EntitlementSaveMode }) {
  if (!save.note && !save.warning) return null;
  return (
    <div className="space-y-1">
      {save.note ? (
        <p
          className={
            save.mode === 'refuse'
              ? 'text-xs font-medium text-red-700 dark:text-red-400'
              : 'text-xs text-muted-foreground'
          }
        >
          {save.note}
        </p>
      ) : null}
      {save.warning ? (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-500">{save.warning}</p>
      ) : null}
    </div>
  );
}

// ── The template form's three pieces, which are three because the form's LAYOUT separates them ────────
//
// The date box sits in a three-column grid at the top of the form, the note sits under the bands editor
// and the button sits in the footer. They nevertheless share ONE piece of state — what is in the date box
// — so the state lives in a provider wrapping the form and the three consumers read it. The alternative
// (turning the whole server-rendered form into a client component) would drag the leave-type picker, the
// hidden return field and the server actions across the boundary for no gain.

type SaveModeCtx = {
  openValidFrom: string | null;
  validFrom: string;
  setValidFrom: (v: string) => void;
  today: string;
};

const Ctx = createContext<SaveModeCtx | null>(null);

function useCtx(): SaveModeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('EntitlementSaveMode: mount this inside <EntitlementSaveModeProvider>');
  return c;
}

/**
 * ⚠️ KEY THIS ON THE RECORD BEING EDITED, EXACTLY AS `EntitlementBandsEditor` NEXT DOOR IS KEYED.
 *
 * `useState(openValidFrom ?? today)` reads its argument ONLY on first mount, and the Edit control is a
 * next/link `Link` — reaching this form is a CLIENT-SIDE navigation, so React re-renders the same instance
 * and the new initial date is discarded. Without the key, clicking Edit on a second table while already
 * standing in the editor would leave the first table's date in the box, and the Save button would label
 * itself from a date belonging to a different record. The bands editor lost an 18-day table to this exact
 * shape (4a1abc4a); here it would mis-date a version instead.
 */
export function EntitlementSaveModeProvider({
  openValidFrom,
  today,
  children,
}: {
  openValidFrom: string | null;
  today: string;
  children: ReactNode;
}) {
  const [validFrom, setValidFrom] = useState(openValidFrom ?? today);
  return <Ctx.Provider value={{ openValidFrom, validFrom, setValidFrom, today }}>{children}</Ctx.Provider>;
}

/**
 * The Effective from box — CONTROLLED, because the button's label is a function of what is in it.
 *
 * Its default is the running version's OWN start date (r224's actual fix), and `today` only while
 * creating. It posts under `validFrom`, exactly as the uncontrolled input it replaces did.
 */
export function EntitlementEffectiveFromField() {
  const t = useTranslations('admin.entitlementTemplates');
  const c = useCtx();
  return (
    <Field label={t('effectiveFrom')}>
      <input
        className={inputCls}
        type="date"
        name="validFrom"
        value={c.validFrom}
        onChange={(e) => c.setValidFrom(e.target.value)}
        required
      />
    </Field>
  );
}

/** The note + warning for the template form, read from the provider. */
export function EntitlementSaveModeNote() {
  const c = useCtx();
  const save = useEntitlementSaveMode({ ...c, createLabel: '' });
  return <EntitlementSaveModeCaption save={save} />;
}

/** The template form's submit, labelled with the write it is about to make. */
export function EntitlementSaveModeSubmit({ createLabel }: { createLabel: string }) {
  const c = useCtx();
  const save = useEntitlementSaveMode({ ...c, createLabel });
  return (
    <button type="submit" className={btnPrimary}>
      {save.label}
    </button>
  );
}
