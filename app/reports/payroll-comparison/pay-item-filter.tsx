'use client';
import {isRecordedPayrollTotal} from '@/lib/payroll-reconciliation-items';
import {useTranslations} from 'next-intl';
import {ChipMultiSelect} from '@/components/ui/chip-multi-select';
export function ReconciliationPayItemFilter({items,selected}:{items:{code:string;name:string}[];selected:string[]}){
 const t=useTranslations('payrollComparison');
 return <div><input type="hidden" name="payItemCodes" value=""/><ChipMultiSelect name="payItemCodes" label={t('payItem')} options={items.map(item=>({value:item.code,label:isRecordedPayrollTotal(item.code)?item.name:item.code+' · '+item.name}))} defaultSelected={selected} addPlaceholder={t('allRecordedItems')} searchPlaceholder={t('searchPayItems')} removeLabelFor={value=>t('removePayItem',{value})}/></div>;
}
