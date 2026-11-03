/** AI v2 P2-2a — threshold improvement proposals for the net-swing flag (owner decision 5: "it should keep improving").
 *
 * PURE. From payroll HR's dispositions of one company's net-swing flags over the last PROPOSAL_WINDOW_DAYS, propose:
 *  - an EXCLUSION of a pay pattern (for example a commission item) when at least PROPOSAL_MIN_FLAGS flags carried that
 *    pattern and at least 80% of them were cleared as expected;
 *  - a higher THRESHOLD when at least PROPOSAL_MIN_FLAGS flags were decided and at least 80% of all of them were expected:
 *    the smallest whole percentage that clears 80% of the expected flags, never at or above the smallest swing payroll HR
 *    called a real problem, never above MAX_THRESHOLD_BP, and only when it is above the threshold in force.
 * A proposal is evidence and a suggestion only. Nothing here applies it: an administrator approves it
 * (core/loops/payroll-loop-settings.ts decideThresholdProposal), which re-derives it first and records the decision. A
 * proposal concerns the net-swing flag alone; it never touches the 11 payroll anomaly detectors or their thresholds.
 * A proposal an administrator rejected is not offered again while its evidence is the same (its key is unchanged). */
import {createHash} from 'node:crypto';

export const PROPOSAL_WINDOW_DAYS=30;
export const PROPOSAL_MIN_FLAGS=5;
export const PROPOSAL_EXPECTED_SHARE_BP=8000;
export const MAX_THRESHOLD_BP=5000;

export type SwingDispositionRow=Readonly<{pattern:string;swingBp:number;disposition:'expected'|'problem'}>;
export type SwingSettingInForce=Readonly<{thresholdBp:number;exclusions:readonly string[]}>;
export type SwingProposalEvidence=Readonly<{windowDays:number;flags:number;expected:number;problems:number;expectedShareBp:number;smallestProblemBp:number|null}>;
export type SwingProposal=Readonly<{key:string;kind:'threshold'|'exclusion';fromThresholdBp:number;toThresholdBp:number|null;pattern:string|null;
 evidence:SwingProposalEvidence}>;

const shareBp=(part:number,whole:number)=>whole>0?Math.floor(part*10_000/whole):0;
/** The proposal's identity: what it changes and the evidence it rests on. A new disposition changes the key. */
export const proposalKey=(p:Omit<SwingProposal,'key'>)=>createHash('sha256')
 .update(JSON.stringify([p.kind,p.fromThresholdBp,p.toThresholdBp,p.pattern,p.evidence.flags,p.evidence.expected,p.evidence.problems,p.evidence.smallestProblemBp])).digest('hex');

function evidenceOf(rows:readonly SwingDispositionRow[]):SwingProposalEvidence{
 const expected=rows.filter(row=>row.disposition==='expected').length,problems=rows.length-expected;
 const problemSwings=rows.filter(row=>row.disposition==='problem').map(row=>row.swingBp);
 return Object.freeze({windowDays:PROPOSAL_WINDOW_DAYS,flags:rows.length,expected,problems,expectedShareBp:shareBp(expected,rows.length),
  smallestProblemBp:problemSwings.length?Math.min(...problemSwings):null});
}

/** The proposals the dispositions support now, exclusions first (by pattern), then the threshold. */
export function deriveSwingProposals(rows:readonly SwingDispositionRow[],setting:SwingSettingInForce,rejected:ReadonlySet<string>=new Set()):readonly SwingProposal[]{
 const out:SwingProposal[]=[];
 const push=(proposal:Omit<SwingProposal,'key'>)=>{const key=proposalKey(proposal);if(!rejected.has(key))out.push(Object.freeze({...proposal,key}));};
 const excluded=new Set(setting.exclusions);
 const patterns=[...new Set(rows.map(row=>row.pattern))].filter(pattern=>!excluded.has(pattern)).sort();
 for(const pattern of patterns){
  const evidence=evidenceOf(rows.filter(row=>row.pattern===pattern));
  if(evidence.flags>=PROPOSAL_MIN_FLAGS&&evidence.expectedShareBp>=PROPOSAL_EXPECTED_SHARE_BP)
   push({kind:'exclusion',fromThresholdBp:setting.thresholdBp,toThresholdBp:null,pattern,evidence});
 }
 const all=evidenceOf(rows);
 if(all.flags>=PROPOSAL_MIN_FLAGS&&all.expectedShareBp>=PROPOSAL_EXPECTED_SHARE_BP){
  const expected=rows.filter(row=>row.disposition==='expected').map(row=>row.swingBp).sort((a,b)=>a-b);
  // The swing at or below which 80% of the expected flags fall, rounded up to a whole percentage.
  const at=expected[Math.max(0,Math.ceil(expected.length*PROPOSAL_EXPECTED_SHARE_BP/10_000)-1)];
  let to=Math.ceil(at/100)*100;
  if(all.smallestProblemBp!==null)to=Math.min(to,Math.floor((all.smallestProblemBp-1)/100)*100);
  to=Math.min(to,MAX_THRESHOLD_BP);
  if(to>setting.thresholdBp)push({kind:'threshold',fromThresholdBp:setting.thresholdBp,toThresholdBp:to,pattern:null,evidence:all});
 }
 return Object.freeze(out);
}
