/** CI-only visual evidence from the real rendered components and fictional data owners. */
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {brotliDecompressSync} from 'node:zlib';
import {chromium} from 'playwright';
import {orgChartConnectorPath,type OrgChartEdge} from '../../lib/org-chart-model';
let css:Promise<string>|undefined;
async function applicationCss(){
 css??=(async()=>{
  const load=createRequire(join(process.cwd(),'package.json'));
  const plugin=load('@tailwindcss/postcss');
  const postcss=createRequire(load.resolve('@tailwindcss/postcss'))('postcss');
  const result=await postcss([plugin({base:process.cwd()})]).process(readFileSync('app/globals.css','utf8'),{from:join(process.cwd(),'app/globals.css')});
  const jakarta=readFileSync('test/fixtures/topbar-fonts/jakarta-latin.woff2').toString('base64');
  const mono=readFileSync('test/fixtures/topbar-fonts/geist-mono-latin.woff2').toString('base64');
  // Match the actual layout's four font variables: Monolith re-points the first two to these faces.
  const schibsted=readFileSync('app/fonts/schibsted-grotesk/SchibstedGrotesk-Variable.ttf').toString('base64');
  const dm400=readFileSync('test/fixtures/topbar-fonts/dm-mono-latin-400.woff2').toString('base64');
  const dm500=readFileSync('test/fixtures/topbar-fonts/dm-mono-latin-500.woff2').toString('base64');
  return result.css+'\n'+readFileSync('app/atelier.css','utf8')+`\n@font-face{font-family:ReviewJakarta;src:url(data:font/woff2;base64,${jakarta}) format('woff2');font-weight:100 900;font-style:normal;font-display:block;}@font-face{font-family:ReviewMono;src:url(data:font/woff2;base64,${mono}) format('woff2');font-weight:100 900;font-style:normal;font-display:block;}@font-face{font-family:ReviewSchibsted;src:url(data:font/ttf;base64,${schibsted}) format('truetype');font-weight:400 600;font-style:normal;font-display:block;}@font-face{font-family:ReviewDMMono;src:url(data:font/woff2;base64,${dm400}) format('woff2');font-weight:400;font-style:normal;font-display:block;}@font-face{font-family:ReviewDMMono;src:url(data:font/woff2;base64,${dm500}) format('woff2');font-weight:500;font-style:normal;font-display:block;}:root{--font-jakarta:ReviewJakarta;--font-geist-mono:ReviewMono;--font-schibsted:ReviewSchibsted;--font-dm-mono:ReviewDMMono;}`;
 })();return css;
}
/** The repository's own shipped script fonts (assets/fonts, OFL), served under the exact family names that
 * app/globals.css's --font-sans fallback stack names. The runner does not always have CJK, Thai or Tamil
 * fonts installed, and without them those locales render as missing-glyph boxes. Served through a route, so
 * no network request leaves the page. */
const SCRIPT_FONTS=[
 {family:'Noto Sans SC',file:'NotoSansSC-Regular.otf.br',type:'font/otf',format:'opentype',weight:'400'},
 {family:'Noto Sans Thai',file:'NotoSansThai-Regular.ttf.br',type:'font/ttf',format:'truetype',weight:'400'},
 {family:'Noto Sans Thai',file:'NotoSansThai-Bold.ttf.br',type:'font/ttf',format:'truetype',weight:'700'},
 {family:'Noto Sans Tamil',file:'NotoSansTamil-Regular.ttf.br',type:'font/ttf',format:'truetype',weight:'400'},
 {family:'Noto Sans Tamil',file:'NotoSansTamil-Bold.ttf.br',type:'font/ttf',format:'truetype',weight:'700'},
] as const;
const FONT_ORIGIN='https://review-fonts.invalid/';
const scriptFontCss=SCRIPT_FONTS.map(font=>`@font-face{font-family:'${font.family}';src:url(${FONT_ORIGIN}${font.file}) format('${font.format}');font-weight:${font.weight};font-style:normal;font-display:block;}`).join('');
const fontBytes=new Map<string,Buffer>();
function scriptFont(file:string):Buffer{let bytes=fontBytes.get(file);if(!bytes){bytes=brotliDecompressSync(readFileSync(join('assets/fonts',file)));fontBytes.set(file,bytes);}return bytes;}
export async function captureAiReviewScreenshots(html:string,locale:string,section:'organisation-tagging'|'overview'|'queue'|'probe'|'scheduled-group'|'scheduled-company'|'runner-controls'|'runner-controls-dark'|'build-list'|'pay-rule'|'security-overview'|'security-create'|'security-invite'|'security-functions'|'security-users'|'security-permissions'|'security-password-policy'|'security-password-policy-enabled'|`security-flyout-${string}`|'probation-tracker'|'formula-generator'|'formula-write'|'formula-conditions'|'formula-personnel-library'|'formula-personnel-registry'|'feedback-board'|'feedback-capped'|'feedback-unloaded'|'messenger'|'formula-pay-item'|'formula-trace'|'org-chart-controls'|'payroll-history-detail'|'payslip-itemized-preview'|'formula-help-examples'|'formula-sample-test'|'formula-checks'|'delegation-replacement'|'inventory-group'|'inventory-company'|'runs-paged'|'followup-features'|'people-configuration-navigation'|'lifecycle-case-onboarding'|'lifecycle-case-offboarding'|`chat-card-${string}`|`ai-centre-${string}`,fixture='real components; fictional data owners; no authenticated server journey',theme:'classic'|'atelier'|'monolith'='classic',colorMode:'light'|'dark'='light'){
 const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
 if(!evidence)return;
 if(process.env.GITHUB_ACTIONS!=='true')throw Error('Visual capture requires the selected GitHub Actions runner.');
 const executable='/usr/bin/google-chrome';
 if(!existsSync(executable))throw Error('The hosted runner Chrome executable is unavailable; no visual evidence claimed.');
 const out=join(evidence,'ui-screenshots');mkdirSync(out,{recursive:true});
 const styles=(await applicationCss())+((section.startsWith('lifecycle-case-')||section==='probation-tracker')?'\n'+readFileSync('app/onboarding-workspace.css','utf8')+'\n'+readFileSync('app/lifecycle/v9/workspace.css','utf8')+(section==='probation-tracker'?'\n'+readFileSync('app/lifecycle/probation/probation.css','utf8'):''):''),browser=await chromium.launch({executablePath:executable,headless:true});
 const rows=[];
 try{for(const [device,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  await page.route('**/*',route=>route.abort());
  await page.route(FONT_ORIGIN+'*',route=>{const font=SCRIPT_FONTS.find(row=>route.request().url()===FONT_ORIGIN+row.file);return font?route.fulfill({status:200,contentType:font.type,headers:{'Access-Control-Allow-Origin':'*'},body:scriptFont(font.file)}):route.abort();});
  await page.setContent(`<!doctype html><html lang="${locale}" data-ui-theme="${theme}" class="${colorMode==='dark'?'dark':''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body hidden class="bg-background text-foreground p-4 font-sans"><main class="relative min-w-0">${html}</main></body></html>`);
  await page.addStyleTag({content:styles+scriptFontCss});
  // Load every script face before any localized text is laid out (the body stays hidden until then). Shaped
  // while its face is still loading, a short label becomes .notdef glyphs of the primary font; when that primary
  // is a system font (Atelier: Arial -> Liberation Sans) Chromium caches the run per primary font and reuses it
  // after the face arrives, so document.fonts.ready alone cannot repair it.
  const unloaded=await page.evaluate(async faces=>{void getComputedStyle(document.documentElement).fontFamily;const lists=await Promise.all(faces.map(face=>document.fonts.load(face)));return faces.filter((_,i)=>!lists[i].length||lists[i].some(face=>face.status!=='loaded'));},SCRIPT_FONTS.map(font=>`${font.weight} 16px "${font.family}"`));
  if(unloaded.length)throw Error('Script fonts did not load before layout: '+unloaded.join(', '));
  await page.evaluate(()=>{document.body.hidden=false;return document.fonts.ready;});
  let chartGeometry:unknown=null;
  if(section==='org-chart-controls'){
   // React's layout effect has already rendered the real edge population in jsdom. Re-measure those
   // SAME cards after Chromium loads the application fonts, using the live chart's pure path owner.
   const measured=await page.evaluate(()=>{const tree=document.querySelector<HTMLElement>('[data-org-tree]');if(!tree)throw Error('Actual OrgChart tree is missing');const base=tree.getBoundingClientRect();const scale=Number(tree.style.transform.match(/scale\(([^)]+)\)/)?.[1]??1);const nodes=Array.from(tree.querySelectorAll<HTMLElement>('[data-org-node]')).map(node=>{const rect=node.getBoundingClientRect();return {id:node.dataset.orgNode!,pos:{cx:(rect.left-base.left+rect.width/2)/scale,cy:(rect.top-base.top+rect.height/2)/scale,t:(rect.top-base.top)/scale,b:(rect.bottom-base.top)/scale,l:(rect.left-base.left)/scale,r:(rect.right-base.left)/scale}};});const edges=Array.from(tree.querySelectorAll<SVGPathElement>('path[data-org-manager]')).map((edge,index)=>({index,manager:edge.dataset.orgManager!,subordinate:edge.dataset.orgSubordinate!,type:edge.dataset.orgType!}));return {nodes,edges,width:tree.scrollWidth,height:tree.scrollHeight,horizontal:tree.dataset.orgHorizontal==='true',scale};});
   const paths=measured.edges.map(edge=>{const manager=measured.nodes.find(node=>node.id===edge.manager),subordinate=measured.nodes.find(node=>node.id===edge.subordinate);if(!manager||!subordinate)throw Error('A rendered chart connector lost its visible card');return {index:edge.index,d:orgChartConnectorPath(manager.pos,subordinate.pos,edge.type as OrgChartEdge['type'],measured.horizontal)};});
   await page.evaluate(({paths,width,height,scale})=>{const tree=document.querySelector<HTMLElement>('[data-org-tree]')!,svg=tree.querySelector<SVGElement>('[data-org-connectors]')!,wrapper=tree.parentElement!;svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));wrapper.style.width=width*scale+'px';wrapper.style.height=height*scale+'px';const edges=tree.querySelectorAll<SVGPathElement>('path[data-org-manager]');for(const path of paths)edges[path.index].setAttribute('d',path.d);},{paths,width:measured.width,height:measured.height,scale:measured.scale});
   if(measured.nodes.length<3||paths.length<2||!measured.nodes.every(node=>node.pos.r>node.pos.l&&node.pos.b>node.pos.t))throw Error('Org chart evidence needs nonempty actual card and connector geometry');
   chartGeometry={cards:measured.nodes.length,connectors:paths.length,width:measured.width,height:measured.height,owner:'orgChartConnectorPath over actual Chromium card bounds'};
  }
  // Inspect an actual localized text node, not merely an available/loaded font face. This catches
  // computed-value invalidation that silently drops the entire script fallback chain.
  const script=locale==='ta'?'Tamil':locale==='th'?'Thai':locale==='zh'?'CJK':null;
  let scriptFontProof:unknown=null;
  if(script){
   const textProof=await page.evaluate(({locale,theme})=>{
    const pattern=locale==='ta'?/[\u0b80-\u0bff]/:locale==='th'?/[\u0e00-\u0e7f]/:/[\u3400-\u9fff]/;
    const node=Array.from(document.body.querySelectorAll<HTMLElement>('*')).find(el=>el.getBoundingClientRect().width>0&&Array.from(el.childNodes).some(child=>child.nodeType===Node.TEXT_NODE&&pattern.test(child.textContent??'')));
    if(!node)throw Error('No actual localized script label to verify.');
    node.setAttribute('data-review-script-font-probe','');
    const root=getComputedStyle(document.documentElement);
    if(theme==='monolith'&&(!root.getPropertyValue('--font-schibsted').trim()||!root.getPropertyValue('--font-dm-mono').trim()))throw Error('Monolith layout font variables are missing.');
    return {fontFamily:getComputedStyle(node).fontFamily,bodyFontFamily:getComputedStyle(document.body).fontFamily};
   },{locale,theme});
   const cdp=await page.context().newCDPSession(page);
   try{
    await cdp.send('DOM.enable');await cdp.send('CSS.enable');
    const {root}=await cdp.send('DOM.getDocument');
    const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'[data-review-script-font-probe]'});
    const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});
    const family=script==='Tamil'?/Tamil/i:script==='Thai'?/Thai/i:/(?:Sans.*(?:SC|CJK)|CJK.*SC)/i;
    if(!fonts.some(font=>font.glyphCount>0&&family.test(font.familyName)))throw Error('Actual localized text did not use its script font: '+JSON.stringify(fonts));
    scriptFontProof={script,...textProof,fonts};
   }finally{await cdp.detach();}
   await page.locator('[data-review-script-font-probe]').evaluate(node=>node.removeAttribute('data-review-script-font-probe'));
  }
  const trackerGeometry=section==='probation-tracker'&&device==='mobile'?await page.evaluate(()=>{
   const rows=Array.from(document.querySelectorAll('.probation-list-table tbody tr'));
   const overlaps=rows.flatMap(row=>Array.from(row.querySelectorAll('td')).map(cell=>cell.getBoundingClientRect())).some((rect,index,rects)=>index>0&&rect.top<rects[index-1].bottom-1);
   if(overlaps)throw Error('Mobile Probation case fields overlap.');
   return{caseFieldsDoNotOverlap:true};
  }):null;
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
  const scrollRegions=await page.locator('[data-function-access-scroll]').evaluateAll(nodes=>nodes.map(node=>({width:node.clientWidth,content:node.scrollWidth,scrollable:getComputedStyle(node).overflowX==='auto'})));
  if(width===390&&scrollRegions.some(region=>!region.scrollable||region.width>=region.content))throw Error('The wide function guide must remain horizontally scrollable on a phone.');
  const clippedCalendarCells=section==='chat-card-rewards-calendar'?await page.evaluate(()=>Array.from(document.querySelectorAll('table td')).some(cell=>{const box=cell.getBoundingClientRect();return box.left<0||box.right>window.innerWidth+1||cell.scrollWidth>cell.clientWidth+1;})):false;
  if(section==='people-configuration-navigation')await page.locator('a[href="/admin/settings/system-labels"]').scrollIntoViewIfNeeded();
  const file=`${locale}-${section}-${device}.png`;await page.screenshot({path:join(out,file),fullPage:true});
  if(section==='security-functions')await page.screenshot({path:join(out,`${locale}-${section}-${device}-viewport.png`),fullPage:false});
  rows.push({locale,section,device,width,height,overflow,file,browser:browser.version(),candidate:process.env.AIHR_CI_HEAD,runId:process.env.GITHUB_RUN_ID,theme,scrollRegions,fixture,scriptFontProof,chartGeometry,trackerGeometry,...(section==='chat-card-rewards-calendar'?{cellsVisible:!clippedCalendarCells}:{})});
  if(clippedCalendarCells)throw Error('Calendar before/after value is clipped; inspect the captured evidence.');
  // This existing table intentionally scrolls horizontally on small screens. Capture its action
  // column too, so the mobile evidence shows the real controls rather than only the left-hand labels.
  if(section==='followup-features'&&device==='mobile'){
   await page.evaluate(()=>{const holder=document.querySelector('table')?.parentElement;if(holder)holder.scrollLeft=holder.scrollWidth;});
   const controls=`${locale}-${section}-mobile-controls.png`;await page.screenshot({path:join(out,controls),fullPage:true});
   rows.push({locale,section,device:'mobile-controls',width,height,overflow,file:controls,browser:browser.version(),candidate:process.env.AIHR_CI_HEAD,runId:process.env.GITHUB_RUN_ID,theme:'classic',fixture});
  }
  await page.close();
 }}finally{await browser.close();}
 writeFileSync(join(out,`${locale}-${section}.json`),JSON.stringify(rows,null,2)+'\n');
 if(rows.some(row=>row.overflow))throw Error('Rendered fixture overflows its viewport; inspect the captured evidence.');
}

/** Serialize live form properties as attributes before an inert browser rendering. innerHTML alone
 * drops a controlled select's current selection and a checkbox's reviewed state. */
export function aiReviewDomHtml(element:HTMLElement):string{
 const clone=element.cloneNode(true) as HTMLElement;
 const inputs=clone.querySelectorAll('input');
 element.querySelectorAll('input').forEach((source,index)=>{
  const target=inputs[index];target.setAttribute('value',source.value);
  if(source.checked)target.setAttribute('checked','');else target.removeAttribute('checked');
 });
 const selects=clone.querySelectorAll('select');
 element.querySelectorAll('select').forEach((source,index)=>{
  [...source.options].forEach((option,i)=>{const target=selects[index].options[i];
   if(option.selected)target.setAttribute('selected','');else target.removeAttribute('selected');
  });
 });
 const textareas=clone.querySelectorAll('textarea');
 element.querySelectorAll('textarea').forEach((source,index)=>{textareas[index].textContent=source.value;});
 return clone.innerHTML;
}
