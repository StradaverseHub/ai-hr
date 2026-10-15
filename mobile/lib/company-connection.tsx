import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Directory, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { router, SplashScreen } from 'expo-router';
import { signOut } from './auth';
import { applyCompanyConnection, runtimeConnections } from './config';
import { verifyCompanyProfile } from './company-profile';
import { createConnectionState } from './connection-state';
import { appLocale } from './i18n';
import { Button, colors } from './ui';
import trust from '../connections/trust.json';
import catalogue from '../connections/profiles.json';

const copy = {
  en: { title:'Connect to your company', body:'Choose your AI HR installation. Your company administrator can provide a setup file for a private server.', cloud:'Cloud', private:'On-premise', import:'Import company setup', use:'Use this company', change:'Change company', cancel:'Back', server:'HR server', identity:'Sign-in service', review:'Check your company connection', switch:'Changing company signs you out and clears local drafts and device registration. You will sign in again.', loading:'Preparing company connection…', error:'Company setup could not be completed. Import a current setup file or try again.', retry:'Try again', signInUnavailable:'Unable to verify company sign-in. It may not be activated yet, or your company network/VPN may be unavailable. Contact your administrator.', expired:'This company setup could not be verified. Ask your administrator for a current setup file.', choose:'Choose another company', test:'Test build · use synthetic employee data', vpn:'A private server may require your company Wi-Fi or VPN.' },
  ms: { title:'Sambung ke syarikat anda', body:'Pilih pemasangan AI HR anda. Pentadbir syarikat boleh memberikan fail persediaan untuk pelayan persendirian.', cloud:'Awan', private:'Di premis', import:'Import persediaan syarikat', use:'Gunakan syarikat ini', change:'Tukar syarikat', cancel:'Kembali', server:'Pelayan HR', identity:'Perkhidmatan log masuk', review:'Semak sambungan syarikat', switch:'Menukar syarikat melog anda keluar dan memadam draf serta pendaftaran peranti tempatan. Anda perlu log masuk semula.', loading:'Menyediakan sambungan syarikat…', error:'Persediaan syarikat tidak dapat diselesaikan. Import fail semasa atau cuba lagi.', retry:'Cuba lagi', signInUnavailable:'Log masuk syarikat tidak dapat disahkan. Ia mungkin belum diaktifkan, atau rangkaian/VPN syarikat tidak tersedia. Hubungi pentadbir anda.', expired:'Persediaan syarikat ini tidak dapat disahkan. Minta fail persediaan semasa daripada pentadbir anda.', choose:'Pilih syarikat lain', test:'Binaan ujian · gunakan data pekerja rekaan', vpn:'Pelayan persendirian mungkin memerlukan Wi-Fi syarikat atau VPN.' },
};
export function companyCopy() { return copy[appLocale()]; }
type Controller = ReturnType<typeof createConnectionState>;
const Context = createContext<Controller | null>(null);
export function useCompanyConnection() {
  const controller = useContext(Context);
  const snapshot = useSyncExternalStore(controller?.subscribe ?? (()=>()=>{}),controller?.getSnapshot ?? (()=>null),controller?.getSnapshot ?? (()=>null));
  return snapshot?.selection?.profile ?? null;
}
function RuntimeCompanyProvider({children}:{children:ReactNode}) {
  const [controller] = useState(()=>createConnectionState({
    async read() { const f=new File(Paths.document,'aihr-company-v1.json'); return f.exists?f.text():null; },
    async write(raw) { new File(Paths.document,'aihr-company-v1.json').write(raw); },
    verify: raw=>verifyCompanyProfile(raw,trust), clearSession:signOut,
    async clearFiles() { for(const name of ['aihr-journeys','ImagePicker','ImageManipulator','DocumentPicker']) {const d=new Directory(Paths.cache,name);if(d.exists)d.delete();} },
    apply:applyCompanyConnection,
  }));
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  useEffect(()=>{void controller.initialize();},[controller]);
  // First-launch enrollment precedes the session navigator; don't leave it behind the native splash.
  useEffect(()=>{if(state.status==='ready'||state.status==='error')void SplashScreen.hideAsync();},[state.status]);
  const c=companyCopy();
  return <Context.Provider value={controller}>
    {state.status==='loading'||state.status==='switching'?<SafeAreaView style={styles.center}><ActivityIndicator accessibilityLabel={c.loading}/><Text>{c.loading}</Text></SafeAreaView>:
      state.status==='error'||!state.selection?<CompanySetup failed={state.status==='error'}/>:
      <View key={state.generation} style={styles.fill}>{children}</View>}
  </Context.Provider>;
}
export function CompanyConnectionProvider({children}:{children:ReactNode}) { return runtimeConnections?<RuntimeCompanyProvider>{children}</RuntimeCompanyProvider>:children; }
export function CompanySetup({failed=false}:{failed?:boolean}) {
  const controller=useContext(Context),c=companyCopy();
  const [candidate,setCandidate]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(!candidate)return;const listener=BackHandler.addEventListener('hardwareBackPress',()=>{if(busy)return true;setCandidate(null);return true;});return()=>listener.remove();},[candidate,busy]);
  let profile:ReturnType<typeof verifyCompanyProfile>|null=null;
  try{if(candidate)profile=verifyCompanyProfile(candidate,trust);}catch{}
  async function importFile() {
    setError('');setBusy(true);
    try {
      const result=await DocumentPicker.getDocumentAsync({type:['application/json','application/octet-stream'],copyToCacheDirectory:true,multiple:false});
      if(result.canceled)return;
      const file=new File(result.assets[0].uri);
      try {if(file.size>16384)throw new Error(c.error);const raw=await file.text();verifyCompanyProfile(raw,trust);setCandidate(raw);}
      finally{if(file.exists)file.delete();}
    }catch{setError(c.expired);}finally{setBusy(false);}
  }
  async function choose() {
    if(!controller||!candidate||busy)return;
    setBusy(true);setError('');
    try{await controller.select(candidate);}catch{setError(c.error);}finally{setBusy(false);}
  }
  return <SafeAreaView style={styles.fill}><ScrollView contentContainerStyle={styles.wrap}>
    <Text style={styles.brand}>AI HR</Text><Text style={styles.title}>{profile?c.review:c.title}</Text>
    <Text style={styles.body}>{profile?c.switch:c.body}</Text>
    {profile?<View style={styles.card}><Text style={styles.company}>{profile.name}</Text><Text style={styles.hosting}>{profile.hosting==='cloud'?c.cloud:c.private}</Text><Text style={styles.label}>{c.server}</Text><Text selectable style={styles.address}>{profile.apiOrigin}</Text><Text style={styles.label}>{c.identity}</Text><Text selectable style={styles.address}>{new URL(profile.issuer).origin}</Text><Text style={styles.body}>{c.vpn}</Text></View>:
      catalogue.map((item,index)=>{let p;try{p=verifyCompanyProfile(JSON.stringify(item),trust);}catch{return null;}return <Button key={p.id} title={p.name+' · '+new URL(p.apiOrigin).hostname} onPress={()=>setCandidate(JSON.stringify(catalogue[index]))} disabled={busy} kind="quiet"/>;})}
    {(failed||error)&&<Text selectable accessibilityRole="alert" style={styles.error}>{error||c.error}</Text>}
    {profile?<><Button title={c.use} onPress={()=>void choose()} disabled={busy}/><Button title={c.choose} kind="quiet" disabled={busy} onPress={()=>setCandidate(null)}/></>:<Button title={c.import} onPress={()=>void importFile()} disabled={busy}/>}
    {controller?.getSnapshot().selection&&!failed&&!profile&&<Button title={c.cancel} kind="quiet" onPress={()=>router.back()}/>}
    <Text style={styles.note}>{c.test}</Text>
  </ScrollView></SafeAreaView>;
}
const styles=StyleSheet.create({fill:{flex:1,backgroundColor:colors.bg},center:{flex:1,alignItems:'center',justifyContent:'center',gap:12,backgroundColor:colors.bg},wrap:{padding:24,paddingTop:48,gap:18,flexGrow:1},brand:{color:colors.accent,fontSize:15,fontWeight:'700'},title:{fontSize:30,fontWeight:'700',color:colors.text},body:{fontSize:16,lineHeight:24,color:colors.muted},card:{backgroundColor:colors.card,padding:20,borderRadius:12,gap:12,borderColor:colors.border,borderWidth:1},company:{fontSize:21,fontWeight:'600',color:colors.text},hosting:{fontSize:14,color:colors.accent},label:{fontSize:13,fontWeight:'600',color:colors.muted},address:{fontSize:15,color:colors.text},error:{color:colors.danger,fontSize:15},note:{fontSize:13,color:colors.muted,marginTop:20}});
