import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {payFormulaOptions} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {FormulaEditor} from '../editor';
export default async function NewFormulaPage(){const ctx=await requireAdmin(),t=await getTranslations('payFormula'),options=await payFormulaOptions(ctx);return <div className={pageWideCls+' space-y-6'}><PageHeader title={t('newFormula')} description={t('subtitle')} back={{href:'/payroll/formula-builder',label:t('title')}}/><FormulaEditor initial={null} options={options}/></div>;}
