import { packFor } from '@/localization/registry';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { listPayComponents } from '@/core/pay-components';
import {
  EA_FORM_LINES,
  listPayComponents as loadPayComponents,
  listPayRulePreviewCandidates,
  PAY_DISPLAY_CATEGORIES,
  ROUNDING_METHODS,
} from '@/core/pay-components';
import { isStatutoryComponent } from '@/core/pay-rule';
import { requireAdmin } from '@/lib/authz';
import type { PayRule } from '@/core/pay-rule';
import { Card, ErrorBanner, Field, PageHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { OrpConfig } from './orp-config';
import { PayRuleEditor } from './pay-rule-editor';
import { StatutoryConfig } from './statutory-config';
import { createComponentAction, updateComponentAction } from './actions';

const LIST = '/admin/pay-components';

export type PayComponentRow = Awaited<ReturnType<typeof listPayComponents>>[number];

/**
 * Pay Code maintenance screen (feedback 911b2886, layout redesign 13b7517b) — the shared Create / Edit
 * form, extracted from the old inline block on the list page and rendered by the dedicated /new and
 * /[code] routes (attendance-rule precedent: rules/rule-form.tsx). Server component: it RENDERS the
 * PayRuleEditor client island as JSX, keeping the RSC boundary clean. Three sections — Basic Information
 * (identity), Pay Settings (how it is calculated: rounding + the pay rule) and Government Statutory
 * Configuration (EPF / SOCSO-EIS / PCB / HRDF mappings) — with a Save / Save & New / Cancel toolbar.
 * The derived Input Type field was removed from this screen (13b7517b): it was read-only display with no
 * functional impact; the list page keeps its own Input Type column and derivation. 61bf109d rev2 turned
 * that column into a LINK here — the EDITABLE Input Type selector and the Formula builder have always been
 * inside Pay Settings below, and nothing on the list said so, which is how the reporter concluded they were
 * missing. Hence the section's new one-line subtitle. `error` comes from the action's redirect-with-error
 * and renders through ErrorBanner above the form (the global ToastFromQuery still fires as well, same as
 * attendance).
 */
export async function ComponentForm({
  component,
  aiEnabled,
  error,
  copy = false,
}: {
  component: PayComponentRow | null;
  aiEnabled: boolean;
  error?: string;
  // a6da1387 — Copy Pay Code: `component` is the SOURCE to pre-fill from, but this is a CREATE, not an edit.
  // `copy` keeps `editing` false (CREATE action, editable + blank Pay Code) while every other field defaults
  // from the source below.
  copy?: boolean;
}) {
  const t = await getTranslations('payComponents');
  const editing = !!component && !copy;

  // 61bf109d — the two lists the Input Type / Formula editor needs, resolved server-side so the client
  // island never queries. Referenceable pay items exclude THIS item (a rule cannot read itself — the server
  // rejects it with SELF_REFERENCE, and the picker should not offer the mistake in the first place) and
  // every statutory line (legislated, out of bounds for a tenant rule).
  const s = await requireAdmin();
  const [allItems, previewEmployees] = await Promise.all([loadPayComponents(s), listPayRulePreviewCandidates(s)]);
  const payItems = allItems
    // In copy mode the source's own code is offered too: the new item is a distinct code and may legitimately
    // reference the one it was copied from (self-exclusion only applies to a rule reading ITSELF, which the
    // blank new code cannot yet do).
    .filter((c) => (copy || c.code !== component?.code) && !isStatutoryComponent(c.code, c.kind))
    .map((c) => ({ code: c.code, name: c.label ?? c.name }));

  return (
    // 711adcd2 — FULL WIDTH, THROUGH THE SHARED CONSTANT. The screen used to carry a width cap here, which
    // is what put the reporter's four sections into a narrow strip with the ORP card they asked for having
    // nowhere to go. The cap's class name is deliberately not written out anywhere in this file, comments
    // included: the layout guard scans this source for it and does not strip comments (AGENTS 27).
    //
    // `pageWideCls` rather than its literal value: test/payroll-screens-layout.test.ts requires every
    // widened screen to APPLY the named constant, so the module's width stays ONE decision in one place
    // instead of a string each screen re-types and can drift on. This file previously spelled the same
    // characters out by hand, which is why the guard failed it even though the rendering was already right.
    <div className={pageWideCls}>
      <PageHeader
        title={editing ? t('editTitle', { code: component!.code }) : copy ? t('copyTitle') : t('createTitle')}
        back={{ href: LIST, label: t('backToList') }}
      />
      <ErrorBanner message={error} />

      <form action={editing ? updateComponentAction : createComponentAction} className="space-y-6">
        {/* ea54fe6e — the EA-form-line CONTROL IS BACK. It was replaced by a hidden passthrough in the
            4994a48f redesign, pending "a dedicated statutory module later" that never came: the column
            kept saving, validating and auditing, the list kept a column for it, and nobody could set it.
            The card sits below, beside the statutory configuration it belongs with. */}

        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('sectionBasic')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('colCode')}>
              <input
                name="code"
                required
                readOnly={editing}
                defaultValue={copy ? '' : (component?.code ?? '')}
                placeholder="HOUSING"
                pattern="[A-Za-z0-9_]+"
                className={`${inputCls} font-mono uppercase ${editing ? 'opacity-60' : ''}`}
              />
            </Field>
            <Field label={t('colLabel')}>
              <input name="label" defaultValue={component?.label ?? ''} placeholder={t('labelPlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('colName')}>
              <input name="name" required defaultValue={component?.name ?? ''} placeholder={t('namePlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('colKind')}>
              <select name="kind" defaultValue={component?.kind ?? 'allowance'} className={inputCls}>
                <option value="allowance">{t('kind_allowance')}</option>
                <option value="deduction">{t('kind_deduction')}</option>
                <option value="contribution">{t('kind_contribution')}</option>
                <option value="non_payable">{t('kind_non_payable')}</option>
              </select>
            </Field>
            {/* Feedback 3c473773 — Payroll Category. It decides WHICH BOX on the payslip this item's money
                appears in, and nothing else: no statutory flag, no statutory base, and no EA / CP39 / KWSP
                / PERKESO grouping reads it. It exists because the box used to be inferred from the tax
                treatment, so an overtime code correctly declared as additional remuneration printed under
                Bonus. Blank keeps that inference (which is what an unclassified legacy row does). */}
            <Field label={t('colDisplayCategory')}>
              <select name="displayCategory" defaultValue={component?.displayCategory ?? ''} className={inputCls}>
                <option value="">{t('displayCategory_auto')}</option>
                {PAY_DISPLAY_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{t(`displayCategory_${c}`)}</option>
                ))}
              </select>
            </Field>
            <Field label={t('colStatus')}>
              <input
                readOnly
                value={!copy && component?.archivedAt ? t('statusInactive') : t('statusActive')}
                className={`${inputCls} opacity-60`}
              />
            </Field>
            <p className="text-xs text-muted-foreground sm:col-span-3">{t('displayCategoryHint')}</p>
          </div>
        </Card>

        {/* 711adcd2 — ORDINARY RATE OF PAY. Second card, exactly where the reporter drew it: the two
            questions it asks are about the item's IDENTITY (what kind of money is this, and which rates
            does it feed), so they belong beside Category, above the mechanics of how the amount is worked
            out. Both boxes are independent — either, both or neither. */}
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('sectionOrp')}</h2>
          <OrpConfig
            // Defaults for a BRAND-NEW item mirror what the system did before the switch existed: a new
            // Earning fed the overtime aggregate automatically, and nothing at all fed the unpaid-leave
            // base. An operator who creates an item and never opens this card therefore gets exactly the
            // pre-0456 behaviour, which is the same promise migration 0456 keeps for the existing 29.
            orpUnpaidLeave={component?.orpUnpaidLeave ?? false}
            // ⚠️ KIND-AWARE, and it was not. `?? true` pre-ticked Overtime on EVERY new item, so creating
            // the reporter's own pairing (Category = Non-Payable + Payroll Category = Benefit in Kind) and
            // saving without ever opening this card stored orp_overtime = true — which then made the admin
            // preview quote a figure the run does not pay. The pre-0456 answer was the KIND test, and this
            // is that test: a new Earning fed the aggregate, nothing else did.
            orpOvertime={component?.orpOvertime ?? (component?.kind ?? 'allowance') === 'allowance'}
            kind={component?.kind ?? 'allowance'}
          />
        </Card>

        {/* Pay Settings (13b7517b) — calculation concerns grouped in their own card: the rounding method
            and the "How is this calculated?" pay-rule editor, clearly separated from the statutory card
            below. Everything stays inside the single form, so submission is unchanged.
            61bf109d rev2 adds the one-line subtitle: the heading alone named the card but not its CONTENTS,
            and the reporter went looking for Input Type and Formula without ever opening this section. */}
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('sectionPaySettings')}</h2>
          <p className="text-xs text-muted-foreground">{t('sectionPaySettingsHint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('colRounding')}>
              <select name="roundingMethod" defaultValue={component?.roundingMethod ?? 'none'} className={inputCls}>
                {ROUNDING_METHODS.map((m) => (
                  <option key={m} value={m}>{t(`rounding_${m}`)}</option>
                ))}
              </select>
            </Field>
            {/* Payroll Setup — configurable pay-rule + AI assist. The Prorates checkbox lives inside this island
                (it interacts with per-day/per-hour rules) and is submitted as the form's `prorates` field. */}
            <PayRuleEditor
              code={copy ? '' : (component?.code ?? '')}
              kind={component?.kind ?? 'allowance'}
              prorates={component?.prorates ?? true}
              rule={(component?.rule ?? null) as PayRule | null}
              aiEnabled={aiEnabled}
              payItems={payItems}
              previewEmployees={previewEmployees.map((e) => ({
                employmentId: e.employmentId,
                name: e.name,
                // e318eaec — the ID is half of the option label ("Irwin Law (X000001)") and half of what the
                // search matches on, so it has to cross the RSC boundary with the name.
                employeeCode: e.employeeCode,
              }))}
            />
          </div>
        </Card>

        {/* Government Statutory Configuration (13b7517b rename) — statutory mappings ONLY: EPF (KWSP),
            SOCSO (PERKESO) / EIS, PCB and HRDF, with room for future schemes. */}
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('sectionConfig')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* Feedback 09b554e9 — statutory flags grouped into EPF / PCB / Other panels. The PCB panel
                reveals the mandatory Remuneration Type + dynamic Exemption Type dropdowns (LHDN PCB 2026);
                EPF Bonus 2012 is only tickable with EPF itself. Client island: the exemption list filters
                with the remuneration type without a round trip (server action re-validates). */}
            <StatutoryConfig
              includedInEpf={component?.includedInEpf ?? true}
              epfBonus2012={component?.epfBonus2012 ?? false}
              includedInSocsoEis={component?.includedInSocsoEis ?? true}
              includedInPcb={component?.includedInPcb ?? true}
              includedInHrdfBase={component?.includedInHrdfBase ?? false}
              pcbRemunerationType={component?.pcbRemunerationType ?? null}
              pcbExemptionCode={component?.pcbExemptionCode ?? null}
            />
            <p className="text-xs text-muted-foreground sm:col-span-3">{t('flagsHint')}</p>
          </div>
        </Card>

        {/* ea54fe6e — EA FORM REPORTING. One control, deliberately: where this item's money is REPORTED on
            the C.P.8A. It changes no calculation and no statutory flag, which is why it is its own card
            rather than a fourth column in the statutory grid above. `cleanEaLine` re-validates server-side
            and silently nulls anything it does not recognise, so the empty option is a real "unmapped". */}
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('sectionEaForm')}</h2>
          {/* The year a mapping starts printing is a MY-pack fact, and Pay Items is a GENERIC admin
              screen: importing localization/my here is what the ADR-0080 D7 ratchet refuses (and its
              allowlist only ever shrinks). The EA statement carries that year instead, out of the
              statement DATA rather than an import — which is also where an operator is looking when the
              answer matters. */}
          <p className="text-xs text-muted-foreground">{t('sectionEaFormHint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('colEaLine')}>
              <select name="eaFormLine" defaultValue={component?.eaFormLine ?? (component?.kind === 'deduction' || component?.kind === 'non_payable' || component?.kind === 'contribution' ? '' : 'EA_B1A')} className={inputCls}>
                <option value="">{t('eaLineNone')}</option>
                {(packFor('MY')?.eaReporting ?? []).filter(e => e.active).map(e => <option key={e.code} value={e.code}>{e.label}</option>)}
                {component?.eaFormLine && !component.eaFormLine.startsWith('EA_') && <option value={component.eaFormLine}>{t(`eaLine_${component.eaFormLine}`)}</option>}

              </select>
            </Field>
          </div>
        </Card>

        {/* Bottom toolbar — 711adcd2 puts Cancel and Save at the bottom RIGHT, as drawn, with Back already
            top-left in the PageHeader. Save & New keeps its place between them: it is a save, not a third
            destructive choice, and removing it would take away a shortcut this screen has always had. */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href={LIST} className="text-sm font-medium text-muted-foreground hover:text-foreground">
            {t('cancelEdit')}
          </Link>
          <button name="intent" value="saveAndNew" className={btnGhost}>
            {t('saveAndNew')}
          </button>
          <button className={btnPrimary}>{editing ? t('saveChanges') : t('saveComponent')}</button>
        </div>
      </form>
    </div>
  );
}
