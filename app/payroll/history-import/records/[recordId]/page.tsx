import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {payrollHistoryMaintenanceRecord} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {HistoryMaintenanceControl} from '../../maintenance-control';
import {HistoryMaintenanceAudit} from '../../maintenance-audit';
export default async function ImportedHistoryRecordPage({params}:{params:Promise<{recordId:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('payrollHistoryMaintenance'),{recordId}=await params,detail=await payrollHistoryMaintenanceRecord(ctx,recordId);if(!detail)notFound();
 return <div className={pageWideCls}><PageHeader title={[detail.employeeNo,detail.employeeName].filter(Boolean).join(' · ')} description={detail.companyName+' · '+detail.period+' · '+detail.cycleName} back={{href:'/payroll/history-import/records',label:t('records')}}/>{detail.withdrawn&&<p className="mb-4 rounded-lg border border-border p-4 text-sm">{t('withdrawnHelp')}</p>}<HistoryMaintenanceControl key={detail.currentRevisionId} detail={detail}/><HistoryMaintenanceAudit detail={detail}/></div>;
}
