import Link from 'next/link';
import type {TaxBasisNoticeReference, TaxBasisNoticeStrings} from '@/lib/payroll-tax-basis-notices';

/** A notice beside working/report output, never a replacement for its saved financial figures. */
export function TaxBasisCorrectionNotice({references, strings}: {references: TaxBasisNoticeReference[]; strings: TaxBasisNoticeStrings}) {
  if (!references.length) return null;
  return <aside role="note" className="space-y-2 rounded-lg border border-border bg-muted/30 p-4 text-sm print:hidden">
    <p>{strings.description}</p>
    <ul aria-label={strings.references} className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
      {references.map(reference => <li key={reference.batchId}>{reference.canOpen
        ? <Link href={'/payroll/income-tax-recalculation/'+encodeURIComponent(reference.batchId)} title={strings.view+' · '+reference.reference} className="font-medium text-primary underline underline-offset-2">{reference.reference}</Link>
        : <span className="font-medium">{reference.reference}</span>}</li>)}
    </ul>
  </aside>;
}
