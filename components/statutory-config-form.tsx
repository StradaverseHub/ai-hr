'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls, Button, Card } from '@/components/ui';
import { BandGridEditor, type BandColumn } from '@/components/band-grid-editor';
import { saveStatutoryAction } from '@/app/payroll/configuration/actions';
import {
  MY_EPF_THIRD_SCHEDULE_PART_A,
  MY_EPF_THIRD_SCHEDULE_PART_E,
  type ContribBand,
  type StatutoryRuleset,
} from '@/localization/my/statutory-tables';

const num = (x: string): number => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : 0;
};
/** percent string → fraction, rounded to kill FP noise (11 → 0.11, 1.75 → 0.0175). */
const rate = (x: string): number => Math.round(num(x) * 1e4) / 1e6;
/** fraction → percent display (0.11 → "11", 0.0175 → "1.75"). */
const toPct = (n: number): string => String(Math.round(n * 1e6) / 1e4);
/** number → editable string, treating null/Infinity as the open-ended top band (empty cell). */
const upToStr = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '' : String(n);

type BandRow = { upTo: string; M: string; R: string; bCat13: string; bCat2: string };
/** An EPF Third-Schedule band row: Wage-To ceiling + the two contribution AMOUNTS (RM, not %). */
type EpfBandRow = { upTo: string; employee: string; employer: string };

type FormState = {
  epfEmployeeRate: string;
  epfEmployerRateLow: string;
  epfEmployerRateHigh: string;
  epfEmployerThreshold: string;
  /** EPF Third Schedule Part A (citizen/PR < 60). Seeded from the active ruleset, falling back to the
   *  built-in verified table when an older override omits partA. */
  epfPartA: EpfBandRow[];
  /** EPF Third Schedule Part E (citizen 60–<75). Same fallback rule. */
  epfPartE: EpfBandRow[];
  contribCeiling: string;
  reliefIndividual: string;
  reliefSpouse: string;
  reliefPerChild: string;
  reliefEpfCap: string;
  pcbBands: BandRow[];
};

const toEpfRows = (bands: ContribBand[]): EpfBandRow[] =>
  bands.map((b) => ({
    upTo: upToStr(b.upTo),
    employee: String(b.employee),
    employer: String(b.employer),
  }));

function initState(r: StatutoryRuleset): FormState {
  return {
    epfEmployeeRate: toPct(r.epf.employeeRate),
    epfEmployerRateLow: toPct(r.epf.employerRateLow),
    epfEmployerRateHigh: toPct(r.epf.employerRateHigh),
    epfEmployerThreshold: String(r.epf.employerThreshold),
    // partA/partE are optional on the stored override; fall back to the built-in verified tables so the
    // grid always shows the schedule the kernel actually applies (statutory-tables.ts:475,479).
    epfPartA: toEpfRows(r.epf.partA ?? MY_EPF_THIRD_SCHEDULE_PART_A),
    epfPartE: toEpfRows(r.epf.partE ?? MY_EPF_THIRD_SCHEDULE_PART_E),
    contribCeiling: String(r.contribCeiling),
    reliefIndividual: String(r.pcb.reliefs.individual),
    reliefSpouse: String(r.pcb.reliefs.spouse),
    reliefPerChild: String(r.pcb.reliefs.perChild),
    reliefEpfCap: String(r.pcb.reliefs.epfReliefCap),
    pcbBands: r.pcb.bands.map((b) => ({
      upTo: upToStr(b.upTo),
      M: String(b.M),
      R: toPct(b.R),
      bCat13: String(b.bCat13),
      bCat2: String(b.bCat2),
    })),
  };
}

// Numeric values are what the kernel reads, so payroll is byte-identical regardless of JSON key order.
// This overload preserves the ORIGINAL row object's key order when a cell's value is unchanged, so a
// no-op re-publish (open the editor, save without touching EPF) yields a JSONB payload byte-identical to
// the seed — keeping the audit "changed" list and the per-batch snapshot noise-free. New/edited rows fall
// back to a canonical { upTo, employee, employer } shape.
const fromEpfRows = (rows: EpfBandRow[], base?: ContribBand[]): ContribBand[] =>
  rows.map((b, i) => {
    const upTo = b.upTo.trim() === '' ? Infinity : num(b.upTo);
    const employee = num(b.employee);
    const employer = num(b.employer);
    const src = base?.[i];
    // If this row is byte-for-byte the seed row (same index, same values), return the seed object so its
    // exact key order is preserved and JSON.stringify equality holds against `before`.
    if (src && src.upTo === upTo && src.employee === employee && src.employer === employer) return src;
    return { upTo, employee, employer };
  });

/**
 * Merge the edited figures back over the active ruleset. Critically, `...base.epf` is spread FIRST so
 * every EPF field the form does NOT edit — scheduleMax, seniorEmployerRate, nonCitizen* — survives the
 * round-trip; the edited scalars AND the edited Part A / Part E band tables are then overlaid. (Before
 * feedback 99e13860 this rebuilt epf from scratch with no spread, silently dropping partA/partE and the
 * non-citizen rates on every save — invisible only because the calculator fell back to built-ins.)
 */
function assemble(s: FormState, base: StatutoryRuleset): unknown {
  return {
    ...base,
    epf: {
      ...base.epf,
      employeeRate: rate(s.epfEmployeeRate),
      employerRateLow: rate(s.epfEmployerRateLow),
      employerRateHigh: rate(s.epfEmployerRateHigh),
      employerThreshold: num(s.epfEmployerThreshold),
      partA: fromEpfRows(s.epfPartA, base.epf.partA ?? MY_EPF_THIRD_SCHEDULE_PART_A),
      partE: fromEpfRows(s.epfPartE, base.epf.partE ?? MY_EPF_THIRD_SCHEDULE_PART_E),
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
    // NOTE: the ">RM20,000" high-income case is NOT a separate formula engine (feedback 99e13860 open
    // question). Above scheduleMax the exact EPF percentage already keeps applying in the kernel — the
    // correct Malaysian behaviour — so there is nothing to configure here. A genuinely user-editable
    // formula DSL is a deferred, separate item; do not add it under this grid.
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

  // EPF band-grid row editors (Part A + Part E). New rows are inserted just before the open-ended top
  // band so the ascending, open-ended structure the validator expects is preserved by default.
  const blankEpf: EpfBandRow = { upTo: '', employee: '0', employer: '0' };
  const setEpfCell =
    (field: 'epfPartA' | 'epfPartE') => (i: number, k: keyof EpfBandRow, v: string) =>
      setS((p) => ({ ...p, [field]: p[field].map((b, j) => (j === i ? { ...b, [k]: v } : b)) }));
  const addEpfRow = (field: 'epfPartA' | 'epfPartE') => () =>
    setS((p) => {
      const rows = p[field];
      const at = Math.max(0, rows.length - 1); // insert before the open-ended top band
      return { ...p, [field]: [...rows.slice(0, at), { ...blankEpf }, ...rows.slice(at)] };
    });
  const removeEpfRow = (field: 'epfPartA' | 'epfPartE') => (i: number) =>
    setS((p) => ({ ...p, [field]: p[field].filter((_, j) => j !== i) }));

  const epfCols: BandColumn<EpfBandRow>[] = [
    { label: t('colEpfUpTo'), key: 'upTo', widthCls: 'w-28', isCeiling: true },
    { label: t('colEpfEmployee'), key: 'employee', widthCls: 'w-24' },
    { label: t('colEpfEmployer'), key: 'employer', widthCls: 'w-24' },
  ];

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

        {/* Third Schedule band tables — amounts are RM per wage band (not %), rounded up to the ringgit.
            The wage range each row covers runs from the previous row's "Wage To" up to this row's; the
            open-ended top band ("and above") is the exact-percentage tail beyond RM20,000. */}
        <h3 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('epfPartA')}</h3>
        <p className="mb-2 text-xs text-muted-foreground">{t('epfBandsNote')}</p>
        <BandGridEditor<EpfBandRow>
          columns={epfCols}
          rows={s.epfPartA}
          onCell={setEpfCell('epfPartA')}
          onAddRow={addEpfRow('epfPartA')}
          onRemoveRow={removeEpfRow('epfPartA')}
          inputCls={inputCls}
          topBandLabel={t('topBand')}
          addRowLabel={t('addBand')}
          removeRowLabel={t('removeBand')}
          actionsHeader={t('colActions')}
        />

        <h3 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('epfPartE')}</h3>
        <p className="mb-2 text-xs text-muted-foreground">{t('epfPartENote')}</p>
        <BandGridEditor<EpfBandRow>
          columns={epfCols}
          rows={s.epfPartE}
          onCell={setEpfCell('epfPartE')}
          onAddRow={addEpfRow('epfPartE')}
          onRemoveRow={removeEpfRow('epfPartE')}
          inputCls={inputCls}
          topBandLabel={t('topBand')}
          addRowLabel={t('addBand')}
          removeRowLabel={t('removeBand')}
          actionsHeader={t('colActions')}
        />
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

      {/* SOCSO / EIS — carried through unchanged (sibling feedback ee6e1292 makes these editable via the
          same BandGridEditor component this EPF grid now uses). */}
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
