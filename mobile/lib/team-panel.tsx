import { useCallback,useEffect,useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable,View } from 'react-native';
import { DesignText as Text } from './design';
import { useApiV2 } from './api';
import { useSession } from './session';
import { useTenantDesign } from './design';
import { t } from './i18n';
import { Button,LoadState,Muted } from './ui';
import { TeamAvailabilityV2,addCalendarDays,TEAM_WINDOW_DEFAULT_DAYS } from '../../lib/mobile-api/v2/team';
/**
 * Who's away (M13, D14): the v2 team window with week navigation. Membership, dates, sessions and approved-vs-pending
 * are the server's (My Team's own scope); the app only chooses which week to ask for. `from` undefined = this week,
 * anchored on the server's today. No leave type or reason is ever received.
 */
/** `compact` (Home): only the away-today row, which expands; week navigation and the scope note stay on the Team screen. */
export function TeamPanel({refreshToken=0,compact=false,hideTitle=false}:{refreshToken?:number;compact?:boolean;hideTitle?:boolean}={}){
  const {signOut}=useSession(),{palette}=useTenantDesign();
  const [from,setFrom]=useState<string|undefined>(undefined);
  const team=useApiV2('v2/team/availability',TeamAvailabilityV2,{from,to:from?addCalendarDays(from,TEAM_WINDOW_DEFAULT_DAYS-1):undefined},signOut);
  const [expanded,setExpanded]=useState(false);
  useFocusEffect(useCallback(()=>{team.reload();},[team.reload]));
  useEffect(()=>{if(refreshToken)team.reload();},[refreshToken,team.reload]);
  const sessions:Record<string,string>={full_day:t('fullDay'),AM:t('halfAM'),PM:t('halfPM'),hourly:t('hourly')};
  const data=team.data;
  const people=data?.items??[];
  const today=data?.today;
  const withinWindow=!!data&&!!today&&data.from<=today&&today<=data.to;
  const away=people.filter(p=>p.dates.some(d=>d.status==='approved'&&(withinWindow?d.date===today:true)));
  const shift=(weeks:number)=>{if(!data)return;const next=addCalendarDays(data.from,7*weeks);setFrom(next===data.today?undefined:next);};
  if(data&&!data.enabled)return null;
  return <View style={compact?{gap:8}:{gap:12,borderTopWidth:1,borderColor:palette.border,paddingTop:20}}>
    {!hideTitle&&<Text style={{color:palette.text,fontSize:compact?17:21,fontWeight:'600'}}>{t('teamAvailability')}</Text>}
    {!compact&&<View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
      <Button title={t('teamPrevWeek')} kind="quiet" disabled={!data} onPress={()=>shift(-1)}/>
      {/* The default window is the server's today and the six days after it (lib/mobile-api/v2/team.ts), not a calendar
          week: the company's week start is not known to the app, so the label says what the window is. */}
      <Button title={t('teamNext7Days')} kind={from===undefined?'primary':'quiet'} selected={from===undefined} onPress={()=>setFrom(undefined)}/>
      <Button title={t('teamNextWeek')} kind="quiet" disabled={!data} onPress={()=>shift(1)}/>
    </View>}
    {data&&!compact&&<Muted>{t('teamWindow',{from:data.from,to:data.to})}</Muted>}
    <LoadState loading={team.loading} hasData={data!=null} error={team.error} onRetry={team.reload}/>
    {data&&<>
      <Pressable accessibilityRole="button" accessibilityState={{expanded}} onPress={()=>setExpanded(!expanded)} style={{minHeight:60,flexDirection:'row',alignItems:'center',gap:12}}>
        <View style={{flexDirection:'row',maxWidth:140}}>{away.slice(0,3).map(p=><View key={p.employmentId} style={{width:36,height:36,borderRadius:18,marginRight:-6,backgroundColor:palette.card,borderWidth:1,borderColor:palette.border,alignItems:'center',justifyContent:'center'}}><Text style={{color:palette.text}}>{p.name.split(/\s+/).map(v=>v[0]).slice(0,2).join('')}</Text></View>)}</View>
        <Text style={{color:palette.text,fontSize:16,flex:1}}>{withinWindow?t('awayToday',{n:away.length,total:data.memberCount}):t('teamAwayInWindow',{n:away.length,total:data.memberCount})}</Text><Text style={{color:palette.accent,fontSize:22}}>{expanded?'−':'+'}</Text>
      </Pressable>
      {expanded&&<View style={{gap:16}}>{people.map(p=><View key={p.employmentId} style={{borderBottomWidth:1,borderColor:palette.border,paddingBottom:12,gap:6}}><Text style={{color:palette.text,fontSize:16,fontWeight:'600'}}>{p.name}</Text>{p.dates.length?p.dates.map((d,i)=><Muted key={`${d.date}-${d.session}-${i}`}>{d.date} · {d.status==='approved'?t('approved'):t('pending')}{sessions[d.session]?` · ${sessions[d.session]}`:''}</Muted>):<Muted>{t('teamNoLeaveInWindow')}</Muted>}</View>)}{!people.length&&<Muted>{t('noTeamMembers')}</Muted>}</View>}
      {data.truncated&&<Muted>{t('teamTruncated',{shown:people.length,total:data.memberCount})}</Muted>}
      {!compact&&<Muted>{t('teamAccessNotice')}</Muted>}
    </>}
  </View>;
}
