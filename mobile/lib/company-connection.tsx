import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Directory, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import { router, SplashScreen } from 'expo-router';
import { signOut } from './auth';
import { applyCompanyConnection, runtimeConnections } from './config';
import { verifyCompanyProfile } from './company-profile';
import { createConnectionState } from './connection-state';
import { appLocale } from './i18n';
import { Button, colors } from './ui';
import trust from '../connections/trust.json';
import catalogue from '../connections/profiles.json';
import { isWorkplaceSetupLink, readWorkplaceSetupLink } from '../../lib/mobile-workplace-setup';

const copy = {
  en: { title:'Connect to your company', body:'Open your workplace setup link, or import the setup file provided by your administrator.', organization:'Organization code', setupLink:'Paste setup link', reviewLink:'Review setup link', cloud:'Cloud', private:'On-premise', import:'Import company setup', use:'Use this company', change:'Change company', cancel:'Back', server:'HR server', identity:'Sign-in service', review:'Check your company connection', switch:'Changing company signs you out and clears editable drafts and local device registration. Pending submissions stay encrypted for the original company and account. Go back to review them before continuing.', loading:'Preparing company connection…', error:'Company setup could not be completed. Import a current setup file or try again.', retry:'Try again', signInUnavailable:'Unable to verify company sign-in. It may not be activated yet, or your company network/VPN may be unavailable. Contact your administrator.', expired:'This company setup could not be verified. Ask your administrator for a current setup file.', choose:'Choose another company', test:'Test build · use synthetic employee data', vpn:'A private server may require your company Wi-Fi or VPN.' },
  ms: { title:'Sambung ke syarikat anda', body:'Buka pautan persediaan tempat kerja, atau import fail persediaan daripada pentadbir anda.', organization:'Kod organisasi', setupLink:'Tampal pautan persediaan', reviewLink:'Semak pautan persediaan', cloud:'Awan', private:'Di premis', import:'Import persediaan syarikat', use:'Gunakan syarikat ini', change:'Tukar syarikat', cancel:'Kembali', server:'Pelayan HR', identity:'Perkhidmatan log masuk', review:'Semak sambungan syarikat', switch:'Menukar syarikat melog anda keluar dan memadam draf boleh sunting serta pendaftaran peranti tempatan. Penghantaran tertunda kekal disulitkan untuk syarikat dan akaun asal. Kembali untuk menyemaknya sebelum teruskan.', loading:'Menyediakan sambungan syarikat…', error:'Persediaan syarikat tidak dapat diselesaikan. Import fail semasa atau cuba lagi.', retry:'Cuba lagi', signInUnavailable:'Log masuk syarikat tidak dapat disahkan. Ia mungkin belum diaktifkan, atau rangkaian/VPN syarikat tidak tersedia. Hubungi pentadbir anda.', expired:'Persediaan syarikat ini tidak dapat disahkan. Minta fail persediaan semasa daripada pentadbir anda.', choose:'Pilih syarikat lain', test:'Binaan ujian · gunakan data pekerja rekaan', vpn:'Pelayan persendirian mungkin memerlukan Wi-Fi syarikat atau VPN.' },
};
export function companyCopy() { return copy[appLocale()]; }
type Controller = ReturnType<typeof createConnectionState>;
const Context = createContext<Controller | null>(null);
type IncomingSetup = { id: number; raw: string | null };
const IntentContext = createContext<{ incoming: IncomingSetup | null; dismiss(id: number): void } | null>(null);
export function useCompanyConnection() {
  const controller = useContext(Context);
  const snapshot = useSyncExternalStore(controller?.subscribe ?? (()=>()=>{}),controller?.getSnapshot ?? (()=>null),controller?.getSnapshot ?? (()=>null));
  return snapshot?.selection?.profile ?? null;
}
function RuntimeCompanyProvider({children}:{children:ReactNode}) {
  const [incoming, setIncoming] = useState<IncomingSetup | null>(null);
  const [intentReady, setIntentReady] = useState(false);
  const [workspaceMounted, setWorkspaceMounted] = useState(false);
  const intentGeneration = useRef(0);
  const [controller] = useState(()=>createConnectionState({
    async read() { const f=new File(Paths.document,'aihr-company-v1.json'); return f.exists?f.text():null; },
    async write(raw) { new File(Paths.document,'aihr-company-v1.json').write(raw); },
    verify: raw=>verifyCompanyProfile(raw,trust), clearSession:signOut,
    async clearFiles() { for(const name of ['aihr-journeys','ImagePicker','ImageManipulator','DocumentPicker']) {const d=new Directory(Paths.cache,name);if(d.exists)d.delete();} },
    apply:applyCompanyConnection,
  }));
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  useEffect(()=>{
    let active = true;
    function receive(url: string) {
      if (!active || !isWorkplaceSetupLink(url)) return;
      const id = ++intentGeneration.current;
      try {
        const raw = readWorkplaceSetupLink(url);
        // Parsing a URL is not approval. Verify the signature with the installed app's trust anchors.
        const profile = verifyCompanyProfile(raw, trust);
        if (!profile.organization) throw new Error('Missing organization.');
        setIncoming({ id, raw });
      } catch { setIncoming({ id, raw: null }); }
    }
    const listener = Linking.addEventListener('url', event => receive(event.url));
    const initialGeneration = intentGeneration.current;
    void Promise.all([controller.initialize(), Linking.getInitialURL()]).then(([,url])=>{
      if (active && url && initialGeneration === intentGeneration.current) receive(url);
      if (url && isWorkplaceSetupLink(url)) Linking.clearInitialURL();
    }).catch(()=>{}).finally(()=>{ if (active) setIntentReady(true); });
    return ()=>{ active = false; listener.remove(); };
  },[controller]);
  // First-launch enrollment precedes the session navigator; don't leave it behind the native splash.
  useEffect(()=>{if(intentReady&&(state.status==='ready'||state.status==='error'))void SplashScreen.hideAsync();},[intentReady,state.status]);
  useEffect(()=>{if(intentReady&&state.status==='ready'&&state.selection&&!incoming)setWorkspaceMounted(true);},[intentReady,state.status,state.selection,incoming]);
  const c=companyCopy();
  const review = incoming ? <CompanySetup key={incoming.id} incoming={incoming} failed={!incoming.raw}/> : null;
  return <Context.Provider value={controller}><IntentContext.Provider value={{incoming,dismiss(id){setIncoming(current=>current?.id===id?null:current);}}}>
    {!intentReady||state.status==='loading'||state.status==='switching'?<SafeAreaView style={styles.center}><ActivityIndicator accessibilityLabel={c.loading}/><Text>{c.loading}</Text></SafeAreaView>:
      state.status==='ready'&&state.selection&&(!incoming||workspaceMounted)?<View key={state.generation} style={styles.fill}>{children}</View>:
      review??<CompanySetup failed={state.status==='error'}/>}
  </IntentContext.Provider></Context.Provider>;
}
export function CompanyConnectionProvider({children}:{children:ReactNode}) { return runtimeConnections?<RuntimeCompanyProvider>{children}</RuntimeCompanyProvider>:children; }
/** Place inside session/draft providers: close private screens while retaining their in-memory drafts. */
export function WorkplaceReviewBoundary({children}:{children:ReactNode}) {
  const intent=useContext(IntentContext);
  return intent?.incoming?<CompanySetup key={intent.incoming.id} incoming={intent.incoming} failed={!intent.incoming.raw}/>:children;
}
export function CompanySetup({failed=false,incoming=null}:{failed?:boolean;incoming?:IncomingSetup|null}) {
  const controller=useContext(Context),c=companyCopy();
  const intent=useContext(IntentContext);
  const [candidate,setCandidate]=useState<string|null>(incoming?.raw??null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [setupLink,setSetupLink]=useState('');
  useEffect(()=>{
    if(!candidate&&!incoming)return;
    const listener=BackHandler.addEventListener('hardwareBackPress',()=>{
      if(busy)return true;
      if(incoming){intent?.dismiss(incoming.id);router.replace('/');}else setCandidate(null);
      return true;
    });
    return()=>listener.remove();
  },[candidate,busy,incoming?.id,intent]);
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
    try{await controller.select(candidate);if(incoming)intent?.dismiss(incoming.id);}catch{setError(c.error);}finally{setBusy(false);}
  }
  function reviewLink() {
    try {
      const raw=readWorkplaceSetupLink(setupLink.trim());
      verifyCompanyProfile(raw,trust);setCandidate(raw);setSetupLink('');setError('');
    } catch { setError(c.expired); }
  }
  function cancel() {
    if(incoming){intent?.dismiss(incoming.id);router.replace('/');}
    else router.back();
  }
  return <SafeAreaView style={styles.fill}><ScrollView contentContainerStyle={styles.wrap}>
    <Text style={styles.brand}>AI HR</Text><Text style={styles.title}>{profile?c.review:c.title}</Text>
    <Text style={styles.body}>{profile?c.switch:c.body}</Text>
    {profile?<View style={styles.card}><Text style={styles.company}>{profile.name}</Text><Text style={styles.hosting}>{profile.hosting==='cloud'?c.cloud:c.private}</Text><Text style={styles.label}>{c.server}</Text><Text selectable style={styles.address}>{profile.apiOrigin}</Text>{profile.organization&&<><Text style={styles.label}>{c.organization}</Text><Text selectable style={styles.address}>{profile.organization}</Text></>}<Text style={styles.body}>{c.vpn}</Text></View>:
      catalogue.map((item,index)=>{let p;try{p=verifyCompanyProfile(JSON.stringify(item),trust);}catch{return null;}return <Button key={p.id} title={p.name+' · '+new URL(p.apiOrigin).hostname} onPress={()=>setCandidate(JSON.stringify(catalogue[index]))} disabled={busy} kind="quiet"/>;})}
    {(error||(failed&&!profile))&&<Text selectable accessibilityRole="alert" style={styles.error}>{error||c.error}</Text>}
    {profile?<><Button title={c.use} onPress={()=>void choose()} disabled={busy}/><Button title={c.choose} kind="quiet" disabled={busy} onPress={()=>setCandidate(null)}/></>:<>
      <Text style={styles.label}>{c.setupLink}</Text><TextInput accessibilityLabel={c.setupLink} value={setupLink} onChangeText={setSetupLink} autoCapitalize="none" autoCorrect={false} keyboardType="url" autoComplete="off" maxLength={24000} style={styles.linkInput} editable={!busy}/>
      <Button title={c.reviewLink} kind="quiet" disabled={busy||!setupLink.trim()} onPress={reviewLink}/>
      <Button title={c.import} onPress={()=>void importFile()} disabled={busy}/>
    </>}
    {(incoming||controller?.getSnapshot().selection)&&!busy&&<Button title={c.cancel} kind="quiet" onPress={cancel}/>}
    <Text style={styles.note}>{c.test}</Text>
  </ScrollView></SafeAreaView>;
}
const styles=StyleSheet.create({fill:{flex:1,backgroundColor:colors.bg},center:{flex:1,alignItems:'center',justifyContent:'center',gap:12,backgroundColor:colors.bg},wrap:{padding:24,paddingTop:48,gap:18,flexGrow:1},brand:{color:colors.accent,fontSize:15,fontWeight:'700'},title:{fontSize:30,fontWeight:'700',color:colors.text},body:{fontSize:16,lineHeight:24,color:colors.muted},card:{backgroundColor:colors.card,padding:20,borderRadius:12,gap:12,borderColor:colors.border,borderWidth:1},company:{fontSize:21,fontWeight:'600',color:colors.text},hosting:{fontSize:14,color:colors.accent},label:{fontSize:13,fontWeight:'600',color:colors.muted},address:{fontSize:15,color:colors.text},linkInput:{minHeight:48,borderWidth:1,borderColor:colors.border,borderRadius:10,padding:12,color:colors.text,backgroundColor:colors.card},error:{color:colors.danger,fontSize:15},note:{fontSize:13,color:colors.muted,marginTop:20}});
