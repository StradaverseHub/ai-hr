import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {PDFDocument,PDFName,PDFRawStream,PDFDict} from 'pdf-lib';
import sharp from 'sharp';
import type {SessionContext} from '../db/client';
import {closeAll,migrateTestDb,createAppUser,owner} from './harness';
import {fixture,submit,letters} from './helpers/contract-document-fixture';
import {saveAutomationDocumentTemplate} from '../packs/automation/service';
import {readContractSharedLetter,actContractSharedLetter,renderContractSharedLetter,readContractSharedReleaseProof,contractSharedWorkspace} from '../packs/contracts/service';
import {contractPdfSignatures} from '../lib/contract-pdf-signatures';
import {renderV9DocumentPdf} from '../lib/lifecycle-v9-pdf';
import {extractedText} from './helpers/pcb-pdf-text';
beforeAll(migrateTestDb);afterAll(closeAll);
it('prints every actual canonical Sign receipt, both drawn marks, script typed name and original proofs for three routed signers',async()=>{
 const f=await fixture('renew'),employeeUser=await createAppUser(f.b.tenantId,f.employee.personId,'employee'),employeeActor:SessionContext={...f.admin,userId:employeeUser,personId:f.employee.personId,roles:['employee'],grants:undefined};
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Fictional second company signatory',${randomUUID()+'@pdf.test'}) returning id`);
 const companyUser=await createAppUser(f.b.tenantId,person.id,'employee'),companyActor:SessionContext={...f.admin,userId:companyUser,personId:person.id,roles:['employee'],grants:undefined};
 const templateId=String(f.workflow.steps[0].params.letterTemplateId);
 await saveAutomationDocumentTemplate(f.admin,{template:{id:templateId,module:'contract_staff',name:'Fictional three-party Contract letter',description:'Actual native signing and PDF regression',rules:{},blocks:[{id:'intro',type:'text',text:'This saved Contract letter retains all three authorised signatures.',section:''}],fields:[],routing:[{id:'review',order:1,action:'review',owner:true,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'first-sign',order:2,action:'sign',owner:false,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'second-sign',order:3,action:'sign',owner:false,who:{kind:'people',userIds:[companyUser]}},{id:'employee-sign',order:4,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:1,publish:true,retired:false});
 await submit(f,'renew');const [row]=await letters(f);
 async function act(actor:SessionContext,action:'reviewed'|'signed',signature?:{method:'typed'|'drawn';value:string;consent:true}){const letter=await readContractSharedLetter(actor,row.id);expect(letter.pendingAction).not.toBeNull();return actContractSharedLetter(actor,{id:row.id,actionId:randomUUID(),stepId:letter.pendingAction!.stepId,revision:letter.contentRevision,hash:letter.contentHash!,action,...signature});}
 await act(f.admin,'reviewed');await act(f.admin,'signed',{method:'typed',value:'Fictional chosen typed signature',consent:true});
 const mark=async(background:string)=>'data:image/png;base64,'+(await sharp({create:{width:128,height:48,channels:4,background}}).png().toBuffer()).toString('base64');
 const secondMark=await mark('#334455'),employeeMark=await mark('#223366');
 await act(companyActor,'signed',{method:'drawn',value:secondMark,consent:true});await act(employeeActor,'signed',{method:'drawn',value:employeeMark,consent:true});
 const letter=await readContractSharedLetter(employeeActor,row.id),before=structuredClone(letter),document=renderContractSharedLetter(letter)!;
 expect(letter.state).toBe('released');expect(letter.body!.receipts).toHaveLength(3);await expect(contractSharedWorkspace(employeeActor,f.caseId)).rejects.toMatchObject({code:'forbidden'});
 const evidence=contractPdfSignatures(letter);expect(evidence).toHaveLength(3);expect(evidence.map(item=>item.contentHash)).toEqual([letter.contentHash,letter.contentHash,letter.contentHash]);expect(evidence[1].signature.value).toBe(secondMark);expect(evidence[2].signature.value).toBe(employeeMark);
 const proof=await readContractSharedReleaseProof(employeeActor,row.id);expect(proof?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
 const result=await renderV9DocumentPdf(document,'Contract · '+proof!.fingerprint,false,evidence),pdf=await PDFDocument.load(result.bytes),text=(await extractedText(result.bytes)).replace(/\s+/g,' ');
 expect(text).toContain('Fictional chosen typed signature');expect(text).toContain('Fictional second company signatory');expect(text).toContain('Fictional ending subject');expect(text.match(/Verified AIHR login/g)).toHaveLength(3);expect(text).toContain(letter.contentHash!);
 const images=pdf.context.enumerateIndirectObjects().filter(([,object])=>object instanceof PDFRawStream&&object.dict.get(PDFName.of('Subtype'))?.toString()==='/Image');expect(images.length).toBeGreaterThanOrEqual(2);
 const fonts=pdf.context.enumerateIndirectObjects().filter(([,object])=>object instanceof PDFDict&&object.get(PDFName.of('BaseFont'))?.toString().includes('Caveat'));expect(fonts.length).toBeGreaterThan(0);expect(letter).toEqual(before);
 const mismatched={...letter,history:letter.history.map(action=>action.action==='signed'?{...action,hash:'0'.repeat(64)}:action)};expect(()=>contractPdfSignatures(mismatched)).toThrow('signature proof needs review');
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR){const dir=join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'contract-pdf');await mkdir(dir,{recursive:true});await writeFile(join(dir,'three-canonical-signers.pdf'),result.bytes);}
},180000);
