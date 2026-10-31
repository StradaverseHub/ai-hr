import {getTranslations} from 'next-intl/server';
import {notFound} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {getPayFormula,payFormulaOptions} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {FormulaEditor} from '../editor';
export default async function FormulaPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{view?:string}>}){const ctx=await requireAdmin(),t=await getTranslations('payFormula'),{id}=await params,query=await searchParams;const [formula,options]=await Promise.all([getPayFormula(ctx,id),payFormulaOptions(ctx)]);if(!formula)notFound();return <div className={pageWideCls+' space-y-6'}><PageHeader title={formula.formulaId} description={formula.latest.description} back={{href:'/payroll/formula-builder',label:t('title')}}/><FormulaEditor initial={formula} options={options} readOnly={query.view==='1'}/></div>;}
