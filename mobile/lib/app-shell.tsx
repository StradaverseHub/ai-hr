/** One signed-in frame for tab pages, pushed forms, loading states and detail screens. */
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { DesignText as Text, TenantBrand, useTenantDesign } from './design';
import { useApi } from './api';
import { useSession } from './session';
import { Icon } from './icon';
import { t } from './i18n';
import { DailyNavigation } from './daily-navigation';
import { TenantNavigation } from './tenant-navigation';
import { InAppAlertBoundary } from './in-app-alert';

export function SignedInShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { palette, design } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const account = useApi('me', {}, signOut);
  const employment = account.data?.employments.find(item=>item.employmentId===employmentId) ?? account.data?.employments[0];
  const monogram = (account.data?.person.name??'').trim().split(/\s+/).map(part=>part[0]).slice(0,2).join('') || '·';
  return <InAppAlertBoundary><View style={{ flex: 1, backgroundColor: palette.bg }}>
    <SafeAreaView edges={['top']} style={{ backgroundColor: palette.bg }}>
      <View style={{ minHeight: 56, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, paddingVertical: 10 }}><TenantBrand /></View>
        {design.schemaVersion===1?<View style={{flexDirection:'row',alignItems:'center',gap:4}}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('tabInbox')} onPress={()=>router.navigate('/inbox')} style={{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center'}}><Icon name="bell" size={21} color={palette.text}/></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t('tabMe')} onPress={()=>router.navigate('/me')} style={{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center'}}><View style={{width:30,height:30,borderRadius:15,backgroundColor:palette.text,alignItems:'center',justifyContent:'center'}}><Text style={{color:palette.bg,fontSize:12,fontWeight:'700'}}>{monogram}</Text></View></Pressable>
        </View>:<Pressable accessibilityRole="button" accessibilityLabel={t('qaSettings')} onPress={() => router.navigate('/settings')}
          style={({ pressed }) => ({ minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .65 : 1 })}>
          <Icon name="settings" size={23} color={palette.text} />
        </Pressable>}
      </View>
      {design.schemaVersion===1&&employment&&<Text style={{color:palette.text,fontSize:12,fontWeight:'600',paddingHorizontal:20,paddingTop:4,paddingBottom:4}}>{employment.company}</Text>}
    </SafeAreaView>
    {design.schemaVersion === 2 && design.composition.navigation.style === 'top' && <TenantNavigation design={design} inline />}
    <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
    {/* In normal flow: fixed page actions end above navigation instead of underneath it. */}
    {design.schemaVersion === 2 && design.composition.navigation.style !== 'top' ? <TenantNavigation design={design} inline /> : <DailyNavigation inline />}
  </View></InAppAlertBoundary>;
}
