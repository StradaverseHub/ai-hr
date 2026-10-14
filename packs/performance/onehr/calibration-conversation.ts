import { randomUUID } from 'node:crypto';
import { and,eq,sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext } from '../../../db/client';
import { calibrationConversation } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { getOnehrCalibration,saveOnehrCalibrationTx } from './service';
import { calibrationCommand,emptyHeldCalibration,heldCalibrationSchema } from './calibration-command-model';
import { reviewConversationMessages,type ReviewMessage } from './conversation';
import { pmBands,potentialBands,type PMBand,type PotentialBand } from './model';
const axisSchema=z.enum(['performance','potential','both']);
async function authorized(ctx:SessionContext,id:string,axis:'performance'|'potential'|'both'){
 z.uuid().parse(id);axisSchema.parse(axis);const v=await getOnehrCalibration(ctx,id);
 if(v.modules.review===false)throw Error('Guided review is disabled.');
 if(axis==='performance'&&!v.axes.pm||axis==='potential'&&!v.axes.pot||axis==='both'&&!v.axes.pm&&!v.axes.pot)throw Error('This calibration axis is disabled.');
 return v;
}
export async function getCalibrationConversation(ctx:SessionContext,id:string,axis:'performance'|'potential'|'both'){
 await authorized(ctx,id,axis);
 return withPerformanceTenant(ctx,async tx=>{const [row]=await tx.select().from(calibrationConversation).where(and(eq(calibrationConversation.sessionId,id),eq(calibrationConversation.actorUserId,ctx.userId!),eq(calibrationConversation.axis,axis)));return {revision:row?.revision??null,messages:row?reviewConversationMessages.parse(row.messages):[]};});
}
export async function sendCalibrationMessage(ctx:SessionContext,id:string,axis:'performance'|'potential'|'both',expected:number|null,requestId:string,text:string){
 z.uuid().parse(requestId);const words=z.string().trim().min(1).max(2500).parse(text),view=await authorized(ctx,id,axis);
 return withPerformanceTenant(ctx,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${id}:${ctx.userId}:${axis}`},0))`);
  const [row]=await tx.select().from(calibrationConversation).where(and(eq(calibrationConversation.sessionId,id),eq(calibrationConversation.actorUserId,ctx.userId!),eq(calibrationConversation.axis,axis))).for('update');
  const messages=row?reviewConversationMessages.parse(row.messages):[],duplicate=messages.findIndex(m=>m.id===requestId);
  if(duplicate>=0)return {revision:row!.revision,messages,draftUpdated:true};
  if((row?.revision??null)!==expected)throw Error('This conversation changed. Reload before sending another message.');
  if(messages.length>296)throw Error('This conversation has reached its limit. The saved review remains available.');
  let held=heldCalibrationSchema.parse(row?.held??emptyHeldCalibration),reply='',kind:ReviewMessage['kind']='guide';
  const command=calibrationCommand(words,view.rows.map(r=>({id:r.entry.reviewId,name:r.name})),axis,view.session.tier);
  if(command){
   const target=view.rows.find(r=>r.entry.reviewId===command.reviewId)!;
   if(target.finalized||view.session.lockedAt||command.axis==='performance'&&(view.session.performanceLockedAt||target.entry.performanceLockedAt)||command.axis==='potential'&&(view.session.potentialLockedAt||target.entry.potentialLockedAt))throw Error('This assessment axis is locked.');
   if(view.session.tier==='hod'&&!command.submit){
    await saveOnehrCalibrationTx(tx,ctx,id,view.session.revision,{reviewId:command.reviewId,axis:command.axis,performance:command.axis==='performance'?command.band as PMBand:null,potential:command.axis==='potential'?command.band as PotentialBand:null,performanceNote:command.axis==='performance'?command.reason:'',potentialNote:command.axis==='potential'?command.reason:''},true);
    const line={reviewId:command.reviewId,sessionRevision:view.session.revision,axis:command.axis,band:command.band,reason:command.reason};
    held={lines:[...held.lines.filter(l=>l.reviewId!==command.reviewId||l.axis!==command.axis),line],focus:command.reviewId,requestId};
    reply=`The ${command.axis} band and your explanation are on ${target.name}’s review sheet. Review them and use Save to confirm the department decision.`;kind='draft';
   }else{
    await saveOnehrCalibrationTx(tx,ctx,id,view.session.revision,{reviewId:command.reviewId,axis:command.axis,performance:command.axis==='performance'?command.band as PMBand:null,potential:command.axis==='potential'?command.band as PotentialBand:null,performanceNote:command.axis==='performance'?command.reason:'',potentialNote:command.axis==='potential'?command.reason:''});
    held={...held,lines:held.lines.filter(l=>l.reviewId!==command.reviewId||l.axis!==command.axis),focus:null};
    reply=`${target.name}’s ${command.axis} band is saved as ${command.band}.${view.session.tier==='hod'?' This department decision is confirmed.':' You can revise it until calibration is locked.'}`;kind='action';
   }
  }else if(/^(?:show )?(?:the )?(?:distribution|cohort|talent box)[.!?]?$/i.test(words)){
   reply=(axis==='potential'?potentialBands:pmBands).map(b=>`${b}: ${view.rows.filter(r=>(axis==='potential'?r.entry.potential??r.currentPotential:r.entry.performance??r.currentPerformance)===b).length}`).join(' · ');
  }else if(/^explain:\s*/i.test(words)){
   const name=words.replace(/^explain:\s*/i,'').trim(),targets=view.rows.filter(r=>r.name.normalize('NFKC').toLocaleLowerCase()===name.normalize('NFKC').toLocaleLowerCase());
   if(targets.length!==1)throw Error('Use one exact, unambiguous name from this cohort.');
   const r=targets[0];reply=`${r.name}: ${r.journey.map(j=>`${j.tier}: ${axis==='potential'?j.potential??'—':j.performance??'—'}`).join(' → ')}. Open the person’s review for the supporting insight and your saved explanation.`;
  }else reply=['Use the cohort filters and band distribution to review your scope. Open a person for evidence and the review controls.',view.session.tier==='group'||view.session.tier==='final'?'This conversation explains the current bands. Record decisions and locks with the review controls.':`To ${view.session.tier==='hod'?'prepare':'save'} a change, type “Set performance: exact name: ME: your explanation” or “Set potential: exact name: Mid: your explanation”.`,view.session.tier==='hod'?'Set prepares a private edit on the review sheet. “Save department performance: exact name: ME: your explanation” explicitly confirms that department decision.':'', '“Show distribution” lists the current bands. “Explain: exact name” shows the band journey. Locking calibration remains a separate confirmation.'].filter(Boolean).join('\n\n');
  const at=new Date().toISOString(),next:ReviewMessage[]=[...messages,{id:requestId,role:'user',kind:'message',text:words,at},{id:randomUUID(),role:'assistant',kind,text:reply,at}];
  const data={messages:next,held,updatedAt:new Date()};
  const [saved]=row?await tx.update(calibrationConversation).set({...data,revision:row.revision+1}).where(eq(calibrationConversation.id,row.id)).returning():await tx.insert(calibrationConversation).values({...data,tenantId:ctx.tenantId,sessionId:id,actorUserId:ctx.userId!,axis}).returning();
  return {revision:saved.revision,messages:next,draftUpdated:true};
 });
}
