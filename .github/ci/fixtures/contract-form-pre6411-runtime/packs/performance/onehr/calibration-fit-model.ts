import {pmBands,potentialBands,type PMBand,type PotentialBand} from './model';
import {curveGaps,curveTolerance} from './journey-model';
import {sourceFigure} from './source-numeric';
import type {CalibrationCurvePolicy} from './calibration-curve-model';
export type FitBand=PMBand|PotentialBand;
export type FitMove={id:string;name:string;from:FitBand;to:FitBand;direction:'up'|'down';reasons:string[]};
type Person={id:string;name:string;band:FitBand;score:number;off?:number;case?:number};
export type PerformanceFitPerson=Person&{approved:PMBand|null;self_label:PMBand|null;default:boolean;basis:'approved'|'self';mech:'A'|'B';verdict:string|null;J:number;D:number;words:number;files:number;n_why:number;why_flag:string;M:number;mod_down:Moderation[];mod_up:Moderation[];mgr_remark:string};
export type PotentialFitPerson=Person&{raw:number;max:number;basis:string;self_band:PotentialBand|null;lm_band:PotentialBand|null;mod:number;words:number;D:number};
type Moderation={kpi:string;from:string;to:string;why:string};
const labels:Record<string,string>={UA:'Unacceptable',BE:'Below Expectation',ME:'Meet Expectation',AE:'Above Expectation',OU:'Outstanding'};
const verdictLabels:Record<string,string>={well_justified:'well justified',partly_justified:'partly justified',not_justified:'not justified'};
const just:Record<string,number>={well_justified:1,partly_justified:.5,not_justified:0};
const words=(s:string)=>s.trim()?s.trim().split(/\s+/):[];
const short=(s:string,n:number)=>words(s).slice(0,n).join(' ').replace(/[,;:]+$/,'')+(words(s).length>n?'…':'');
/** The source's evidence tie-break, using only already visible, submitted facts. */
export function performanceFitPerson(input:Omit<PerformanceFitPerson,'J'|'D'|'M'|'words'> & {remark:string}):PerformanceFitPerson{
 const n=words(input.remark).length,known=input.verdict!=null&&Object.hasOwn(just,input.verdict);
 let J=known?just[input.verdict!]:Math.min(1,.35+(input.files?.35:0)+(n>=20?.3:0));
 if(!known&&input.mod_down.length)J=Math.max(0,J-.15*Math.min(2,input.mod_down.length));
 const D=Math.max(0,Math.min(1,(n>=20?1:n?.5:0)+(input.n_why?.3:0)+({endorsed:.2,disputed:-.3,both:0}[input.why_flag]??0)));
 return {...input,words:n,J,D,M:Math.max(-.4,-.2*input.mod_down.length)+Math.min(.4,.2*input.mod_up.length)};
}
export function potentialFitPerson(input:Omit<PotentialFitPerson,'score'|'mod'|'words'|'D'> & {remark:string}):PotentialFitPerson{
 const n=words(input.remark).length,mod=input.self_band&&input.lm_band?potentialBands.indexOf(input.self_band)-potentialBands.indexOf(input.lm_band):0;
 return {...input,score:5*Math.min(1,Math.max(0,input.raw/input.max)),mod,words:n,D:n>=20?.25:n?.1:0};
}
export function performanceFitCase(people:PerformanceFitPerson[],band:string){return people.filter(p=>p.band===band).map(p=>{
 p.off=p.approved?pmBands.indexOf(band as PMBand)-pmBands.indexOf(p.approved):0;
 p.case=(p.mech==='B'?Math.min(p.score,150)/20:p.score)+.5*p.J+.25*p.D-p.off+p.M;return p;
 });}
export function potentialFitCase(people:PotentialFitPerson[],band:string){return people.filter(p=>p.band===band).map(p=>{
 p.off=p.lm_band?potentialBands.indexOf(band as PotentialBand)-potentialBands.indexOf(p.lm_band):0;
 p.case=p.score+p.D+(p.mod>0?-.2:p.mod<0?.2:0)-p.off;return p;
 });}
export function performanceFitReasons(p:PerformanceFitPerson,direction:'up'|'down',band:string,peers:PerformanceFitPerson[]){
 const num=p.mech==='B'?`${sourceFigure(p.score)}%`:sourceFigure(p.score,1)!.toFixed(1),same=peers.filter(q=>q.mech===p.mech),extreme=direction==='up'?p.score>=Math.max(...same.map(q=>q.score)):p.score<=Math.min(...same.map(q=>q.score)),own=p.basis==='self'?', their own, not approved yet':'';
 const out=[p.default?`Counted as Unacceptable only by default — their own score, ${num} (not approved yet)${p.self_label?', reads '+labels[p.self_label]:''}`:extreme?`${direction==='up'?'Highest':'Lowest'} score in ${labels[band]??band} (${num}${own})`:`Score ${num} in ${labels[band]??band}${own} — chosen on their evidence`];
 if((p.off??0)>0&&direction==='down')out.push(`sits above their manager-approved band (${labels[p.approved!]??p.approved})`);
 else if((p.off??0)<0&&direction==='up')out.push(`sits below their manager-approved band (${labels[p.approved!]??p.approved})`);
 if(p.verdict)out.push(`AI insight: ${verdictLabels[p.verdict]??p.verdict.toLowerCase()}`);
 else out.push(`${p.files?`${p.files} supporting file${p.files===1?'':'s'}`:'no supporting file'}, ${p.words>=20?'a remark':'no overall remark'}`);
 for(const [mods,way] of [[p.mod_down,'down'],[p.mod_up,'up']] as const)for(const m of mods.slice(0,1))out.push(`their line manager moderated ${m.kpi} ${way} (${m.from} → ${m.to})${m.why?': '+short(m.why,10):' with no reason given'}`);
 if(p.mgr_remark)out.push(`their line manager's remark: “${short(p.mgr_remark,12)}”`);
 if(p.words>=20&&p.verdict)out.push('wrote a remark defending the result');else if(!p.words&&p.verdict)out.push('no overall remark');
 if(p.why_flag==='disputed')out.push('their cited evidence was disputed');else if(p.why_flag==='endorsed')out.push('their cited evidence was endorsed');return out.slice(0,6);
}
export function potentialFitReasons(p:PotentialFitPerson,direction:'up'|'down',band:string,peers:PotentialFitPerson[]){
 const num=`${sourceFigure(p.raw,1)!.toFixed(1)} / ${sourceFigure(p.max,1)!.toFixed(1)}`,extreme=direction==='up'?p.score>=Math.max(...peers.map(q=>q.score)):p.score<=Math.min(...peers.map(q=>q.score));
 const out=[extreme?`${direction==='up'?'Highest':'Lowest'} potential score in ${band} (${num})`:`Potential score ${num} in ${band} — chosen on their review`];
 if((p.off??0)>0&&direction==='down')out.push(`sits above the band their line manager's review gave (${p.lm_band})`);else if((p.off??0)<0&&direction==='up')out.push(`sits below the band their line manager's review gave (${p.lm_band})`);
 if(p.mod)out.push(`their line manager's competency review moderated it ${p.mod>0?'down':'up'} (by their own answers: ${p.self_band})`);
 if(p.basis!=='combined')out.push('competency not reviewed yet — 360 only');out.push(p.words>=20?'wrote a competency remark':p.words?'a short competency remark':'no competency remark');return out.slice(0,5);
}
/** Source bounded adjacent-band greedy fit. It is a suggestion, not a claim of global optimality. */
export function calibrationFit<P extends Person>(order:readonly FitBand[],initialCounts:Record<string,number>,initialPeople:P[],target:Record<string,number>,policy:CalibrationCurvePolicy,nRows:number,caseFn:(people:P[],band:string)=>P[],reasonsFn:(p:P,direction:'up'|'down',band:string,peers:P[])=>string[]){
 const counts={...initialCounts},people=initialPeople.map(p=>({...p})),moves:FitMove[]=[],moved=new Set<string>();
 const breaches=()=>{const gaps=curveGaps<string>(order,counts,target),tol=curveTolerance(policy,Object.values(counts).reduce((a,b)=>a+b,0)),br=order.filter(b=>Math.abs(gaps[b])>tol);return {gaps,tol,br};};
 const compare=(a:P,b:P)=>(a.case??0)-(b.case??0)||a.score-b.score||(a.name<b.name?-1:a.name>b.name?1:0);
 for(let step=0;step<2*nRows+2;step++){
  const {gaps,tol,br}=breaches();if(!br.length)break;
  br.sort((a,b)=>(Math.abs(gaps[b])-tol)-(Math.abs(gaps[a])-tol)||Number(gaps[b]<0)-Number(gaps[a]<0)||order.indexOf(a)-order.indexOf(b));
  const band=br[0],i=order.indexOf(band),up=order[i+1],down=order[i-1],tries:{src:FitBand;dst:FitBand;direction:'up'|'down';need:number}[]=[];
  if(gaps[band]<0){if(up)tries.push({src:band,dst:up,direction:'up',need:gaps[up]});if(down)tries.push({src:band,dst:down,direction:'down',need:gaps[down]});}
  else {if(down)tries.push({src:down,dst:band,direction:'up',need:-gaps[down]});if(up)tries.push({src:up,dst:band,direction:'down',need:-gaps[up]});}
  tries.sort((a,b)=>b.need-a.need);let done=false;
  for(const {src,dst,direction} of tries){
   const all=caseFn(people,src),notMoved=all.filter(p=>!moved.has(p.id)),eligible=notMoved.length?notMoved:all;if(!eligible.length)continue;
   const p=eligible.reduce((best,next)=>(direction==='up'?compare(next,best)>0:compare(next,best)<0)?next:best),prior=moves.find(m=>m.id===p.id);
   if(prior)prior.to=dst;else moves.push({id:p.id,name:p.name,from:src,to:dst,direction,reasons:reasonsFn(p,direction,src,people.filter(q=>q.band===src))});
   counts[src]--;counts[dst]++;p.band=dst;moved.add(p.id);done=true;break;
  }if(!done)break;
 }
 const {gaps,br}=breaches();return {moves,counts,withinAfter:br.length===0,breachesAfter:Object.fromEntries(br.map(b=>[b,gaps[b]]))};
}
