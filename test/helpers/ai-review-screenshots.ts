/** CI-only visual evidence from the real rendered components and fictional data owners. */
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
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
  return result.css+'\n'+readFileSync('app/atelier.css','utf8')+`\n@font-face{font-family:ReviewJakarta;src:url(data:font/woff2;base64,${jakarta}) format('woff2');font-weight:100 900;font-style:normal;font-display:block;}@font-face{font-family:ReviewMono;src:url(data:font/woff2;base64,${mono}) format('woff2');font-weight:100 900;font-style:normal;font-display:block;}:root{--font-jakarta:ReviewJakarta;--font-geist-mono:ReviewMono;}`;
 })();return css;
}
export async function captureAiReviewScreenshots(html:string,locale:string,section:'overview'|'queue'|'probe'|'scheduled-group'|'scheduled-company'|'build-list'|'pay-rule'|'security-overview'|'security-create'|'security-invite'|'security-functions'|'security-users'|'security-permissions'|'formula-write'|'formula-conditions'|'formula-pay-item'|'formula-trace',fixture='real components; fictional data owners; no authenticated server journey',theme:'classic'|'atelier'|'monolith'='classic'){
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
  await page.setContent(`<!doctype html><html lang="${locale}" data-ui-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body class="bg-background text-foreground p-4 font-sans"><main class="relative min-w-0">${html}</main></body></html>`);
  await page.addStyleTag({content:styles});await page.evaluate(()=>document.fonts.ready);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
  const scrollRegions=await page.locator('[data-function-access-scroll]').evaluateAll(nodes=>nodes.map(node=>({width:node.clientWidth,content:node.scrollWidth,scrollable:getComputedStyle(node).overflowX==='auto'})));
  if(width===390&&scrollRegions.some(region=>!region.scrollable||region.width>=region.content))throw Error('The wide function guide must remain horizontally scrollable on a phone.');
  const file=`${locale}-${section}-${device}.png`;await page.screenshot({path:join(out,file),fullPage:true});
  if(section==='security-functions')await page.screenshot({path:join(out,`${locale}-${section}-${device}-viewport.png`),fullPage:false});
  rows.push({locale,section,device,width,height,overflow,file,browser:browser.version(),candidate:process.env.AIHR_CI_HEAD,runId:process.env.GITHUB_RUN_ID,theme,scrollRegions,fixture});
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
