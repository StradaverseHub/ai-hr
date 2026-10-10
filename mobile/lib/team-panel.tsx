import { useCallback,useEffect,useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable,View } from 'react-native';
import { DesignText as Text } from './design';
import { useApi } from './api';
import { useSession } from './session';
import { useTenantDesign } from './design';
import { t } from './i18n';
import { LoadState,Muted } from './ui';
export function TeamPanel({refreshToken=0}:{refreshToken?:number}={}){
  const {signOut}=useSession(),{palette}=useTenantDesign();
  const team=useApi('team',{},signOut);const [expanded,setExpanded]=useState(false);
  useFocusEffect(useCallback(()=>{team.reload();},[team.reload]));
  useEffect(()=>{if(refreshToken)team.reload();},[refreshToken,team.reload]);
  const sessions:Record<string,string>={full_day:t('fullDay'),AM:t('halfAM'),PM:t('halfPM'),hourly:t('hourly')};
  const people=team.data?.items??[];
  const away=people.filter(p=>p.dates.some(d=>d.date===team.data?.today&&d.status==='approved'));
  if(team.data&&!team.data.enabled)return null;
  return <View style={{gap:12,borderTopWidth:1,borderColor:palette.border,paddingTop:20}}>
    <Text style={{color:palette.text,fontSize:21,fontWeight:'600'}}>{t('teamAvailability')}</Text>
    <LoadState loading={team.loading&&!team.data} error={team.error} onRetry={team.reload}/>
    {team.data&&<>
      <Pressable accessibilityRole="button" accessibilityState={{expanded}} onPress={()=>setExpanded(!expanded)} style={{minHeight:60,flexDirection:'row',alignItems:'center',gap:12}}>
        <View style={{flexDirection:'row',maxWidth:140}}>{away.slice(0,3).map(p=><View key={p.employmentId} style={{width:36,height:36,borderRadius:18,marginRight:-6,backgroundColor:palette.card,borderWidth:1,borderColor:palette.border,alignItems:'center',justifyContent:'center'}}><Text style={{color:palette.text}}>{p.name.split(/\s+/).map(v=>v[0]).slice(0,2).join('')}</Text></View>)}</View>
        <Text style={{color:palette.text,fontSize:16,flex:1}}>{t('awayToday',{n:away.length,total:people.length})}</Text><Text style={{color:palette.accent,fontSize:22}}>{expanded?'−':'+'}</Text>
      </Pressable>
      {expanded&&<View style={{gap:16}}>{people.map(p=><View key={p.employmentId} style={{borderBottomWidth:1,borderColor:palette.border,paddingBottom:12,gap:6}}><Text style={{color:palette.text,fontSize:16,fontWeight:'600'}}>{p.name}</Text>{p.dates.length?p.dates.map((d,i)=><Muted key={`${d.date}-${d.session}-${i}`}>{d.date} · {d.status==='approved'?t('approved'):t('pending')}{sessions[d.session]?` · ${sessions[d.session]}`:''}</Muted>):<Muted>{t('noScheduledLeave')}</Muted>}</View>)}{!people.length&&<Muted>{t('noTeamMembers')}</Muted>}</View>}
      <Muted>{t('teamAccessNotice')}</Muted>
    </>}
  </View>;
}
