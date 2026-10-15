import {scoreAnswers,type Statement,type Policy,type PotentialBand} from './model';
/** Competency-only preview. No rater answers, panel thresholds or combined potential enter this calculation. */
export function competencyBand(statements:Statement[],answers:Record<string,'yes'|'no'|''>,policy:Pick<Policy,'lowMaxPct'|'midMaxPct'>,hasFramework:boolean):PotentialBand|null {
 if(!statements.length||statements.some(s=>!['yes','no'].includes(answers[s.id])))return null;
 const complete=Object.fromEntries(statements.map(s=>[s.id,answers[s.id]])) as Record<string,'yes'|'no'>;
 const {score,max}=scoreAnswers(statements,complete),pct=score/max*100;
 return hasFramework?(pct<=policy.lowMaxPct?'Low':pct<=policy.midMaxPct?'Mid':'High'):(pct>=75?'High':pct>=40?'Mid':'Low');
}
