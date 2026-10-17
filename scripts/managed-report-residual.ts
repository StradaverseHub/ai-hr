/** Closed continuation evidence only; never a replacement full verification receipt. */
import {z} from 'zod';
export const RESIDUAL_PREDECESSOR='673e7898-f258-47e0-be2f-6f983b90916b';
export const RESIDUAL_SOURCE='e449cf7e5273e2047164bec933abf402a37ffee7';
export const RESIDUAL_DATE='2026-10-18';
export const RESIDUAL_PINNED_FILES={
 'failure-verify.json':'c243785d614a07a052a7e197084e95ef46d1c485b31ce21566b3913d8c4577d3',
 'fixture.json':'b285c3f7c1b84ae00a25be03a0d8a8e4cfe1b6093b43eacb44de5a021c44f04b',
 'configured.json':'5f0b359a25345dbe77d971b624ca5601439eea1dc4ab7bdd27fe867a93da4b94',
 'post-failure-retained-memory-counters.json':'43ef5d2fb884da61f8c2d46cbc6cc7f52988bea0bb4df262210527cdfa65a38b',
} as const;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const residualPredecessorManifest=z.object({version:z.literal(1),runId:z.literal(RESIDUAL_PREDECESSOR),candidateSha:z.literal(RESIDUAL_SOURCE),date:z.literal(RESIDUAL_DATE),files:z.record(z.string().regex(/^[-a-zA-Z0-9_.]+$/).refine(name=>name!=='.'&&name!=='..'),digest).refine(files=>Object.keys(files).length>0&&Object.keys(files).length<=200&&Object.entries(RESIDUAL_PINNED_FILES).every(([name,sha])=>files[name]===sha)&&!['verification.json','verified.json','PASS','PASS.json'].some(name=>name in files))}).strict();
export function assertResidualFailure(value:unknown){
 z.object({status:z.literal('FAILED'),stage:z.literal('budget20'),error:z.object({name:z.literal('Error'),messageSha256:z.literal('17a2d39b142d9066bc35e170f73f087b09842b83e132569c7d3853c6ab52347b'),messageBytesHashed:z.literal(48),truncated:z.literal(false)}).strict()}).strict().parse(value);
}
export const residualCaseInventory=z.tuple([
 z.object({kind:z.literal('oversized'),reportId:z.uuid(),scheduleId:z.uuid()}).strict(),
 z.object({kind:z.literal('consent'),reportId:z.uuid(),scheduleId:z.uuid()}).strict(),
]).refine(rows=>rows[0].reportId!==rows[1].reportId&&rows[0].scheduleId!==rows[1].scheduleId);
export async function runManagedReportResidualCases(d:{cases:unknown;oversized():Promise<unknown>;consent():Promise<unknown>;memory():Promise<unknown>;checkpoint(name:string,details:unknown):Promise<void>;cleanup():Promise<void>}){
 residualCaseInventory.parse(d.cases);
 try{
  const oversized=await d.oversized();await d.checkpoint('oversized',oversized);
  const consent=await d.consent();await d.checkpoint('consent',consent);
  const memory=await d.memory();await d.checkpoint('memory',memory);
  return {kind:'Residual verification only; original failure retained; not a full verification',checks:{oversized,consent,memory}};
 }finally{await d.cleanup();}
}
