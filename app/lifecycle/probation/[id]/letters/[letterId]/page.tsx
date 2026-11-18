import '../../case.css';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {viewerIdentity} from '@/lib/viewer';
import {readProbationLetterCompletion,readProbationLetter,probationSignerCandidates} from '@/packs/probation/service';
import {notFound} from 'next/navigation';
import {ProbationError} from '@/lib/probation-model';
import {ProbationLetterCompletion} from '../../../letter-completion';
import {LetterView} from '../../../letter-view';
export default async function Page({params}:{params:Promise<{id:string;letterId:string}>}){
 const{id,letterId}=await params,ctx=await requireScopedLifecycleModule(),[letter,completion,viewer]=await Promise.all([readProbationLetter(ctx,id,letterId).catch(error=>{if(error instanceof ProbationError&&error.code==='forbidden')return null;throw error;}),readProbationLetterCompletion(ctx,{caseId:id,partId:letterId}).catch(error=>{if(error instanceof ProbationError&&error.code==='forbidden')return null;throw error;}),viewerIdentity(ctx)]);
 if(!letter&&!completion)notFound();
 const signerCandidates=letter?.canPrepare?Array.from(await probationSignerCandidates(ctx,id)):undefined;
 const CompletionRoot=letter?'section':'main';
 return <>{completion&&<CompletionRoot className="pcc"><ProbationLetterCompletion key={completion.partId+':'+completion.storageRevision} view={completion}/></CompletionRoot>}{letter&&<LetterView signerCandidates={signerCandidates} key={letter.id+':'+letter.storageRevision+':'+letter.signing?.document.actions.length} letter={letter} actor={{id:ctx.userId??'',name:viewer.name??''}}/>}</>;
}
