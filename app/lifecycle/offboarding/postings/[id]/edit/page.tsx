import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {personnelPosting,offboardingPostingChoices} from '@/packs/personnel-postings/service';
import {PageHeader} from '@/components/ui';
import {PostingEditor} from './posting-editor';
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{q?:string}>}){
 const ctx=await requireScopedLifecycleModule(),{id}=await params,t=await getTranslations('offboardingPostings');
 const posting=await personnelPosting(ctx,id);if(!posting||posting.source!=='offboarding'||!posting.canEdit||posting.status!=='pending')notFound();
 const choices=await offboardingPostingChoices(ctx,id,(await searchParams).q??'');
 return <div className="mx-auto max-w-4xl space-y-6"><PageHeader title={posting.employeeName??t('title')} description={t('editing',{posting:posting.label})}/><p>{t('editRule')}</p><form className="flex gap-2"><input type="search" name="q" defaultValue={(await searchParams).q??''} aria-label={t('searchLabels')} placeholder={t('searchLabels')} className="rounded-lg border p-2"/><button className="rounded-lg border px-3 py-2">{t('search')}</button></form>{(choices.positions.length>500||choices.grades.length>500)&&<p>{t('narrowSearch')}</p>}<PostingEditor posting={posting} choices={choices}/></div>;
}
