import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {viewerIdentity} from '@/lib/viewer';
import {probationCase,probationSignerCandidates} from '@/packs/probation/service';
import {PartEditor} from '../../part-editor';
export default async function Page({params}:{params:Promise<{id:string;partId:string}>}){
 const {id,partId}=await params,session=await requireScopedLifecycleModule();
 const [view,viewer]=await Promise.all([probationCase(session,id),viewerIdentity(session)]);
 const part=view.parts.find(p=>p.id===partId);if(!part)notFound();
 const signerCandidates=view.roles.some(role=>role==='pbp'||role==='gbs')?Array.from(await probationSignerCandidates(session,id)):undefined;
 return <PartEditor signerCandidates={signerCandidates} key={part.id+':'+part.storageRevision} view={view} part={part} actor={{id:session.userId??'',name:viewer.name??''}}/>;
}
