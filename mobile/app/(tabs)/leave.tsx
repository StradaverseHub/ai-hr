/**
 * Leave — balances as a compact list (every eligible type, masked values and shared pools included), one "Request
 * leave" action and the request history. While a request is being written the tab shows the request screen instead
 * (mobile/lib/leave-request-form.tsx), its review bar pinned above the tab bar. The route id stays `leave` and the
 * published navigation id stays `requests`, so stored tenant designs keep working; only the label reads "Leave".
 */
import { useCallback, useRef } from 'react';
import { router,useFocusEffect } from 'expo-router';
import { Pressable,View } from 'react-native';
import { DesignText as Text } from '../../lib/design';
import { useTenantDesign } from '../../lib/design';
import { useApi } from '../../lib/api';
import { useJourneyDrafts } from '../../lib/journey-drafts';
import { LeaveRequestForm } from '../../lib/leave-request-form';
import { Material,StatusPill } from '../../lib/visual';
import { cardFigure } from '../../lib/home-cards';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { ListRow,LoadState,Muted,Row,Screen,SectionLabel,Title,fmtDays } from '../../lib/ui';
const STATUS:Record<string,Parameters<typeof t>[0]>={approved:'approved',pending:'pending',rejected:'rejected',cancelled:'cancelled'};
export default function Leave(){
  const {palette}=useTenantDesign();const {signOut,employmentId}=useSession();
  const leave=useApi('leave',{employmentId:employmentId??undefined},signOut);
  const options=useApi('leave-options',{employmentId:employmentId??undefined},signOut);
  const requests=useApi('leave-requests',{employmentId:employmentId??undefined},signOut);
  const {leave:draft}=useJourneyDrafts();
  const reload=useCallback(()=>{leave.reload();options.reload();requests.reload();},[leave.reload,options.reload,requests.reload]);
  const visited=useRef(false);
  useFocusEffect(useCallback(()=>{if(visited.current)reload();visited.current=true;},[reload]));
  const notices=Object.fromEntries((leave.data?.cards??[]).flatMap(c=>c.entitlementNoticeText?[[c.leaveTypeId,c.entitlementNoticeText]]:[]));
  if(draft&&options.data&&leave.data)return <LeaveRequestForm options={options.data} cards={leave.data.cards} today={leave.data.today} onSubmitted={reload} notices={notices}/>;
  return <Screen atmospheric onRefresh={reload}>
    <Muted>{t('tabLeave')}</Muted>
    <Title>{t('fieldLeaveTitle')}</Title>
    <LoadState loading={leave.loading} hasData={leave.data!=null} error={leave.error} onRetry={leave.reload}/>
    <SectionLabel>{t('homeYourLeave')}</SectionLabel>
    <View>{leave.data?.cards.map(c => <View key={c.leaveTypeId}
      accessible accessibilityLabel={`${c.leaveType}. ${fmtDays(cardFigure(c))}. ${c.takenOnly ? t('taken') : c.isCurrentCycle ? t('canApplyFor') : t('balance')}`}
      style={{ minHeight: 48, paddingVertical: 10, borderBottomWidth: 1, borderColor: palette.border, gap: 3 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 12 }}>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600', flexGrow: 1, flexShrink: 1 }}>{c.leaveType}</Text>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{fmtDays(cardFigure(c))}</Text>
      </View>
      <Text style={{ color: palette.muted, fontSize: 13 }}>{[c.takenOnly ? t('taken') : c.isCurrentCycle ? t('canApplyFor') : t('balance'), c.sharedPool ? t('sharedPool') : null].filter(Boolean).join(' · ')}</Text>
    </View>)}</View>
    {leave.data?.cards.length===0&&<Muted>{t('noLeaveTypes')}</Muted>}
    <LoadState loading={options.loading} hasData={options.data!=null} error={options.error} onRetry={options.reload}/>
    {options.data&&leave.data&&<LeaveRequestForm options={options.data} cards={leave.data.cards} today={leave.data.today} onSubmitted={reload} notices={notices}/>}
    <SectionLabel>{t('requestHistory')}</SectionLabel>
    <LoadState loading={requests.loading} hasData={requests.data!=null} error={requests.error} onRetry={requests.reload}/>
    {/* M07: each row opens its detail (mobile/app/leave/[id].tsx); the full paged list is one tap away. */}
    <View>{requests.data?.items.map(r=><Pressable key={r.id} accessibilityRole="button" accessibilityLabel={`${r.type}. ${r.from} → ${r.to}`} onPress={()=>router.push({pathname:'/leave/[id]',params:{id:r.id}})} style={{minHeight:56}}><Material style={{paddingVertical:16,gap:8}}>
      <View style={{flexDirection:'row',justifyContent:'space-between',gap:12}}><Text style={{color:palette.text,fontSize:16,fontWeight:'600',flexShrink:1}}>{r.type}</Text><StatusPill label={STATUS[r.status]?t(STATUS[r.status]):r.status}/></View>
      <Muted>{r.from} → {r.to}{r.partial?` · ${t('partialDecision')}`:''}</Muted>
    </Material></Pressable>)}</View>
    {requests.data?.items.length===0&&<Muted>{t('noRequests')}</Muted>}
    {requests.data&&requests.data.items.length>0&&<ListRow label={t('seeAllRequests')} value={requests.data.total>requests.data.items.length?t('historyCount',{n:requests.data.items.length,total:requests.data.total}):null} onPress={()=>router.push('/leave/history')}/>}
  </Screen>;
}
