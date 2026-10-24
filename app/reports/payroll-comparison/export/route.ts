import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {isAdmin} from '@/lib/authz';
import {allowedCompanies} from '@/core/read';
import {getScopeIds} from '@/lib/scope';
import {runPayrollComparisonReport,recordPayrollComparisonRun,ReportAccessError} from '@/core/custom-reports';
import {MasterReportAccessError} from '@/core/employee-master-access';
import {PayrollComparisonInputError} from '@/lib/payroll-period-comparison';
import {serializePayrollComparison} from '@/lib/payroll-comparison-export';
export async function GET(request:Request){
  const s=await getSession();if(!isAdmin(s))return new Response('Forbidden',{status:403});
  const url=new URL(request.url),id=url.searchParams.get('id'),format=url.searchParams.get('format');
  if(!id||!['pdf','xlsx'].includes(format??''))return new Response('Choose a saved report and PDF or Excel.',{status:400});
  const allowed=await allowedCompanies(s),scope=await getScopeIds(allowed.map(company=>company.id));
  const filters=Object.fromEntries([...url.searchParams].filter(([key])=>key!=='id'&&key!=='format'));
  try{
    const run=await runPayrollComparisonReport(s,scope,{id,filters,verb:'export'});
    const t=await getTranslations('payrollComparison');
    const file=await serializePayrollComparison(run,format as 'pdf'|'xlsx',t);
    await recordPayrollComparisonRun(s,run,'export',format as 'pdf'|'xlsx');
    return new Response(new Uint8Array(file.bytes),{headers:{'Content-Type':file.contentType,'Content-Disposition':`attachment; filename="${file.filename}"`,'Cache-Control':'private, no-store'}});
  }catch(error){
    if(error instanceof MasterReportAccessError||error instanceof ReportAccessError)return new Response('Report unavailable.',{status:403});
    if(error instanceof PayrollComparisonInputError)return new Response('Invalid comparison filters.',{status:400});
    console.error('Payroll comparison export failed',error);return new Response('Could not export this comparison. Narrow the scope or review its source availability.',{status:422});
  }
}
