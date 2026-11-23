import type {TaxBasisProgressState} from '@/lib/payroll-tax-basis';

const tone:Record<TaxBasisProgressState,string>={
  pending:'bg-muted-foreground/40',processing:'bg-primary',completed:'bg-emerald-600',
  completed_with_errors:'bg-amber-600',failed:'bg-destructive',
};
export const stateTone:Record<TaxBasisProgressState,string>={
  pending:'bg-muted text-muted-foreground',processing:'bg-primary/10 text-primary',
  completed:'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  completed_with_errors:'bg-amber-500/10 text-amber-700 dark:text-amber-400',failed:'bg-destructive/10 text-destructive',
};

/** Presentation only: the percentage arrives computed from recorded work (taxBasisProgressPercent). */
export function TaxProgressBar({percent,state,label}:{percent:number;state:TaxBasisProgressState;label:string}){
  return <div className="flex items-center gap-3">
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      className="h-2.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted">
      <div className={'h-full rounded-full transition-[width] '+tone[state]} style={{width:percent+'%'}}/>
    </div>
    <span className="w-10 shrink-0 text-right text-xs font-medium tabular-nums">{percent}%</span>
  </div>;
}

export function TaxStatePill({state,label}:{state:TaxBasisProgressState;label:string}){
  return <span className={'inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold '+stateTone[state]}>{label}</span>;
}
