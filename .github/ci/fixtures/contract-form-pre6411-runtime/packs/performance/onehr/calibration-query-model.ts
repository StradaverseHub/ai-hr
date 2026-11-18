import { z } from 'zod';
const span=z.object({start:z.number().int().min(0),end:z.number().int().positive()}).strict();
export const calibrationQuerySchema=z.discriminatedUnion('action',[
 z.object({action:z.enum(['distribution','framework','prepare_lock']),axis:z.enum(['performance','potential','both']).optional(),unit:z.object({id:z.uuid(),name:span}).strict().optional()}).strict(),
 z.object({action:z.literal('person'),reviewId:z.uuid(),name:span}).strict(),
]);
export type CalibrationQuery=z.infer<typeof calibrationQuerySchema>;
export type CalibrationQueryScope={axis:'performance'|'potential'|'both';people:{id:string;name:string}[];units:{id:string;name:string}[]};
const normal=(s:string)=>s.trim().normalize('NFKC').toLocaleLowerCase('en');
/** A provider selects a read operation. Names must still be literal, unique members of the authorized cohort. */
export function adjudicateCalibrationQuery(raw:string,text:string,scope:CalibrationQueryScope):CalibrationQuery|null{
 try{
  const query=calibrationQuerySchema.parse(JSON.parse(raw));
  const named=(id:string,s:z.infer<typeof span>,targets:{id:string;name:string}[])=>{
   if(s.start>=s.end||s.end>text.length)return false;
   const name=normal(text.slice(s.start,s.end)),matches=targets.filter(t=>normal(t.name)===name);return matches.length===1&&matches[0].id===id;
  };
  if(query.action==='person')return named(query.reviewId,query.name,scope.people)?query:null;
  if(query.axis&&scope.axis!=='both'&&query.axis!==scope.axis)return null;
  if(query.unit&&!named(query.unit.id,query.unit.name,scope.units))return null;
  return query;
 }catch{return null;}
}
export function literalCalibrationQuery(text:string,scope:CalibrationQueryScope):CalibrationQuery|null{
 const words=text.trim();
 if(/^(?:show )?(?:the )?(?:distribution|cohort|talent box)[.!?]?$/i.test(words))return {action:'distribution'};
 if(/^(?:show |suggest (?:to |the )?)?(?:the )?(?:framework|curve gaps)[.!?]?$/i.test(words))return {action:'framework'};
 if(/^(?:prepare (?:to )?lock|lock calibration|ready to lock)[.!?]?$/i.test(words))return {action:'prepare_lock'};
 const match=/^(?:explain|open):\s*(.+)$/i.exec(words);
 if(!match)return null;
 const name=match[1].trim(),matches=scope.people.filter(p=>normal(p.name)===normal(name));
 if(matches.length!==1)throw Error('Use one exact, unambiguous name from this cohort.');
 const start=text.indexOf(name);return {action:'person',reviewId:matches[0].id,name:{start,end:start+name.length}};
}
