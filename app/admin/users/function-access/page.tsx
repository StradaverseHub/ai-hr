import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {Card,SectionHeader} from '@/components/ui';
import {FunctionAccessGrid} from '@/components/function-access-grid';
import type {Role,ScreenEntry} from '@/lib/permissions';
import {SecurityPageHeader} from '../security-page';
export default async function FunctionAccessPage(){
 await requireAdmin();
 const t=await getTranslations('admin.users'),tAll=await getTranslations(),center=await getTranslations('securityCenter');
 const screenLabel=(screen:ScreenEntry):string=>tAll(screen.labelKey);
 const scopeNoteFor=(screen:ScreenEntry):string|null=>screen.hasScopeNote?t(`scope.${screen.screenKey}`):null;
 const roleLabelFor=(role:Role):string=>t(`role.${role}`);
 return <div className="mx-auto max-w-5xl space-y-6"><SecurityPageHeader title={center('functions.title')}/>
      <Card data-tour="admin-function-access">
        <SectionHeader title={t('sectionFunctionAccess')} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('functionAccessCaption')}</p>
        <div className="p-4 pt-3">
          <FunctionAccessGrid
            roleLabel={roleLabelFor}
            screenLabel={screenLabel}
            scopeNote={scopeNoteFor}
            labels={{
              accessible: t('accessible'),
              notAccessible: t('notAccessible'),
              screenColumn: t('screenColumn'),
            }}
          />
        </div>
      </Card>
 </div>;
}
