import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {packFor} from '@/localization/registry';
import {PageHeader,pageWideCls} from '@/components/ui';
import {IncentiveDeclarationCard} from '@/app/admin/personnel/[employmentId]/incentive-card';

const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/** Dedicated payroll context: never opens or broadens the current employer's personnel profile. */
export default async function PayrollTaxConfigurationPage({params,searchParams}:{params:Promise<{batchId:string;employmentId:string}>;searchParams:Promise<{incentiveError?:string}>}){
  const session=await requireAdmin();
  const {batchId,employmentId}=await params;
  if(!uuid.test(batchId)||!uuid.test(employmentId))notFound();
  const t=await getTranslations('payroll.taxConfiguration');
  const service=packFor('MY')?.statutory.listTaxSchemeDeclarations;
  let view;
  try{view=await service?.(session,employmentId,batchId);}
  catch(error){if(error instanceof Error&&error.name==='TaxSchemeDeclarationError'&&'code' in error&&error.code==='not_found')notFound();throw error;}
  if(!view)notFound();
  const query=await searchParams;
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={t('context',{employee:view.employeeCode??employmentId,employer:view.companyName,period:view.payPeriod??''})}/>
    <p className="mb-4 text-sm text-muted-foreground">{t('permissionHint')}</p>
    <Link href={`/payroll/${batchId}/reprocess`} className="mb-4 inline-block text-sm text-primary">{t('back')}</Link>
    <IncentiveDeclarationCard employmentId={employmentId} view={view} error={query.incentiveError}/>
  </div>;
}
