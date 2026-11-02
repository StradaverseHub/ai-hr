import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {payFormulaOptions} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {isPayFormulaTemplateKey} from '@/lib/pay-formula-templates';
import {FormulaEditor} from '../editor';
/** `?template=KEY` pre-fills an unsaved draft from a code-owned example; nothing is persisted until saved. */
export default async function NewFormulaPage({searchParams}:{searchParams:Promise<{template?:string}>}){const ctx=await requireAdmin(),t=await getTranslations('payFormula'),options=await payFormulaOptions(ctx),query=await searchParams,template=isPayFormulaTemplateKey(query.template)?query.template:undefined;if(!options.capabilities.add)notFound();return <div className={pageWideCls+' space-y-6'}><PageHeader title={t('newFormula')} description={t('subtitle')} back={{href:'/payroll/formula-builder',label:t('title')}}/><FormulaEditor key={template??'blank'} initial={null} options={options} template={template}/></div>;}
