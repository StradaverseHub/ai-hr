'use server';

import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {reverseRetiredAttendanceFormulaInputs} from '@/core/payroll';
import {payrollListReturnTo} from '@/lib/return-to';

export async function reverseRetiredAttendanceFormulaAction(form:FormData) {
 const {s,scopeIds}=await scopedAdmin();
 const batchId=String(form.get('batchId')??'');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId))redirect('/payroll');
 const from=payrollListReturnTo(String(form.get('from')??''));
 const query=new URLSearchParams();
 if(from!=='/payroll')query.set('from',from);
 try {
  await reverseRetiredAttendanceFormulaInputs(s,{batchId,scopeIds,reason:String(form.get('reason')??'')});
 } catch {
  const t=await getTranslations('payroll.batch');
  query.set('error',t('retiredFormulaCorrectionFailed'));
 }
 const path='/payroll/'+batchId;
 revalidatePath(path);
 redirect(path+(query.size?'?'+query.toString():''));
}
