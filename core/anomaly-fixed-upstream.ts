import type {ReadinessGapId} from './record-readiness';
/** Only record-fact findings can be automatically dispositioned as fixed upstream. */
export const fixedUpstreamCause:Partial<Record<string,ReadinessGapId>>={
 'missing-bank-profile':'no_bank_account','missing-tax-profile':'no_tax_number',
};
export function allFixedUpstreamFindingsClear(detectors:readonly string[],gaps:readonly ReadinessGapId[]):boolean {
 return detectors.length>0&&detectors.every(detector=>{
  const cause=fixedUpstreamCause[detector];return cause!==undefined&&!gaps.includes(cause);
 });
}
