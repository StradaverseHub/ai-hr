import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {v9DocumentSigningWorkspace,v9ReadDocumentSigningWork} from '@/packs/lifecycle/service';
import {V9RoutedDocument} from './routed-document';
import '../../lifecycle/v9/workspace.css';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const query=await searchParams,search=typeof query.search==='string'?query.search.slice(0,100):'',offset=Math.max(0,Math.floor(Number(query.offset)||0)),session=await requireModule('lifecycle'),t=await getTranslations('lifecycleDocumentRouting');
 const workspace=await v9DocumentSigningWorkspace(session,{search,offset});
 const selected=typeof query.case==='string'&&typeof query.document==='string'?await v9ReadDocumentSigningWork(session,query.case,query.document).catch(()=>null):null;
 const link=(next:number)=>'/me/document-signing?'+new URLSearchParams({search,offset:String(next)});
 return <main className="v9-workspace"><div className="v9-content v9-stack"><h1>{t('title')}</h1><p>{t('help')}</p><form className="v9-actions"><label className="v9-field"><span>{t('search')}</span><input name="search" defaultValue={search} maxLength={100}/></label><button className="v9-button" type="submit">{t('search')}</button></form>
  {selected?<><Link className="v9-button" href={link(offset)}>{t('back')}</Link><V9RoutedDocument key={selected.caseId+':'+selected.documentId+':'+selected.caseRevision} initial={selected} actor={workspace.actor}/></>:<><p>{t('count',{total:workspace.total})}</p><ul className="v9-list">{workspace.items.map(item=><li key={item.caseId+':'+item.documentId}><Link className="v9-link" href={'/me/document-signing?'+new URLSearchParams({case:item.caseId,document:item.documentId})}>{item.name}</Link><span className="v9-muted"> · {item.number}</span></li>)}</ul>{!workspace.items.length&&<p>{t('empty')}</p>}<nav className="v9-actions">{offset>0&&<Link className="v9-button" href={link(Math.max(0,offset-50))}>{t('previous')}</Link>}{offset+workspace.items.length<workspace.total&&<Link className="v9-button" href={link(offset+50)}>{t('next')}</Link>}</nav></>}
 </div></main>;
}
