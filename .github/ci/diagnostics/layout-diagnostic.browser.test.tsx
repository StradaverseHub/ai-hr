/** DRAFT, explicitly a replica probe; never release PASS or actual authenticated-app evidence. */
import {afterEach,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import {page} from 'vitest/browser';
import {render,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import '../app/globals.css';
vi.mock('@/app/auth-actions',()=>({logoutAction:async()=>{}}));
vi.mock('@/app/ui-theme-actions',()=>({setUiTheme:async()=>({ok:true})}));
const {UserMenu}=await import('../components/user-menu');
// Generator inserts EXACT exported class declarations from original test; hash/provenance retained.
/* CLASS_DECLARATIONS */
/* MONOLITH_SHELL */
const styleSnapshot=(el:Element|null)=>{
 if(!el)return null;const s=getComputedStyle(el),r=el.getBoundingClientRect();
 return {tag:el.tagName,class:el.getAttribute('class'),text:el.textContent,width:r.width,height:r.height,x:r.x,right:r.right,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,display:s.display,gap:s.gap,gridTemplateColumns:s.gridTemplateColumns,flexShrink:s.flexShrink,minWidth:s.minWidth,maxWidth:s.maxWidth,padding:s.padding};
};
function Shell(){return <div className={SHELL_BODY_CLS}><div className={SHELL_ROW_CLS}><div className={`${RAIL_WIDTH_CLS} ${RAIL_VISIBILITY_CLS} ${RAIL_DEFAULT_BREAKPOINT_CLS}`}/><div className={SHELL_COL_CLS}><header data-testid="topbar" className={HEADER_CLS}><div className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground"><span className="shrink-0 font-medium text-foreground/80">Demo Group</span></div><div className="flex min-w-0 items-center justify-center"><span className="inline-flex h-11 w-auto min-w-0 items-center max-sm:min-w-11 gap-2 rounded-md border border-input bg-card px-3 text-sm sm:w-full"/></div><div data-testid="right-cluster" className={RIGHT_CLUSTER_CLS}><div className={DIVIDER_CLS}/><span className={ICON_CLS}/><span className={ICON_CLS}/><span className={ICON_CLS}/><UserMenu name="Aisyah Rahman" employeeCode="EMP-0001" employed/></div></header></div></div></div>;}
afterEach(()=>{cleanup();delete document.documentElement.dataset.uiTheme;document.documentElement.style.removeProperty('--font-schibsted');document.documentElement.style.removeProperty('--font-jakarta');document.documentElement.style.removeProperty('--font-geist-mono');document.documentElement.style.removeProperty('--font-dm-mono');document.documentElement.classList.remove('aihr-diagnostic-built-fonts');document.getElementById('aihr-diagnostic-font-vars')?.remove();});
for(const variant of ['original-classic-missing-font-vars','original-classic-with-tracked-Schibsted-proxy','original-classic-geometry-monolith-font-theme','original-monolith-geometry-tracked-font-theme','original-classic-actual-built-fonts','original-monolith-actual-built-fonts'])for(const width of [1280,1440])it(`DIAGNOSTIC ${variant} ${width}`,async()=>{
 await page.viewport(width,900);document.body.style.margin='0';
 if(variant!=='original-classic-missing-font-vars'){
  const face=new FontFace('AIHRDiagnosticSchibsted',`url(${new URL('../app/fonts/schibsted-grotesk/SchibstedGrotesk-Variable.ttf',import.meta.url).href})`,{weight:'400 600',style:'normal'});await face.load();document.fonts.add(face);
  document.documentElement.style.setProperty('--font-schibsted','AIHRDiagnosticSchibsted');
  if(variant.includes('actual-built-fonts')){
   const assets=[['AIHRDiagnosticJakarta',new URL('./diagnostic-fonts/fba5a26ea33df6a3-s.18rizl4rsrl42.woff2',import.meta.url).href,'200 800'],['AIHRDiagnosticGeist',new URL('./diagnostic-fonts/797e433ab948586e-s.0r6juujl39pe6.woff2',import.meta.url).href,'100 900'],['AIHRDiagnosticDMMono',new URL('./diagnostic-fonts/36363bfb06833f56-s.p.38hmww4cj4vme.woff2',import.meta.url).href,'400'],['AIHRDiagnosticDMMono',new URL('./diagnostic-fonts/a73419dd2ba2d841-s.p.2yee423r7ahpo.woff2',import.meta.url).href,'500']];
   for(const [family,url,weight] of assets){const built=new FontFace(family,`url(${url})`,{weight,style:'normal'});await built.load();document.fonts.add(built);}
   // Match next/font variable-class specificity so the app's Monolith selector can override Jakarta.
   const variables=document.createElement('style');variables.id='aihr-diagnostic-font-vars';variables.textContent='.aihr-diagnostic-built-fonts{--font-jakarta:AIHRDiagnosticJakarta;--font-geist-mono:AIHRDiagnosticGeist;--font-dm-mono:AIHRDiagnosticDMMono}';document.head.append(variables);document.documentElement.classList.add('aihr-diagnostic-built-fonts');
   if(variant.startsWith('original-monolith-'))document.documentElement.dataset.uiTheme='monolith';
  }else if(variant==='original-classic-with-tracked-Schibsted-proxy')document.documentElement.style.setProperty('--font-jakarta','AIHRDiagnosticSchibsted');
  else document.documentElement.dataset.uiTheme='monolith';
 }
 render(<NextIntlClientProvider locale="en" messages={en}>{variant.startsWith('original-monolith-')?<MonolithShell account={<UserMenu name="Aisyah Rahman" employeeCode="EMP-0001" employed/>}/>:<Shell/>}</NextIntlClientProvider>);await document.fonts.ready;
 const account=document.querySelector('[data-tour="account"]')!;const spans=[...account.querySelectorAll('span')];
 const root=getComputedStyle(document.documentElement);
 console.log('AIHR_LAYOUT_MEASUREMENT '+JSON.stringify({kind:'DIAGNOSTIC_REPLICA_ONLY',variant,width,theme:document.documentElement.dataset.uiTheme??null,fonts:{jakarta:root.getPropertyValue('--font-jakarta'),schibsted:root.getPropertyValue('--font-schibsted'),sans:root.getPropertyValue('--font-sans')},userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight},header:styleSnapshot(document.querySelector('[data-testid="topbar"]')),rightCluster:styleSnapshot(document.querySelector('[data-testid="right-cluster"]')),account:styleSnapshot(account),name:styleSnapshot(spans.find(s=>s.textContent==='Aisyah Rahman')??null),code:styleSnapshot(spans.find(s=>s.textContent==='EMP-0001')??null),avatar:styleSnapshot(account.children[0]),identity:styleSnapshot(account.children[1]),chevron:styleSnapshot(account.querySelector('svg'))}));
 await page.screenshot({save:true,path:`layout-${variant}-${width}.png`});
});
