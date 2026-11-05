import {getTranslations} from 'next-intl/server';
import {Button,Card,Field,inputCls} from '@/components/ui';
import type {CompanyRegistrationClassification} from '@/lib/company-registration-readiness';
import {saveRegistrationClassification} from './registration-actions';
export async function RegistrationClassification({companyId,value}:{companyId:string;value:CompanyRegistrationClassification}){
 const t=await getTranslations('admin.organization');
 return <Card><form action={saveRegistrationClassification} className="flex flex-wrap items-end gap-4 p-4"><input type="hidden" name="companyId" value={companyId}/><input type="hidden" name="expectedRevision" value={value.revision}/><Field label={t('registration.entityType')}><select className={inputCls} name="entityKind" defaultValue={value.entityKind}><option value="legal_entity">{t('registration.legalEntity')}</option><option value="grouping_node">{t('registration.groupingNode')}</option></select></Field><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="isTestEntity" value="true" defaultChecked={value.isTestEntity}/>{t('registration.testEntity')}</label><Button type="submit" variant="outline">{t('registration.saveClassification')}</Button><p className="w-full text-xs text-muted-foreground">{t('registration.classificationHint')}</p></form></Card>;
}
