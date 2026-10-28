import { talentCell,talentCell9,talentColumn,type PMBand,type PotentialBand } from './model';
type Bands={performance:PMBand|null;potential:PotentialBand|null};
type Origin={originalPerformance:string|null;originalPotential:string|null;performancePinned:boolean;potentialPinned:boolean;performance:string|null;potential:string|null};
/** Where this tier found the person: the first move's origin on an adjusted axis, else the current incoming band. */
export function talentOrigin(entry:Origin,current:Bands):Bands{
 const pm=entry.performance!=null&&!entry.performancePinned,pot=entry.potential!=null&&!entry.potentialPinned;
 return {performance:pm?entry.originalPerformance as PMBand|null:current.performance,potential:pot?entry.originalPotential as PotentialBand|null:current.potential};
}
/** The source keeps the first move's origin. An untouched axis follows its current incoming band. */
export function talentMovement(entry:Origin,current:Bands){
 const pm=entry.performance!=null&&!entry.performancePinned,pot=entry.potential!=null&&!entry.potentialPinned;
 const from=talentOrigin(entry,current);
 const fromCell=talentCell(from),toCell=talentCell(current);
 return {moved:!!((pm||pot)&&fromCell&&toCell&&fromCell!==toCell),fromCategory:from.performance&&from.potential?talentCell9(talentColumn(from.performance),from.potential):null};
}
/** A box move writes only changed axes; an empty selection keeps the visible band. */
export function talentMoveAxes(current:Bands,requested:Bands){return {pm:requested.performance!=null&&requested.performance!==current.performance,pot:requested.potential!=null&&requested.potential!==current.potential};}
/** Source nine-box picker: keep the exact band within its column; otherwise default to BE / ME / AE. */
export function talentMoveTarget(current:Bands,key:string,picked:PMBand|null=null){
 const [column,potential]=key.split('|');if(!['low','mid','high'].includes(column)||!['Low','Mid','High'].includes(potential))return null;
 const choices:PMBand[]=column==='low'?['UA','BE']:column==='mid'?['ME']:['AE','OU'];
 const same=current.performance!=null&&talentColumn(current.performance)===column;
 return {performance:same?current.performance!:picked&&choices.includes(picked)?picked:column==='low'?'BE' as const:choices[0],potential:potential as PotentialBand,choices:same?[]:choices};
}
