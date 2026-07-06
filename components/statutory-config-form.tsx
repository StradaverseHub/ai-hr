'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls, Button, Card } from '@/components/ui';
import { saveStatutoryAction } from '@/app/payroll/configuration/actions';
import type { StatutoryRuleset } from '@/localization/my/statutory-tables';

const num = (x: string): number => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : 0;
};
/** percent string → fraction, rounded to kill FP noise (11 → 0.11, 1.75 → 0.0175). */
const rate = (x: string): number => Math.round(num(x) * 1e4) / 1e6;
/** fraction → percent display (0.11 → "11", 0.0175 → "1.75"). */
const toPct = (n: number): string => String(Math.round(n * 1e6) / 1e4);

type BandRow = { upTo: string; M: string; R: string; bCat13: string; bCat2: string };
type FormState = {
  epfEmployeeRate: string;
  epfEmployerRateLow: string;
  epfEmployerRateHigh: string;
  epfEmployerThreshold: string;
  contribCeiling: string;
  reliefIndividual: string;
  reliefSpouse: string;
  reliefPerChild: string;
  reliefEpfCap: string;
  pcbBands: BandRow[];
};

function initState(r: StatutoryRuleset): FormState {
  return {
    epfEmployeeRate: toPct(r.epf.employeeRate),
    epfEmployerRateLow: toPct(r.epf.employerRateLow),
    epfEmployerRateHigh: toPct(r.epf.employerRateHigh),
    epfEmployerThreshold: String(r.epf.employerThreshold),
    contribCeiling: String(r.contribCeiling),
    reliefIndividual: String(r.pcb.reliefs.individual),
    reliefSpouse: String(r.pcb.reliefs.spouse),
    reliefPerChild: String(r.pcb.reliefs.perChild),
    reliefEpfCap: String(r.pcb.reliefs.epfReliefCap),
    pcbBands: r.pcb.bands.map((b) => ({
      upTo: b.upTo == null || !Number.isFinite(b.upTo) ? '' : String(b.upTo),
      M: String(b.M),
      R: toPct(b.R),
      bCat13: String(b.bCat13),
      bCat2: String(b.bCat2),
    })),
  };
}

/** Merge the edited figures back over the active ruleset; SOCSO/EIS schedules carry through. */
function assemble(s: FormState, base: StatutoryRuleset): unknown {
  return {
    ...base,
    epf: {
      employeeRate: rate(s.epfEmployeeRate),
      employerRateLow: rate(s.epfEmployerRateLow),
      employerRateHigh: rate(s.epfEmployerRateHigh),
      employerThreshold: num(s.epfEmployerThreshold),
    },
    contribCeiling: num(s.contribCeiling),
    // OT is no longer edited from this advanced editor (feedback e776d17d) — it is managed on the
    // Attendance Policy screen. Carry the whole existing ot slice through unchanged (wageCeiling +
    // both excess multipliers) so a raw-editor save never drops overtime data. `...base` above already
    // spreads base.ot, so this line is belt-and-braces to make the intent explicit and future-proof.
    ot: base.ot,
    pcb: {
      ...base.pcb,
      reliefs: {
        individual: num(s.reliefIndividual),
        spouse: num(s.reliefSpouse),
        perChild: num(s.reliefPerChild),
        epfReliefCap: num(s.reliefEpfCap),
      },
      bands: s.pcbBands.map((b) => ({
        upTo: b.upTo.trim() === '' ? null : num(b.upTo),
        M: num(b.M),
        R: rate(b.R),
        bCat13: num(b.bCat13),
        bCat2: num(b.bCat2),
      })),
    },
  };
}

function NumField({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        />
        {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );
}

export function StatutoryConfigForm({
  ruleset,
  defaultVersion,
}: {
  ruleset: StatutoryRuleset;
  defaultVersion: string;
}) {
  const t = useTranslations('payroll.config');
  const [s, setS] = useState<FormState>(() => initState(ruleset));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((p) => ({ ...p, [k]: v }));
  const setBand = (i: number, k: keyof BandRow, v: string) =>
    setS((p) => ({ ...p, pcbBands: p.pcbBands.map((b, j) => (j === i ? { ...b, [k]: v } : b)) }));

  const today = new Date().toISOString().slice(0, 10);
  const dataJson = useMemo(() => JSON.stringify(assemble(s, ruleset)), [s, ruleset]);

  return (
    <form action={saveStatutoryAction} className="space-y-4">
      <input type="hidden" name="data" value={dataJson} />

      {/* Version metadata */}
      <Card className="grid gap-4 p-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('fieldVersion')}</span>
          <input name="version" defaultValue={defaultVersion} required className={inputCls} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('fieldEffectiveFrom')}</span>
          <input type="date" name="effectiveFrom" defaultValue={today} required className={inputCls} />
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-3">
          <span className="text-xs font-medium text-muted-foreground">{t('fieldNotes')}</span>
          <input name="notes" placeholder={t('notesPlaceholder')} className={inputCls} />
        </label>
      </Card>

      {/* EPF */}
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('secEpf')}</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumField label={t('epfEmployeeRate')} value={s.epfEmployeeRate} onChange={(v) => set('epfEmployeeRate', v)} suffix="%" />
          <NumField label={t('epfEmployerRateLow')} value={s.epfEmployerRateLow} onChange={(v) => set('epfEmployerRateLow', v)} suffix="%" />
          <NumField label={t('epfEmployerRateHigh')} value={s.epfEmployerRateHigh} onChange={(v) => set('epfEmployerRateHigh', v)} suffix="%" />
          <NumField label={t('epfEmployerThreshold')} value={s.epfEmployerThreshold} onChange={(v) => set('epfEmployerThreshold', v)} suffix="RM" />
        </div>
      </Card>

      {/* Ceilings — OT wage ceiling removed here (feedback e776d17d); overtime rates are edited on the
          Attendance Policy screen. The stored ot slice still round-trips unchanged via assemble(). */}
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('secCeilings')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label={t('contribCeiling')} value={s.contribCeiling} onChange={(v) => set('contribCeiling', v)} suffix="RM" />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('ceilingsNote')}</p>
      </Card>

      {/* PCB reliefs + bands */}
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('secPcb')}</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumField label={t('reliefIndividual')} value={s.reliefIndividual} onChange={(v) => set('reliefIndividual', v)} suffix="RM" />
          <NumField label={t('reliefSpouse')} value={s.reliefSpouse} onChange={(v) => set('reliefSpouse', v)} suffix="RM" />
          <NumField label={t('reliefPerChild')} value={s.reliefPerChild} onChange={(v) => set('reliefPerChild', v)} suffix="RM" />
          <NumField label={t('reliefEpfCap')} value={s.reliefEpfCap} onChange={(v) => set('reliefEpfCap', v)} suffix="RM" />
        </div>

        <h3 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('pcbBands')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">{t('colUpTo')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('colM')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('colR')} %</th>
                <th className="py-1.5 pr-3 font-medium">{t('colBCat13')}</th>
                <th className="py-1.5 font-medium">{t('colBCat2')}</th>
              </tr>
            </thead>
            <tbody>
              {s.pcbBands.map((b, i) => {
                const isTop = i === s.pcbBands.length - 1;
                return (
                  <tr key={i} className="border-t border-border">
                    <td className="py-1.5 pr-3">
                      <input
                        type="number"
                        step="any"
                        value={b.upTo}
                        placeholder={isTop ? t('topBand') : ''}
                        onChange={(e) => setBand(i, 'upTo', e.target.value)}
                        className={`${inputCls} h-8 w-28`}
                      />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input type="number" step="any" value={b.M} onChange={(e) => setBand(i, 'M', e.target.value)} className={`${inputCls} h-8 w-28`} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input type="number" step="any" value={b.R} onChange={(e) => setBand(i, 'R', e.target.value)} className={`${inputCls} h-8 w-20`} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input type="number" step="any" value={b.bCat13} onChange={(e) => setBand(i, 'bCat13', e.target.value)} className={`${inputCls} h-8 w-28`} />
                    </td>
                    <td className="py-1.5">
                      <input type="number" step="any" value={b.bCat2} onChange={(e) => setBand(i, 'bCat2', e.target.value)} className={`${inputCls} h-8 w-28`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* SOCSO / EIS — carried through unchanged */}
      <Card className="p-4 text-sm text-muted-foreground">
        <h2 className="mb-1 text-sm font-semibold text-foreground">
          {t('secSocso')} · {t('secEis')}
        </h2>
        <p>{t('bandsReadOnly', { count: ruleset.socso.category1.length })}</p>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <a href="/payroll/configuration">
          <Button type="button" variant="outline">
            {t('cancel')}
          </Button>
        </a>
        <Button type="submit">{t('save')}</Button>
      </div>
    </form>
  );
}
