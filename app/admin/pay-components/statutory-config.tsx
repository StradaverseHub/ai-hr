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
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { inputCls } from '@/components/ui';
import {
  PCB_REMUNERATION_TYPES,
  pcbExemptionCodesFor,
  type PcbRemunerationType,
} from '@/localization/my/statutory-tables';

type Props = {
  includedInEpf: boolean;
  epfBonus2012: boolean;
  includedInSocsoEis: boolean;
  includedInPcb: boolean;
  includedInHrdfBase: boolean;
  pcbRemunerationType: PcbRemunerationType | null;
  pcbExemptionCode: string | null;
};

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

  // The exemption list valid for the selected remuneration type (built-in vocabulary; the annual caps are
  // shown beside each code exactly as the LHDN specification lists them).
  const options = remType ? Object.entries(pcbExemptionCodesFor(remType)).sort(([a], [b]) => a.localeCompare(b)) : [];

  const onRemTypeChange = (next: PcbRemunerationType | '') => {
    setRemType(next);
    // Normal ↔ Additional share the PCB_* list; switching to/from Optional Deduction invalidates the code.
    if (next === '' || !(exemptCode in pcbExemptionCodesFor(next || 'normal'))) setExemptCode('');
  };

  return (
    <div className="space-y-3 sm:col-span-3">
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
        {pcb && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {t('remunerationTypeLabel')}
                <span className="text-destructive">*</span>
                <InfoTip text={t('remunerationTypeTip')} />
              </span>
              <select
                name="pcbRemunerationType"
                required
                value={remType}
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
            <label className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {t('exemptionTypeLabel')}
                <span className="text-destructive">*</span>
                <InfoTip text={t('exemptionTypeTip')} />
              </span>
              <select
                name="pcbExemptionCode"
                required
                disabled={!remType}
                value={exemptCode}
                onChange={(e) => setExemptCode(e.target.value)}
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
