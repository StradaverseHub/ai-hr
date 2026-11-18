import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {offboardingRequisitions} from '@/packs/lifecycle/service';
import '../../v9/workspace.css';
export default async function Page({searchParams}:{searchParams:Promise<{page?:string;search?:string}>}){
 const query=await searchParams,page=/^\d{1,5}$/.test(query.page??'')?Math.min(20000,Number(query.page)):0,search=(query.search??'').slice(0,100),t=await getTranslations('offboardingRequisition');
 const data=await offboardingRequisitions(await requireModule('lifecycle'),{offset:page*50,search});
 const href=(next:number)=>'?'+new URLSearchParams({page:String(next),search});
 return <main className="v9-workspace v9-stack"><header className="v9-heading"><h1>{t('register')}</h1><Link href="/lifecycle/v9?view=records">{t('records')}</Link></header><form className="v9-actions"><label className="v9-field"><span>{t('search')}</span><input name="search" defaultValue={search} maxLength={100}/></label><button className="v9-button">{t('search')}</button></form><p>{t('registerCount',{count:data.total})}</p><div className="v9-table-scroll"><table className="v9-table"><thead><tr>{['register','leaver','lastDay','done','status'].map(key=><th key={key}>{t(key)}</th>)}</tr></thead><tbody>{data.items.map(row=><tr key={row.id}><td><Link className="v9-link" href={'/lifecycle/requisitions/offboarding/'+row.id}>{row.number}</Link><div>{row.caseNumber}</div></td><td>{row.name}</td><td>{row.lastDay}</td><td>{t('count',{done:row.done,total:row.total})}</td><td>{t(row.state==='cancelled'?'cancelled':row.exceptions&&!row.exceptionsReviewed?'review':row.total>0&&row.done+(row.exceptionsReviewed?row.exceptions:0)===row.total?'completed':'progress')}</td></tr>)}</tbody></table></div><nav className="v9-actions">{page>0&&<Link className="v9-button" href={href(page-1)}>{t('previous')}</Link>}{data.offset+data.items.length<data.total&&<Link className="v9-button" href={href(page+1)}>{t('next')}</Link>}</nav></main>;
}
