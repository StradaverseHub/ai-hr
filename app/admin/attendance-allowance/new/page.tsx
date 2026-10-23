import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { allowanceSetupOptions } from '@/packs/attendance/service';
import { listAttendanceAllowancePayCodes } from '@/packs/payroll/service';
import { AttendanceAllowanceEditor } from '@/components/attendance-allowance-editor';
import { PageHeader,pageWideCls } from '@/components/ui';
import { saveAllowancePolicyFormAction } from '../actions';
export default async function NewAllowancePolicyPage(){
  const {s,scopeIds}=await scopedAdmin();
  const t=await getTranslations('allowanceV2');
  const [options,components]=await Promise.all([allowanceSetupOptions(s,scopeIds,{catalogs:false}),listAttendanceAllowancePayCodes(s)]);
  return <div className={pageWideCls}><a className="text-sm text-muted-foreground hover:underline" href="/admin/attendance-allowance">← {t('backPolicies')}</a><PageHeader title={t('create')} description={t('setupDescription')}/><AttendanceAllowanceEditor options={options} components={components} action={saveAllowancePolicyFormAction}/></div>;
}
