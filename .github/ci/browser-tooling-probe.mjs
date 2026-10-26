/** Native dependency smoke probe only; never an application or release gate. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_WORKFLOW==='browser-provisioning-diagnostics','Disposable browser tooling diagnostic only');
const [engine,directory]=process.argv.slice(2);assert(['chromium','firefox','webkit'].includes(engine));
assert(directory.startsWith(process.env.RUNNER_TEMP+'/'));
const require=createRequire(join(process.cwd(),'package.json')),playwright=require('playwright');
const began=Date.now();let browser;
try{
 browser=await playwright[engine].launch({headless:true});const page=await browser.newPage({viewport:{width:800,height:600}});
 await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><html><body><p style="font:24px sans-serif">AIHR tooling 日本語 中文 ไทย العربية</p></body></html>');
 assert((await page.locator('p').textContent()).includes('AIHR tooling'));
 const png=await page.screenshot();assert(png.length>1000);writeFileSync(join(directory,'native-tooling.png'),png,{flag:'wx'});
 writeFileSync(join(directory,'native-tooling.json'),JSON.stringify({kind:'NATIVE_BROWSER_TOOLING_PROBE_NOT_APPLICATION_TEST_OR_RELEASE',engine,version:browser.version(),elapsedMs:Date.now()-began,screenshotBytes:png.length,releaseAuthorized:false},null,2)+'\n',{flag:'wx'});
}finally{await browser?.close();}
