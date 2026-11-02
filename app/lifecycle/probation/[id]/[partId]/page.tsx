import {notFound} from 'next/navigation';
import {requireModule} from '@/lib/authz';
import {viewerIdentity} from '@/lib/viewer';
import {probationCase} from '@/packs/probation/service';
import {PartEditor} from '../../part-editor';
export default async function Page({params}:{params:Promise<{id:string;partId:string}>}){
 const {id,partId}=await params,session=await requireModule('lifecycle');
 const [view,viewer]=await Promise.all([probationCase(session,id),viewerIdentity(session)]);
 const part=view.parts.find(p=>p.id===partId);if(!part)notFound();
 return <PartEditor key={part.id+':'+part.storageRevision} view={view} part={part} actor={{id:session.userId??'',name:viewer.name??''}}/>;
}
