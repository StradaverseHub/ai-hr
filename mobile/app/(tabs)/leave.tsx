/** Requests keep every eligible leave balance visible, including masked values and shared pools. */
import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable,View } from 'react-native';
import { DesignText as Text } from '../../lib/design';
import { randomUUID } from 'expo-crypto';
import { useTenantDesign } from '../../lib/design';
import { useApi } from '../../lib/api';
import { useJourneyDrafts,removeLocalFile } from '../../lib/journey-drafts';
import { LeaveRequestForm } from '../../lib/leave-request-form';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { LoadState,Muted,Screen,Title,fmtDays } from '../../lib/ui';
export default function Leave(){
  const {palette,design}=useTenantDesign();const {signOut,employmentId}=useSession();
  const leave=useApi('leave',{employmentId:employmentId??undefined},signOut);
  const options=useApi('leave-options',{employmentId:employmentId??undefined},signOut);
  const requests=useApi('leave-requests',{employmentId:employmentId??undefined},signOut);
  const {leave:draft,putLeave}=useJourneyDrafts();
  const reload=useCallback(()=>{leave.reload();options.reload();requests.reload();},[leave.reload,options.reload,requests.reload]);
  useFocusEffect(reload);
  const blocked=draft?.phase==='submitting'||draft?.phase==='previewing'||draft?.phase==='uncertain';
  return <Screen onRefresh={reload}>
    <Title>{t('tabRequests')}</Title>
    <Text style={{color:palette.text,fontSize:21,fontWeight:'600'}}>{t('availableLeave')}</Text>
    <LoadState loading={leave.loading&&!leave.data} error={leave.error} onRetry={leave.reload}/>
    <View style={{flexDirection:design.leaveLayout==='ledger'?'row':'column',flexWrap:'wrap',gap:12}}>
      {leave.data?.cards.map(c=><Pressable key={c.leaveTypeId} accessibilityRole="button" accessibilityLabel={`${c.leaveType}. ${fmtDays(c.takenOnly?c.taken:c.isCurrentCycle?c.canApplyFor:c.balance)}`} accessibilityState={{disabled:!!blocked||!options.data?.items.some(o=>o.id===c.leaveTypeId),selected:draft?.command.leaveTypeId===c.leaveTypeId}} disabled={!!blocked||!options.data?.items.some(o=>o.id===c.leaveTypeId)} onPress={()=>{removeLocalFile(draft?.document);putLeave({phase:'edit',command:{requestId:randomUUID(),leaveTypeId:c.leaveTypeId,startDate:leave.data!.today,endDate:leave.data!.today,durationType:'full_day'}});}} style={{width:design.leaveLayout==='ledger'?'47%':'100%',paddingVertical:14,borderBottomWidth:draft?.command.leaveTypeId===c.leaveTypeId?2:1,borderColor:draft?.command.leaveTypeId===c.leaveTypeId?palette.accent:palette.border,gap:6}}>
        <Text style={{color:palette.text,fontSize:16,fontWeight:'600'}}>{c.leaveType}</Text><Text style={{color:palette.accent,fontSize:26,fontWeight:'600',fontVariant:['tabular-nums']}}>{fmtDays(c.takenOnly?c.taken:c.isCurrentCycle?c.canApplyFor:c.balance)}</Text><Muted>{c.takenOnly?t('taken'):c.isCurrentCycle?t('canApplyFor'):t('balance')}</Muted>{c.sharedPool&&<Muted>{t('sharedPool')}</Muted>}
      </Pressable>)}
    </View>
    {leave.data?.cards.length===0&&<Muted>{t('noLeaveTypes')}</Muted>}
    <LoadState loading={options.loading&&!options.data} error={options.error} onRetry={options.reload}/>
    {options.data&&leave.data&&<LeaveRequestForm options={options.data} today={leave.data.today} onSubmitted={reload}/>}
    <View style={{gap:14,marginTop:22,borderTopWidth:1,borderColor:palette.border,paddingTop:20}}>
      <Text style={{color:palette.text,fontSize:21,fontWeight:'600'}}>{t('requestHistory')}</Text>
      <LoadState loading={requests.loading&&!requests.data} error={requests.error} onRetry={requests.reload}/>
      {requests.data?.items.map(r=><View key={r.id} style={{paddingVertical:14,borderBottomWidth:1,borderColor:palette.border,gap:6}}><Text style={{color:palette.text,fontSize:17,fontWeight:'600'}}>{r.type}</Text><Muted>{r.from} → {r.to}</Muted><Text style={{color:palette.accent}}>{r.status==='approved'?t('approved'):r.status==='pending'?t('pending'):r.status==='rejected'?t('rejected'):r.status==='cancelled'?t('cancelled'):r.status}</Text>{r.partial&&<Muted>{t('partialDecision')}</Muted>}</View>)}
      {requests.data?.items.length===0&&<Muted>{t('noRequests')}</Muted>}
      {requests.data&&<Muted>{t('historyCount',{n:requests.data.items.length,total:requests.data.total})}</Muted>}
    </View>
  </Screen>;
}
