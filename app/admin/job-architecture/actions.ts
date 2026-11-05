'use server';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {ArchitectureError,proposeArchitectureCatalogue,proposeArchitecturePositions,decideArchitectureProposal,scanArchitecture,proposeOutlierResolution,updateArchitectureOutlier,assignArchitectureSeat,previewArchitectureFile,commitArchitectureImport,generateArchitectureAdvice,decideArchitectureAdvice} from '@/packs/job-architecture/service';
export type ArchitectureActionState={error?:string;saved?:boolean;preview?:Awaited<ReturnType<typeof previewArchitectureFile>>};
const field=(fd:FormData,key:string)=>String(fd.get(key)??'');
export async function architectureAction(_state:ArchitectureActionState,fd:FormData):Promise<ArchitectureActionState>{const {s}=await scopedSession(),t=await getTranslations('jobArchitecture');try{
 const operation=field(fd,'operation');const raw=field(fd,'payload');if(raw.length>1500000)throw new ArchitectureError('invalid','');const p=raw?JSON.parse(raw):{};
 if(operation==='catalogue')await proposeArchitectureCatalogue(s,{catalogue:p.catalogue,baseRevision:p.baseRevision,reason:field(fd,'reason')});
 else if(operation==='positions')await proposeArchitecturePositions(s,{companyId:field(fd,'companyId'),catalogueRevision:p.catalogueRevision,sourceDigest:p.sourceDigest,mappings:p.mappings,reason:field(fd,'reason')});
 else if(operation==='decision')await decideArchitectureProposal(s,{id:field(fd,'id'),approve:field(fd,'decision')==='approve'});
 else if(operation==='scan')await scanArchitecture(s);
 else if(operation==='resolve')await proposeOutlierResolution(s,{id:field(fd,'id'),revision:Number(field(fd,'revision')),reason:field(fd,'reason')});
 else if(operation==='outlier')await updateArchitectureOutlier(s,{id:field(fd,'id'),revision:Number(field(fd,'revision')),ownerId:field(fd,'ownerId')||null,dueOn:field(fd,'dueOn')||null,state:field(fd,'state'),businessUnitId:field(fd,'businessUnitId')||null,description:field(fd,'description'),proposedFix:field(fd,'proposedFix')});
 else if(operation==='advice')await generateArchitectureAdvice(s,{kind:field(fd,'kind'),companyId:field(fd,'companyId'),subjectId:field(fd,'subjectId')});
 else if(operation==='adviceDecision')await decideArchitectureAdvice(s,{id:field(fd,'id'),decision:field(fd,'decision'),...(p.edited?{edited:p.edited}:{})});
 else if(operation==='seat')await assignArchitectureSeat(s,{userId:field(fd,'userId'),companyId:field(fd,'companyId')||null,role:field(fd,'role'),validFrom:field(fd,'validFrom'),validTo:field(fd,'validTo')||null});
 else if(operation==='preview'){const kind=field(fd,'kind');if(!['catalogue','positions','outliers'].includes(kind))throw new ArchitectureError('invalid','');const file=fd.get('file');if(!(file instanceof File)||file.size>5*1024*1024||!file.name.toLowerCase().endsWith('.xlsx'))throw new ArchitectureError('invalid','');const preview=await previewArchitectureFile(s,kind as 'catalogue'|'positions'|'outliers',new Uint8Array(await file.arrayBuffer()),field(fd,'companyId')||null);return {preview};}
 else if(operation==='import')await commitArchitectureImport(s,{id:field(fd,'id'),reason:field(fd,'reason')});
 else throw new ArchitectureError('invalid','');
 revalidatePath('/admin/job-architecture');revalidatePath('/admin/job-descriptions');return {saved:true};
 }catch(error){return {error:t(`errors.${error instanceof ArchitectureError?error.code:'invalid'}`)};}}
