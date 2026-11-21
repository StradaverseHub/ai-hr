import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {closeAll,migrateTestDb,owner} from './harness';
import {readContractSharedLetter,actContractSharedLetter} from '../packs/contracts/service';
import {readContractSharedForm} from '../core/contract-shared-form';
import {formFixture,visible,saveAnswers,actForm} from './helpers/contract-document-fixture';
import {currentRoundActions,signingDocumentOwner,type SigningDocument} from '../lib/document-signing-model';
beforeAll(migrateTestDb);afterAll(closeAll);

it('keeps actual Contract review receipts across a live Personnel refresh, then invalidates them on send-back until explicit owner resend',async()=>{
 const f=await formFixture();
 await saveAnswers(f.admin,f.letterId,{hrChoice:'Yes'});
 await actForm(f.admin,f.letterId,'reviewed');
 const reviewed=await readContractSharedLetter(f.admin,f.letterId);
 expect(reviewed.pendingAction?.kind).toBe('sign');
 await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-LIVE-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
 expect(visible(await readContractSharedForm(f.admin,f.letterId)).values.lockedBank).toBe('FICTIONAL-LIVE-BANK');
 const refreshed=await readContractSharedLetter(f.admin,f.letterId);
 expect(refreshed.contentHash).not.toBe(reviewed.contentHash);
 expect(refreshed.pendingAction?.kind).toBe('sign');
 await actForm(f.admin,f.letterId,'signed');
 const employee=await readContractSharedLetter(f.employeeActor,f.letterId);
 await actContractSharedLetter(f.employeeActor,{id:f.letterId,actionId:randomUUID(),stepId:employee.pendingAction!.stepId,revision:employee.contentRevision,hash:employee.contentHash!,action:'returned',comment:'Please review the corrected source again.'});
 await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-RETURNED-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
 expect(visible(await readContractSharedForm(f.admin,f.letterId)).values.lockedBank).toBe('FICTIONAL-RETURNED-BANK');
 const held=await readContractSharedLetter(f.admin,f.letterId);
 expect(held.returned).toBe(true);expect(held.canResend).toBe(true);
 expect((await readContractSharedLetter(f.employeeActor,f.letterId)).pendingAction).toBeNull();
 await actContractSharedLetter(f.admin,{id:f.letterId,actionId:randomUUID(),stepId:held.layers.find(layer=>layer.owner)!.id,revision:held.contentRevision,hash:held.contentHash!,action:'resent',comment:'Start the unchanged frozen route again.'});
 expect((await readContractSharedLetter(f.admin,f.letterId)).pendingAction?.kind).toBe('review');
 expect((await readContractSharedLetter(f.employeeActor,f.letterId)).pendingAction).toBeNull();
},180_000);

it('matches shared SQL and TypeScript round custody for retained Contract decisions without retaining stale signatures',async()=>{
 const review={id:'reviewed',stepId:'review',action:'reviewed',contentRevision:1,contentHash:'a',signature:null};
 const signature={...review,id:'signed',stepId:'sign',action:'signed',signature:{method:'typed',value:'Fictional',consent:true}};
 // A pure-reader fixture, not a published route: verify the exact current-round projection independently of subject setup.
 const document={subjectType:'contract',contentRevision:1,contentHash:'b',routing:{liveMergeReviews:true},actions:[review,signature]} as unknown as SigningDocument;
 const read=async(d:SigningDocument)=>(await owner.db.execute<{ids:string[]}>(sql`select coalesce(jsonb_agg(a->>'id'),'[]'::jsonb) as ids from app.document_signing_round_actions(${JSON.stringify(d)}::jsonb) a`))[0].ids;
 expect(await read(document)).toEqual(['reviewed']);expect(currentRoundActions(document).map(a=>a.id)).toEqual(['reviewed']);
 const returned={...review,id:'returned',action:'returned'};
 const revised={...document,contentRevision:2,actions:[...document.actions,returned]} as SigningDocument;
 expect(await read(revised)).toEqual(['returned']);expect(currentRoundActions(revised).map(a=>a.id)).toEqual(['returned']);
 const resent={...returned,id:'resent',action:'resent',contentRevision:2,contentHash:'b'};
 const restarted={...revised,actions:[...revised.actions,resent]} as SigningDocument;
 expect(await read(restarted)).toEqual([]);expect(currentRoundActions(restarted)).toEqual([]);
});

it('keeps an unresolved frozen Contract owner NULL while preserving V9 administrative fallback',async()=>{
 const fallback=randomUUID();
 const shape={subjectType:'contract',routing:{caseOwnerId:fallback},route:{version:1,steps:[{id:'review',kind:'review',stage:0,owner:true,holderId:null}]}};
 const read=async(d:unknown)=>(await owner.db.execute<{id:string|null}>(sql`select app.document_signing_owner(${JSON.stringify(d)}::jsonb) as id`))[0].id;
 expect(await read(shape)).toBeNull();expect(signingDocumentOwner(shape as unknown as SigningDocument).userId).toBeNull();
 expect(await read({...shape,subjectType:'probation'})).toBe(fallback);
});
