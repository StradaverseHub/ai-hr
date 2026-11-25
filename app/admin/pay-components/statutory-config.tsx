'use client';

/**
 * Feedback 09b554e9 — Payroll Configuration statutory panels (LHDN PCB 2026). Groups the statutory flags
 * into EPF Configuration / PCB Configuration / Other statutory panels:
 *  - EPF panel: the EPF flag + the new EPF Bonus 2012 tick box (only tickable when EPF itself is ticked —
 *    it marks the pay code as a BONUS payment for EPF purposes, EPF Bonus 2012 contribution rules).
 *  - PCB panel: the PCB flag; when ticked, the mandatory Remuneration Type (Normal / Additional / Optional
 *    Deduction) and Exemption Type dropdowns appear. The Exemption Type list refreshes with the selected
 *    Remuneration Type (PCB_* codes for Normal/Additional, the 24 LP_* optional-deduction codes otherwise)
 *    so only valid combinations can be submitted — the server action re-validates authoritatively.
 *  - Other panel: SOCSO/EIS + HRDF, unchanged semantics.
 * Client island (the PayRuleEditor pattern) so the dynamic dropdown filters without a round trip. Imports
 * ONLY the pure statutory-tables vocabulary (db-free) to keep the RSC boundary clean. Each statutory field
 * carries an ⓘ tooltip referencing the LHDN PCB 2026 specification.
 *
 * Board 8edeef41 (owner decision 2026-11-25, amending ADR-0090) — a non-cash BIK / living accommodation item
 * subject to PCB is Normal or Additional remuneration, chosen per item. When the enclosing form's Category,
 * Payroll Category and EA line identify such a benefit (the same classifyNonCashBenefit owner the server uses)
 * and PCB is ticked, Remuneration Type offers exactly those two choices, defaults to Normal, keeps the saved
 * choice when the item is reopened, and says what the chosen route means. Optional Deduction is not offered for a
 * benefit; an item saved earlier with it opens on Normal. Changing Payroll Category never changes the choice. EPF
 * Bonus 2012 ticked on such a benefit is explained here before Save. An untouched legacy blank pair keeps its
 * preservation (the server's isUnchangedLegacyPcbClassification). The server check stays the authority.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { inputCls } from '@/components/ui';
import { classifyNonCashBenefit } from '@/localization/noncash-benefits';
import {
  PCB_REMUNERATION_TYPES,
  pcbExemptionCodesFor,
  type PcbRemunerationType,
} from '@/localization/my/statutory-tables';

type Props = {
  editing?: boolean;
  includedInEpf: boolean;
  epfBonus2012: boolean;
  includedInSocsoEis: boolean;
  includedInPcb: boolean;
  includedInHrdfBase: boolean;
  pcbRemunerationType: PcbRemunerationType | null;
  pcbExemptionCode: string | null;
  /** The item's identity as rendered by the enclosing form (Category, Payroll Category, EA line). The island
   *  follows later edits of those fields through the form's change events. Omitted ⇒ no benefit choice. */
  kind?: string;
  displayCategory?: string | null;
  eaFormLine?: string | null;
};
type Identity = { kind: string; displayCategory: string; eaFormLine: string };

/** The benefit owner decides; a conflicting/unsupported identity is not special-cased here (the server names it). */
function isNonCashBenefit(identity: Identity): boolean {
  try {
    return classifyNonCashBenefit({ code: 'pay-item', kind: identity.kind, nonPayable: identity.kind === 'non_payable', pcb: false,
      displayCategory: identity.displayCategory || null, eaFormLine: identity.eaFormLine || null }) !== null;
  } catch {
    return false;
  }
}

/** ⓘ info icon with a native tooltip (title) — the house-minimal statutory hint. */
function InfoTip({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex cursor-help text-muted-foreground" aria-label={text}>
      <Info className="size-3.5" />
    </span>
  );
}

export function StatutoryConfig(p: Props) {
  const t = useTranslations('payComponents');
  const [epf, setEpf] = useState(p.includedInEpf);
  const [epfBonus, setEpfBonus] = useState(p.epfBonus2012 && p.includedInEpf);
  const [pcb, setPcb] = useState(p.includedInPcb);
  const [remType, setRemType] = useState<PcbRemunerationType | ''>(p.pcbRemunerationType ?? '');
  const [exemptCode, setExemptCode] = useState(p.pcbExemptionCode ?? '');
  const [statutoryEdited, setStatutoryEdited] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const benefitNoteId = useId();
  const [initialIdentity] = useState<Identity>(() => ({ kind: p.kind ?? '', displayCategory: p.displayCategory ?? '', eaFormLine: p.eaFormLine ?? '' }));
  const [identity, setIdentity] = useState<Identity>(initialIdentity);
  // Follow Category / Payroll Category / EA line edits made elsewhere in the same form (server-rendered selects).
  useEffect(() => {
    const form = rootRef.current?.closest('form');
    if (!form) return;
    const onFormChange = () => {
      const value = (name: string) => {
        const field = form.elements.namedItem(name);
        return field instanceof HTMLSelectElement || field instanceof HTMLInputElement ? field.value : null;
      };
      setIdentity(prev => {
        const next = { kind: value('kind') ?? prev.kind, displayCategory: value('displayCategory') ?? prev.displayCategory, eaFormLine: value('eaFormLine') ?? prev.eaFormLine };
        return next.kind === prev.kind && next.displayCategory === prev.displayCategory && next.eaFormLine === prev.eaFormLine ? prev : next;
      });
    };
    form.addEventListener('change', onFormChange);
    return () => form.removeEventListener('change', onFormChange);
  }, []);
  // Mirrors the server's legacy rule: a Category change, or a benefit-identity change on a non-payable item,
  // is a statutory edit even though it happens outside these panels.
  const identityEdited = identity.kind !== initialIdentity.kind || (initialIdentity.kind === 'non_payable'
    && (identity.displayCategory !== initialIdentity.displayCategory || identity.eaFormLine !== initialIdentity.eaFormLine));
  // Only an unchanged existing pre-classification pair may remain blank. Create/copy is always strict.
  const preserveLegacy = p.editing && p.includedInPcb && p.pcbRemunerationType === null && p.pcbExemptionCode === null && !statutoryEdited && !identityEdited;
  // 8edeef41 — BIK / living accommodation subject to PCB: Remuneration Type is Normal (default) or Additional.
  const identityIsBenefit = isNonCashBenefit(identity);
  const benefitChoice = pcb && !preserveLegacy && identityIsBenefit;
  const benefitRemType: 'normal' | 'additional' = remType === 'additional' ? 'additional' : 'normal';
  const effectiveRemType: PcbRemunerationType | '' = benefitChoice ? benefitRemType : remType;
  // An optional-deduction exemption saved on an older item is not valid for a benefit; it must be chosen again.
  const effectiveExemptCode = benefitChoice && exemptCode && !(exemptCode in pcbExemptionCodesFor(benefitRemType)) ? '' : exemptCode;
  // The server refuses EPF Bonus 2012 on a taxable benefit; say so beside the box, only while it is ticked.
  const benefitEpfBonus = pcb && epfBonus && identityIsBenefit;

  // The exemption list valid for the selected remuneration type (built-in vocabulary; the annual caps are
  // shown beside each code exactly as the LHDN specification lists them).
  const options = effectiveRemType ? Object.entries(pcbExemptionCodesFor(effectiveRemType)).sort(([a], [b]) => a.localeCompare(b)) : [];

  const onRemTypeChange = (next: PcbRemunerationType | '') => {
    setRemType(next);
    // Normal ↔ Additional share the PCB_* list; switching to/from Optional Deduction invalidates the code.
    if (next === '' || !(exemptCode in pcbExemptionCodesFor(next || 'normal'))) setExemptCode('');
  };

  return (
    <div ref={rootRef} className="space-y-3 sm:col-span-3" onChange={() => setStatutoryEdited(true)}>
      {/* EPF Configuration */}
      <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('sectionEpfConfig')}
          <InfoTip text={t('epfConfigTip')} />
        </h4>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="includedInEpf"
              checked={epf}
              onChange={(e) => {
                setEpf(e.target.checked);
                if (!e.target.checked) setEpfBonus(false); // EPF Bonus 2012 requires EPF itself
              }}
              className="size-4 rounded"
            />
            EPF
          </label>
          <label className={`flex items-center gap-2 text-sm ${epf ? '' : 'opacity-50'}`}>
            <input
              type="checkbox"
              name="epfBonus2012"
              checked={epfBonus}
              disabled={!epf}
              onChange={(e) => setEpfBonus(e.target.checked)}
              className="size-4 rounded"
            />
            {t('epfBonus2012Label')}
            <InfoTip text={t('epfBonus2012Tip')} />
          </label>
        </div>
        {benefitEpfBonus && <p role="note" className="text-xs leading-relaxed text-destructive">{t('benefitEpfBonusNote')}</p>}
      </div>

      {/* PCB Configuration */}
      <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('sectionPcbConfig')}
          <InfoTip text={t('pcbConfigTip')} />
        </h4>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="includedInPcb"
            checked={pcb}
            onChange={(e) => setPcb(e.target.checked)}
            className="size-4 rounded"
          />
          PCB
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('benefitRemunerationHint')}</p>
        {/* Owner decisions A/B (2026-11-13): the two PCB fields below are income-tax only; the agency
            ticks alone decide EPF / SOCSO / EIS / SKBBK (core/payroll.ts earningsOf). */}
        {pcb && <p className="text-xs leading-relaxed text-muted-foreground">{t('pcbScopeHint')}</p>}
        {pcb && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {benefitChoice ? (
              <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={benefitNoteId}>
                <legend className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  {t('remunerationTypeLabel')}
                  <span className="text-destructive">*</span>
                  <InfoTip text={t('remunerationTypeTip')} />
                </legend>
                {/* Exactly two choices for a benefit; the checked one is what Save posts. */}
                <div role="radiogroup" aria-label={t('remunerationTypeLabel')} className="flex flex-wrap gap-2">
                  {(['normal', 'additional'] as const).map((k) => (
                    <label key={k} className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                      <input
                        type="radio"
                        name="pcbRemunerationType"
                        value={k}
                        checked={benefitRemType === k}
                        onChange={() => onRemTypeChange(k)}
                        className="size-4"
                      />
                      {t(`remType_${k}`)}
                    </label>
                  ))}
                </div>
                <span id={benefitNoteId} className="text-xs leading-relaxed text-muted-foreground">
                  {t(benefitRemType === 'additional' ? 'benefitAdditionalNote' : 'benefitNormalNote')}
                </span>
              </fieldset>
            ) : (
            <label className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {t('remunerationTypeLabel')}
                {!preserveLegacy && <span className="text-destructive">*</span>}
                <InfoTip text={t('remunerationTypeTip')} />
              </span>
              <select
                name="pcbRemunerationType"
                required={!preserveLegacy}
                value={effectiveRemType}
                onChange={(e) => onRemTypeChange(e.target.value as PcbRemunerationType | '')}
                className={inputCls}
              >
                <option value="">{t('selectOption')}</option>
                {PCB_REMUNERATION_TYPES.map((k) => (
                  <option key={k} value={k}>
                    {t(`remType_${k}`)}
                  </option>
                ))}
              </select>
            </label>
            )}
            <label className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {t('exemptionTypeLabel')}
                {!preserveLegacy && <span className="text-destructive">*</span>}
                <InfoTip text={t('exemptionTypeTip')} />
              </span>
              <select
                name="pcbExemptionCode"
                required={!preserveLegacy}
                disabled={!effectiveRemType}
                value={effectiveExemptCode}
                onChange={(e) => {
                  setExemptCode(e.target.value);
                  // Choosing an exemption on a benefit commits its shown type, so a later identity change cannot pair it
                  // with a stale Optional Deduction.
                  if (benefitChoice) setRemType(benefitRemType);
                }}
                className={inputCls}
              >
                <option value="">{t('selectOption')}</option>
                {options.map(([code, cap]) => (
                  <option key={code} value={code}>
                    {`${code} (${cap})`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Other statutory contributions (SOCSO/EIS + HRDF — semantics unchanged) */}
      <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('sectionOtherStatutory')}</h4>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="includedInSocsoEis" defaultChecked={p.includedInSocsoEis} className="size-4 rounded" />
            SOCSO/EIS
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="includedInHrdfBase" defaultChecked={p.includedInHrdfBase} className="size-4 rounded" />
            HRDF
          </label>
        </div>
      </div>
    </div>
  );
}
