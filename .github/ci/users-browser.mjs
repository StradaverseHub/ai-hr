// Real Next production pages, server actions and internal authentication. No staging access.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {request} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(process.platform,'linux');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),process.env.AIHR_CI_HEAD);
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'');
const out=join(process.env.RUNNER_TEMP,'users-browser-evidence'),priv=join(process.env.RUNNER_TEMP,'users-private');
mkdirSync(out);mkdirSync(priv,{mode:0o700});
const root=resolve('.'),req=createRequire(join(root,'package.json'));
const origin='https://localhost:3187',target='ai_hr_users_browser';
const env={...process.env,NODE_ENV:'production',AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:origin,
 AUTH_SESSION_KEY:randomBytes(32).toString('hex'),AUTH_DEFAULT_ORGANIZATION:'walkthrough',ALLOW_DEMO_SESSION:'false',
 DATABASE_URL:`postgres://ai_hr_app@127.0.0.1:5433/${target}`,MIGRATION_DATABASE_URL:`postgres://postgres@127.0.0.1:5433/${target}`,
 TEST_DATABASE_URL:`postgres://ai_hr_app@127.0.0.1:5433/${target}`,TEST_MIGRATION_DATABASE_URL:`postgres://postgres@127.0.0.1:5433/${target}`,
 USERS_PRIVATE_FIXTURE:join(priv,'fixture.json'),NEXT_TELEMETRY_DISABLED:'1'};
const pgEnv={...process.env,AIHR_CI_UNIT:'db-1'};
const pg=fileURLToPath(new URL('./postgres.sh',import.meta.url));
const container=`aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-db-1`;
const report={kind:'REAL_USERS_PAGE_DEVELOPMENT_ONLY',releaseEligible:false,sha:env.AIHR_CI_HEAD,controller:env.AIHR_CI_CONTROL_HEAD,phases:[],browserErrors:[],consoleErrors:[],exitCode:1};
let browser,app,proxy,logFd,page;
function run(label,bin,args,vars=env){const r=spawnSync(bin,args,{env:vars,encoding:'utf8',timeout:900000,maxBuffer:32*1024**2});writeFileSync(join(out,label+'.log'),(r.stdout??'')+(r.stderr??''));assert.equal(r.status,0,label);report.phases.push(label);}
function query(q){return execFileSync('docker',['exec',container,'psql','-U','postgres','-p','5433','-d',target,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}).trim();}
try{
 const build={...env,NODE_OPTIONS:'--max-old-space-size=6144'};
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])build[key]='postgres://nobody:nothing@127.0.0.1:1/no_database';
 run('build','pnpm',['build'],build);
 run('postgres','bash',[pg,'reset'],pgEnv);
 run('new-database','docker',['exec',container,'psql','-U','postgres','-p','5433','-v','ON_ERROR_STOP=1','-c',`CREATE DATABASE ${target} OWNER ai_hr_app;`],pgEnv);
 run('fixture',process.execPath,['--import','tsx',fileURLToPath(new URL('./users-fixture.mjs',import.meta.url))],{...env,NODE_ENV:'development'});
 const fixture=JSON.parse(readFileSync(env.USERS_PRIVATE_FIXTURE,'utf8'));
 const before=query('select count(*) from employment');
 run('certificate','openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(priv,'key.pem'),'-out',join(priv,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
 logFd=openSync(join(out,'next.log'),'w');
 app=spawn('pnpm',['exec','next','start','-H','127.0.0.1','-p','3186'],{env,stdio:['ignore',logFd,logFd],detached:true});
 for(let i=0;i<90;i++){try{await fetch('http://127.0.0.1:3186/health');break;}catch{await sleep(1000);}}
 proxy=createServer({key:readFileSync(join(priv,'key.pem')),cert:readFileSync(join(priv,'cert.pem'))},(incoming,response)=>{
  const upstream=request({hostname:'127.0.0.1',port:3186,path:incoming.url,method:incoming.method,headers:{...incoming.headers,host:'localhost:3187','x-forwarded-host':'localhost:3187','x-forwarded-proto':'https'}},r=>{response.writeHead(r.statusCode,r.headers);r.pipe(response);});
  upstream.on('error',()=>{response.writeHead(502);response.end();});incoming.pipe(upstream);
 });
 await new Promise(r=>proxy.listen(3187,'127.0.0.1',r));
 const {chromium}=req('playwright');browser=await chromium.launch({channel:'chrome'});report.browserChannel='chrome';report.browserVersion=browser.version();
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1100}});
 await context.addCookies([{name:'__Host-aihr_internal',value:fixture.session,url:origin,secure:true,httpOnly:true,sameSite:'Lax'},{name:'NEXT_LOCALE',value:'en',url:origin}]);
 page=await context.newPage();page.on('pageerror',e=>report.browserErrors.push(String(e)));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});
 const messages=JSON.parse(readFileSync('messages/en.json','utf8')).admin.users;
 const main=()=>page.getByRole('main');
 const directory=()=>main().locator('[data-tour="admin-users"]:visible');
 const navigate=async()=>{const r=await page.goto(origin+'/admin/users');assert.equal(r.status(),200);(report.navigationSamples??=[]).push(await page.locator('[data-tour="admin-users"]').evaluateAll(elements=>elements.map(e=>({visible:e.getClientRects().length>0,inMain:!!e.closest('main')}))));await directory().waitFor();assert(!new URL(page.url()).searchParams.has('error'),page.url());};
 await navigate();
 await page.getByRole('dialog',{name:'Product tour'}).getByRole('button',{name:'Skip',exact:true}).click();
 report.phases.push('first-use product tour dismissed through its visible control');
 const form=main().locator('#manual-account-setup:visible form').first();
 await form.locator('[name="accountType"][value="standalone"]').check();
 await form.locator('[name="fullName"]').fill('Alexandra Consultant');await form.locator('[name="email"]').fill('alexandra@example.test');
 await form.locator('[name="username"]').fill('alexandra.consultant');await form.locator('[name="password"]').fill('Temporary consultant passphrase 2026!');
 await form.locator('[name="role"]').selectOption('hr_admin');await form.locator('[name="companyId"]').selectOption(fixture.companyId);await form.locator('[name="ownershipAttested"]').check();
 await form.getByRole('button',{name:messages.manual.create,exact:true}).click();await page.waitForURL('**/admin/users?manualSuccess=created');
 await navigate();await directory().getByRole('searchbox').fill('alexandra@example.test');
 const row=()=>directory().locator('[data-directory-row]').filter({hasText:'Alexandra Consultant'});
 await row().waitFor();assert.equal(query('select count(*) from employment'),before);assert.equal(query("select count(*) from person where primary_email='alexandra@example.test'"),'1');
 report.phases.push('manual creation saved and reopened without employment');
 await row().getByRole('button',{name:messages.directory.manage,exact:true}).click();
 let panel=main().getByRole('region',{name:messages.directory.accessFor.replace('{name}','Alexandra Consultant')});
 const addRole=panel.locator('form').filter({has:page.locator('select[name="role"]')});
 await addRole.locator('[name="role"]').selectOption('payroll_partner');await addRole.locator('[name="companyId"]').selectOption(fixture.companyId);
 await addRole.getByRole('button',{name:messages.addRole,exact:true}).click();await page.waitForLoadState('networkidle');await navigate();
 await directory().getByRole('searchbox').fill('alexandra@example.test');await row().waitFor();await row().getByText(messages.role.payroll_partner,{exact:true}).waitFor();
 report.phases.push('role saved and reopened');
 await directory().getByRole('combobox',{name:messages.directory.roleFilter,exact:true}).selectOption('payroll_partner');
 assert.equal(await row().count(),1);await directory().getByRole('combobox',{name:messages.directory.groupBy,exact:true}).selectOption('company');
 assert.equal(await directory().locator('th[scope="rowgroup"]').count(),1);report.phases.push('search role filter and company grouping');
 await row().getByRole('button',{name:messages.directory.manage,exact:true}).click();panel=main().getByRole('region',{name:messages.directory.accessFor.replace('{name}','Alexandra Consultant')});
 await panel.getByRole('button',{name:messages.archive,exact:true}).click();await page.waitForLoadState('networkidle');await navigate();
 await directory().getByRole('combobox',{name:messages.statusColumn,exact:true}).selectOption('archived');await directory().getByRole('searchbox').fill('alexandra@example.test');await row().waitFor();
 await row().getByRole('button',{name:messages.directory.manage,exact:true}).click();await main().getByRole('region',{name:messages.directory.accessFor.replace('{name}','Alexandra Consultant')}).getByRole('button',{name:messages.restore,exact:true}).click();
 await page.waitForLoadState('networkidle');await navigate();await directory().getByRole('searchbox').fill('alexandra@example.test');await row().waitFor();report.phases.push('archive and restore saved and reopened');
 const invite=main().locator('#invite-user:visible').locator('..').locator('form');
 await invite.locator('[name="accountType"][value="standalone"]').check();await invite.locator('[name="fullName"]').fill('Invited Consultant');await invite.locator('[name="email"]').fill('invitee@example.test');await invite.locator('[name="role"]').selectOption('employee');await invite.locator('[name="companyId"]').selectOption('group');await invite.getByRole('button',{name:messages.inviteSubmit,exact:true}).click();
 await page.waitForLoadState('networkidle');await navigate();await directory().getByRole('searchbox').fill('invitee@example.test');await directory().locator('[data-directory-row]').filter({hasText:'Invited Consultant'}).waitFor();
 assert.equal(query('select count(*) from employment'),before);report.phases.push('invitation saved and reopened without employment');
 await directory().getByRole('button',{name:messages.directory.clearFilters,exact:true}).click();await directory().scrollIntoViewIfNeeded();await directory().screenshot({path:join(out,'users-desktop.png'),animations:'disabled'});
 await page.setViewportSize({width:390,height:1100});await directory().scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await directory().screenshot({path:join(out,'users-mobile.png'),animations:'disabled'});
 const serverLog=readFileSync(join(out,'next.log'),'utf8');assert(!/MISSING_MESSAGE|FORMATTING_ERROR|ReferenceError:|TypeError:/.test(serverLog),'Server render errors');
 assert.deepEqual(report.browserErrors,[]);assert.deepEqual(report.consoleErrors,[]);report.exitCode=0;
}catch(error){report.error=String(error.stack??error);if(page)await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await browser?.close();await new Promise(r=>proxy?proxy.close(r):r());if(app){try{process.kill(-app.pid,'SIGTERM');}catch{}await sleep(1500);if(app.exitCode===null)try{process.kill(-app.pid,'SIGKILL');}catch{}}if(logFd!==undefined)closeSync(logFd);spawnSync('bash',[pg,'stop'],{env:pgEnv});writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
