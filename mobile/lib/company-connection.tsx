import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Directory, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import { router, SplashScreen } from 'expo-router';
import { signOut } from './auth';
import { applyCompanyConnection, runtimeConnections } from './config';
import { CompanySetupError, verifyCompanyProfile } from './company-profile';
import { createConnectionState } from './connection-state';
import { appLocale, intlLocale } from './i18n';
import type { AppLocaleCode } from './preferences';
import { company as zhCompany } from './locales/zh';
import { company as taCompany } from './locales/ta';
import { company as thCompany } from './locales/th';
import { company as viCompany } from './locales/vi';
import { Button, colors } from './ui';
import trust from '../connections/trust.json';
import catalogue from '../connections/profiles.json';
import { isWorkplaceSetupLink, readWorkplaceSetupLink, workplaceSetupLinkPayload, WorkplaceSetupLinkError } from '../../lib/mobile-workplace-setup';

const enCopy = { title:'Connect to your company', body:'Open your workplace setup link, or import the setup file provided by your administrator.', organization:'Organization code', setupLink:'Paste setup link', reviewLink:'Review setup link', cloud:'Cloud', private:'On-premise', import:'Import company setup', use:'Use this company', change:'Change company', cancel:'Back', server:'HR server', identity:'Sign-in service', review:'Check your company connection', switch:'Changing company signs you out and clears editable drafts and local device registration. Pending submissions stay encrypted for the original company and account. Go back to review them before continuing.', loading:'Preparing company connection…', error:'Company setup could not be completed. Import a current setup file or try again.', retry:'Try again', signInUnavailable:'Unable to verify company sign-in. It may not be activated yet, or your company network/VPN may be unavailable. Contact your administrator.', choose:'Choose another company', test:'Test build · use synthetic employee data', vpn:'A private server may require your company Wi-Fi or VPN.', problem:{ invalid_link:'This is not a complete workplace setup link. Copy the whole link from your administrator and try again.', not_setup:'This is not a workplace setup link or setup file.', too_large:'This file is too large to be a workplace setup file.', untrusted:'This setup was signed with a key this app does not trust. Ask your administrator for a setup made for this app.', bad_signature:'This setup does not match its signature. It may have been changed or damaged. Ask your administrator for a new copy.', expired:'This setup expired on {date}. Ask your administrator for a current one.', not_yet_valid:'This setup is valid from {date}. Check that the date and time on this phone are correct.', invalid:'This setup contains company details this app cannot use. Ask your administrator for a current setup.', wrong_server:'This setup link names a different server from the one that sent it. Ask your administrator for a new link.', missing_organization:'This setup link has no organization code. Ask your administrator for a current link.', unreadable:'The selected file could not be read. Choose it again.' } };
/** The connection screens' copy, one shape for every language (./locales holds Chinese, Tamil, Thai and Vietnamese). */
export type CompanyCopy = typeof enCopy;
const copy: Record<AppLocaleCode, CompanyCopy> = {
  en: enCopy,
  ms: { title:'Sambung ke syarikat anda', body:'Buka pautan persediaan tempat kerja, atau import fail persediaan daripada pentadbir anda.', organization:'Kod organisasi', setupLink:'Tampal pautan persediaan', reviewLink:'Semak pautan persediaan', cloud:'Awan', private:'Di premis', import:'Import persediaan syarikat', use:'Gunakan syarikat ini', change:'Tukar syarikat', cancel:'Kembali', server:'Pelayan HR', identity:'Perkhidmatan log masuk', review:'Semak sambungan syarikat', switch:'Menukar syarikat melog anda keluar dan memadam draf boleh sunting serta pendaftaran peranti tempatan. Penghantaran tertunda kekal disulitkan untuk syarikat dan akaun asal. Kembali untuk menyemaknya sebelum teruskan.', loading:'Menyediakan sambungan syarikat…', error:'Persediaan syarikat tidak dapat diselesaikan. Import fail semasa atau cuba lagi.', retry:'Cuba lagi', signInUnavailable:'Log masuk syarikat tidak dapat disahkan. Ia mungkin belum diaktifkan, atau rangkaian/VPN syarikat tidak tersedia. Hubungi pentadbir anda.', choose:'Pilih syarikat lain', test:'Binaan ujian · gunakan data pekerja rekaan', vpn:'Pelayan persendirian mungkin memerlukan Wi-Fi syarikat atau VPN.', problem:{ invalid_link:'Ini bukan pautan persediaan tempat kerja yang lengkap. Salin keseluruhan pautan daripada pentadbir anda dan cuba lagi.', not_setup:'Ini bukan pautan atau fail persediaan tempat kerja.', too_large:'Fail ini terlalu besar untuk menjadi fail persediaan tempat kerja.', untrusted:'Persediaan ini ditandatangani dengan kunci yang tidak dipercayai oleh aplikasi ini. Minta persediaan yang dibuat untuk aplikasi ini daripada pentadbir anda.', bad_signature:'Persediaan ini tidak sepadan dengan tandatangannya. Ia mungkin telah diubah atau rosak. Minta salinan baharu daripada pentadbir anda.', expired:'Persediaan ini tamat tempoh pada {date}. Minta persediaan semasa daripada pentadbir anda.', not_yet_valid:'Persediaan ini sah mulai {date}. Pastikan tarikh dan masa pada telefon ini betul.', invalid:'Persediaan ini mengandungi butiran syarikat yang tidak dapat digunakan oleh aplikasi ini. Minta persediaan semasa daripada pentadbir anda.', wrong_server:'Pautan persediaan ini menamakan pelayan yang berbeza daripada pelayan yang menghantarnya. Minta pautan baharu daripada pentadbir anda.', missing_organization:'Pautan persediaan ini tiada kod organisasi. Minta pautan semasa daripada pentadbir anda.', unreadable:'Fail yang dipilih tidak dapat dibaca. Pilih semula.' } },
  zh: zhCompany, ta: taCompany, th: thCompany, vi: viCompany,
};
export function companyCopy() { return copy[appLocale()]; }
type SetupProblem = keyof typeof copy.en.problem;
type Refusal = { problem: SetupProblem; at?: number };
/** The reason a setup was refused, in the person's language: never only "could not be verified". */
export function setupRefusalText(refusal: Refusal): string {
  const text = companyCopy().problem[refusal.problem];
  if (refusal.at == null) return text;
  let date: string;
  try { date = new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(refusal.at * 1000)); }
  catch { date = new Date(refusal.at * 1000).toISOString(); }
  return text.replace('{date}', date);
}
function refusalOf(error: unknown): Refusal {
  if (error instanceof CompanySetupError) return { problem: error.problem, at: error.at };
  if (error instanceof WorkplaceSetupLinkError) return { problem: error.problem };
  return { problem: 'invalid' };
}
/**
 * A pasted or opened setup: a link, or the signed setup text itself (what company.aihr.json contains). The signature is
 * checked with this app's own trust anchors FIRST, so the reason given is the real one; then the link's own rules
 * (organization code, the server it came from). Returns the signed text, or why it was refused.
 */
export function checkWorkplaceSetup(text: string, requireLink = false): { raw: string } | Refusal {
  const value = text.replace(/^\uFEFF/, '').trim();
  try {
    if (!requireLink && value.startsWith('{')) { verifyCompanyProfile(value, trust); return { raw: value }; }
    const raw = workplaceSetupLinkPayload(value);
    // A cut-off link still decodes, to text that is not a setup: that is an incomplete link, not a bad file.
    try { verifyCompanyProfile(raw, trust); }
    catch (error) { throw error instanceof CompanySetupError && error.problem === 'not_setup' ? new WorkplaceSetupLinkError('invalid_link', error.message) : error; }
    readWorkplaceSetupLink(value);
    return { raw };
  } catch (error) { return refusalOf(error); }
}
type Controller = ReturnType<typeof createConnectionState>;
const Context = createContext<Controller | null>(null);
type IncomingSetup = { id: number; raw: string | null; refusal?: Refusal };
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
      // Parsing a link is not approval: checkWorkplaceSetup verifies the signature with the installed trust anchors.
      const checked = checkWorkplaceSetup(url, true);
      setIncoming('raw' in checked ? { id, raw: checked.raw } : { id, raw: null, refusal: checked });
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
  const [candidate,setCandidate]=useState<string|null>(incoming?.raw??null),[error,setError]=useState(incoming?.refusal?setupRefusalText(incoming.refusal):''),[busy,setBusy]=useState(false);
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
      let raw:string;
      try {
        if((file.size??0)>16384){setError(setupRefusalText({problem:'too_large'}));return;}
        try{raw=await file.text();}catch{setError(setupRefusalText({problem:'unreadable'}));return;}
      } finally{try{if(file.exists)file.delete();}catch{/* the picker's cache copy; the sweep removes it */}}
      const checked=checkWorkplaceSetup(raw);
      if('raw' in checked)setCandidate(checked.raw);else setError(setupRefusalText(checked));
    }catch{setError(setupRefusalText({problem:'unreadable'}));}finally{setBusy(false);}
  }
  async function choose() {
    if(!controller||!candidate||busy)return;
    setBusy(true);setError('');
    try{await controller.select(candidate);if(incoming)intent?.dismiss(incoming.id);}catch{setError(c.error);}finally{setBusy(false);}
  }
  function reviewLink() {
    const checked=checkWorkplaceSetup(setupLink);
    if('raw' in checked){setCandidate(checked.raw);setSetupLink('');setError('');}
    else setError(setupRefusalText(checked));
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
