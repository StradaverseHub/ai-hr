/** CI-only visual evidence from the real rendered components and fictional data owners. */
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {brotliDecompressSync} from 'node:zlib';
import {chromium} from 'playwright';
let css:Promise<string>|undefined;
async function applicationCss(){
 css??=(async()=>{
  const load=createRequire(join(process.cwd(),'package.json'));
  const plugin=load('@tailwindcss/postcss');
  const postcss=createRequire(load.resolve('@tailwindcss/postcss'))('postcss');
  const result=await postcss([plugin({base:process.cwd()})]).process(readFileSync('app/globals.css','utf8'),{from:join(process.cwd(),'app/globals.css')});
  const jakarta=readFileSync('test/fixtures/topbar-fonts/jakarta-latin.woff2').toString('base64');
  const mono=readFileSync('test/fixtures/topbar-fonts/geist-mono-latin.woff2').toString('base64');
  return result.css+`\n@font-face{font-family:ReviewJakarta;src:url(data:font/woff2;base64,${jakarta}) format('woff2');font-weight:100 900;font-style:normal;font-display:block;}@font-face{font-family:ReviewMono;src:url(data:font/woff2;base64,${mono}) format('woff2');font-weight:100 900;font-style:normal;font-display:block;}:root{--font-jakarta:ReviewJakarta;--font-geist-mono:ReviewMono;}`;
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
export async function captureAiReviewScreenshots(html:string,locale:string,section:'overview'|'queue'|'probe'|'scheduled-group'|'scheduled-company'|'build-list'|'pay-rule'|'delegation-replacement'|'inventory-group'|'inventory-company'|'runs-paged'|'followup-features'|`chat-card-${string}`,fixture='real components; fictional data owners; no authenticated server journey'){
 const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
 if(!evidence)return;
 if(process.env.GITHUB_ACTIONS!=='true')throw Error('Visual capture requires the selected GitHub Actions runner.');
 const executable='/usr/bin/google-chrome';
 if(!existsSync(executable))throw Error('The hosted runner Chrome executable is unavailable; no visual evidence claimed.');
 const out=join(evidence,'ui-screenshots');mkdirSync(out,{recursive:true});
 const styles=await applicationCss(),browser=await chromium.launch({executablePath:executable,headless:true});
 const rows=[];
 try{for(const [device,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  await page.route('**/*',route=>route.abort());
  await page.route(FONT_ORIGIN+'*',route=>{const font=SCRIPT_FONTS.find(row=>route.request().url()===FONT_ORIGIN+row.file);return font?route.fulfill({status:200,contentType:font.type,headers:{'Access-Control-Allow-Origin':'*'},body:scriptFont(font.file)}):route.abort();});
  await page.setContent(`<!doctype html><html lang="${locale}" data-ui-theme="classic"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body class="bg-background text-foreground p-4 font-sans">${html}</body></html>`);
  await page.addStyleTag({content:styles+scriptFontCss});
  // Load every declared face before capture (lazy faces would otherwise still be pending), then settle.
  await page.evaluate(async()=>{await Promise.allSettled(Array.from(document.fonts as unknown as Iterable<FontFace>).map(face=>face.load()));await document.fonts.ready;});
  const missingScript=await page.evaluate(families=>Array.from(document.fonts as unknown as Iterable<FontFace>).filter(face=>families.includes(face.family.replace(/^['"]|['"]$/g,''))&&face.status!=='loaded').map(face=>`${face.family} ${face.weight}`),[...new Set<string>(SCRIPT_FONTS.map(font=>font.family))]);
  if(missingScript.length)throw Error('Script fonts did not load: '+missingScript.join(', '));
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
  // Calendar consent requires both values visible without horizontal panning. Page overflow alone
  // misses a clipped comparison cell inside a scrolling holder (observed in the Tamil fixture).
  const clippedCalendarCells=section==='chat-card-rewards-calendar'?await page.evaluate(()=>Array.from(document.querySelectorAll('table td')).some(cell=>{const box=cell.getBoundingClientRect();return box.left<0||box.right>window.innerWidth+1||cell.scrollWidth>cell.clientWidth+1;})):false;
  const file=`${locale}-${section}-${device}.png`;await page.screenshot({path:join(out,file),fullPage:true});
  rows.push({locale,section,device,width,height,overflow,file,browser:browser.version(),candidate:process.env.AIHR_CI_HEAD,runId:process.env.GITHUB_RUN_ID,theme:'classic',fixture,...(section==='chat-card-rewards-calendar'?{cellsVisible:!clippedCalendarCells}:{})});
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
