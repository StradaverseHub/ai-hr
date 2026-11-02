import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {viewerIdentity} from '@/lib/viewer';
import {readProbationLetter} from '@/packs/probation/service';
import {LetterView} from '../../../letter-view';
export default async function Page({params}:{params:Promise<{id:string;letterId:string}>}){
 const{id,letterId}=await params,ctx=await requireScopedLifecycleModule(),[letter,viewer]=await Promise.all([readProbationLetter(ctx,id,letterId),viewerIdentity(ctx)]);
 return <LetterView key={letter.id+':'+letter.storageRevision+':'+letter.signing?.document.actions.length} letter={letter} actor={{id:ctx.userId??'',name:viewer.name??''}}/>;
}
