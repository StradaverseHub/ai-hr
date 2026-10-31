import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {getJobMasters,getJobForm,type JobInput} from '@/packs/job-descriptions/service';
import {Button,Field,PageHeader,inputCls} from '@/components/ui';
import {JobEditor} from '../editor';
export default async function NewJobPage({searchParams}:{searchParams:Promise<{company?:string}>}){
 const s=await requireAdmin();const t=await getTranslations('jobDescriptions');const{company}=await searchParams;const masters=await getJobMasters(s);const selected=masters.companies.find(c=>c.value===company);
 const initial:JobInput={companyId:selected?.value??'',jobCode:'',title:'',owner:'',org:{},answers:{},effectiveOn:'',reviewOn:'',reason:'',approverId:'',reviewerIds:[]};
 return <div className="mx-auto max-w-6xl space-y-6"><Link className="text-sm text-primary underline" href="/admin/job-descriptions">{t('back')}</Link><PageHeader title={t('create')} description={t('commonIdHint')}/>{selected?<JobEditor initial={initial} definition={await getJobForm(s,selected.value)} masters={masters}/>:<form className="max-w-lg space-y-4"><Field label={t('company')} required><select className={inputCls} name="company" required><option value="">{t('chooseCompany')}</option>{masters.companies.map(c=><option key={c.value} value={c.value}>{c.label}</option>)}</select></Field><p className="text-sm text-muted-foreground">{t('companyIdentity')}</p><Button>{t('continue')}</Button></form>}</div>;
}
