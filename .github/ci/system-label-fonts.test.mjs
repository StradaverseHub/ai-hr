/** Pure prerequisite selection and actual workflow wiring; no application or package installation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {systemLabelFontsRequired} from './system-label-fonts.mjs';
import {bootstrapFixedNoto,assertFixedNotoRunner,configureFixedNotoTransport,ubuntuFontTransportDiagnostic,decodeUbuntuSourceBytes} from './fixed-noto-bootstrap.mjs';

const consumer='test/system-label-exchange-browser.test.ts',other='test/plain.test.ts';
const expected={candidate:'a'.repeat(40),controller:'c'.repeat(40)};
function fixture(){return {sha:expected.candidate,controller:expected.controller,suite:[consumer,other],units:[
 {id:'db-selected',kind:'db',files:[consumer]},
 {id:'nodb-other',kind:'nodb',files:[other]},
]};}
test('only the exact complete unit containing System Labels needs the fonts',()=>{
 const plan=fixture();assert.equal(systemLabelFontsRequired(plan,'db-selected',expected),true);
 assert.equal(systemLabelFontsRequired(plan,'nodb-other',expected),false);
 assert.equal(systemLabelFontsRequired({...plan,units:[{id:'nodb-selected',kind:'nodb',files:[other,consumer]}]},'nodb-selected',expected),true);
});
test('a related name, unit id or different file never selects fonts',()=>{
 for(const file of ['test/system-label-exchange-browser-extra.test.ts','test/system-label-exchange-browser.test.tsx','test/other.test.ts']){
  const plan={...fixture(),suite:[file],units:[{id:'db-system-label-exchange-browser',kind:'db',files:[file]}]};
  assert.equal(systemLabelFontsRequired(plan,'db-system-label-exchange-browser',expected),false);
 }
});
test('stale, absent or malformed candidate/controller identity refuses before selection',()=>{
 for(const change of [{sha:'b'.repeat(40)},{controller:'d'.repeat(40)},{sha:undefined},{controller:undefined}])
  assert.throws(()=>systemLabelFontsRequired({...fixture(),...change},'db-selected',expected));
 for(const change of [{candidate:''},{controller:''},{candidate:'main'},{controller:'c'.repeat(39)}])
  assert.throws(()=>systemLabelFontsRequired(fixture(),'db-selected',{...expected,...change}));
});
test('unknown, duplicate, browser or malformed units cannot produce a font decision',()=>{
 assert.throws(()=>systemLabelFontsRequired(fixture(),'unknown',expected));
 assert.throws(()=>systemLabelFontsRequired(fixture(),'',expected));
 for(const unit of [{id:'db-selected',kind:'browser',files:[consumer]},{id:'db-selected',kind:'db',files:[]},
  {id:'db-selected',kind:'db',files:[consumer,consumer]},{id:'db-selected',kind:'db',files:['test/foreign.test.ts']},
  {id:'db-selected',kind:'db',files:null},{id:'db-selected',kind:'db',files:[null]}])
  assert.throws(()=>systemLabelFontsRequired({...fixture(),units:[unit]},'db-selected',expected));
 const plan=fixture();plan.units.push({...plan.units[0]});assert.throws(()=>systemLabelFontsRequired(plan,'db-selected',expected));
 for(const plan of [null,{...fixture(),suite:null},{...fixture(),units:null}])
  assert.throws(()=>systemLabelFontsRequired(plan,'db-selected',expected));
});

const workflow=name=>readFileSync(new URL(`../workflows/${name}`,import.meta.url),'utf8');
const bootstrap='node ../automation/.github/ci/fixed-noto-bootstrap.mjs';
test('focused fonts preserve the four existing consumers and add only the exact System Labels path',()=>{
 const text=workflow('alpha-focused-checks.yml');
 const start=text.indexOf('      - name: Provision multilingual fonts for AI review screenshots');
 const end=text.indexOf('      - name: Classify and execute only selected files',start);
 assert(start>0&&end>start);const step=text.slice(start,end);
 const paths=[...step.matchAll(/contains\(inputs\.selected_tests, '([^']+)'\)/g)].map(match=>match[1]);
 assert.deepEqual(paths,['test/ai-management-naming.dom.test.tsx','test/ai-probe-history-page.dom.test.tsx',
  'test/feedback-kanban.dom.test.tsx','test/security-center-sidebar.dom.test.tsx',consumer]);
 assert(step.includes(bootstrap+' "$RUNNER_TEMP/aihr-focused/noto-font-setup.json"'));assert(!step.includes('apt-get'));assert(!/continue-on-error|always\(\)/.test(step));
});
test('full fonts use the trusted current unit output before headroom admission and actual execution',()=>{
 const text=workflow('alpha-staging.yml'),start=text.indexOf('      - name: Select System Labels fonts for this complete unit');
 const fonts=text.indexOf('      - name: Provision System Labels multilingual fonts before tests',start);
 const headroom=text.indexOf('      - name: Preserve suite headroom after PDF tooling',fonts);
 const run=text.indexOf('      - run: node ../automation/.github/ci/run-unit.mjs',headroom);
 assert(start>0&&fonts>start&&headroom>fonts&&run>headroom);
 const selector=text.slice(start,fonts),install=text.slice(fonts,headroom);
 assert(selector.includes('id: system-label-fonts'));
 assert(selector.includes('run: node ../automation/.github/ci/system-label-fonts.mjs "$UNIT"'));
 assert(selector.includes("env: {UNIT: '${{ matrix.unit }}'}"));
 assert(install.includes("if: ${{ steps.system-label-fonts.outputs.required == 'true' && inputs.missing_unit == '' }}"));
 assert(install.includes(bootstrap+' "$RUNNER_TEMP/aihr-ci/noto-font-setup.json"'));assert(!install.includes('apt-get'));assert(!/continue-on-error|always\(\)/.test(install));
 const recoveryStart=text.indexOf('      - name: Source-bound fixed HTTPS fonts for missing whole unit',start),pull=text.indexOf('      - name: Bounded source-owned native PostgreSQL image transport',start);
 assert(pull>start&&recoveryStart>pull&&recoveryStart<fonts);
 const recovery=text.slice(recoveryStart,fonts);assert(recovery.includes("if: ${{ inputs.missing_unit != '' }}"));assert(recovery.includes(bootstrap+' "$RUNNER_TEMP/aihr-ci/noto-font-setup.json"'));assert(!/continue-on-error|always\(\)|apt-get/.test(recovery));
 assert.equal((text.match(/fixed-noto-bootstrap\.mjs/g)??[]).length,2);
});
test('both actual resolver control lists execute these prerequisite controls',()=>{
 for(const name of ['alpha-focused-checks.yml','alpha-staging.yml']){
  const text=workflow(name),start=text.indexOf('\n  resolve:');
  const next=text.indexOf(name==='alpha-focused-checks.yml'?'\n  selected-tests:':'\n  typecheck:',start);
  assert(start>0&&next>start);assert(text.slice(start,next).includes('.github/ci/system-label-fonts.test.mjs'));assert(text.slice(start,next).includes('.github/ci/ubuntu-browser-mirror.test.mjs'));
 }
});

const commandResult=(status,extra={})=>({status,signal:null,errorCode:null,stdout:'',stderr:'',elapsedMs:1,...extra});
test('fixed Noto first uses existing indexes, without refreshing an already successful install',()=>{
 const calls=[];const proof=bootstrapFixedNoto({run:(file,args,timeout)=>{calls.push({file,args,timeout});return commandResult(0);}});
 assert.equal(calls.length,1);assert.equal(calls[0].file,'sudo');assert.equal(calls[0].timeout,128000);
 assert.deepEqual(calls[0].args.slice(-5),['install','-y','--no-install-recommends','fonts-noto-core','fonts-noto-cjk']);
 assert(calls[0].args.includes('Acquire::Retries=0'));assert(calls[0].args.includes('Acquire::http::Timeout=20'));
 assert(calls[0].args.includes('Acquire::https::Timeout=20'));assert(calls[0].args.includes('DPkg::Lock::Timeout=15'));
 assert(calls[0].args.includes('120s'));assert(calls[0].args.includes('--kill-after=5s'));
 assert.equal(proof.indexesRefreshed,false);assert.equal(proof.aggregateCommandBudgetSeconds,360);assert.equal(proof.releaseAuthorized,false);
});
test('one ordinary install failure allows one bounded refresh and one identical install retry',()=>{
 const calls=[],statuses=[100,0,0],rows=[];
 const proof=bootstrapFixedNoto({run:(file,args,timeout)=>{calls.push({file,args,timeout});return commandResult(statuses.shift());},onStep:row=>rows.push(row)});
 assert.equal(calls.length,3);assert.deepEqual(calls[0],calls[2]);assert(calls[1].args.includes('update'));
 assert(calls[1].args.includes('APT::Update::Error-Mode=any'));assert(calls.every(call=>call.timeout===128000));
 assert.deepEqual(rows.map(row=>row.phase),['install-existing-indexes','refresh-indexes','install-after-refresh']);
 assert.equal(proof.indexesRefreshed,true);assert.deepEqual(proof.packages,['fonts-noto-core','fonts-noto-cjk']);
});
test('failed refresh or failed one retry refuses with original phase diagnostics and no loop',()=>{
 for(const statuses of [[100,100],[100,0,100]]){
  let calls=0;const rows=[];
  assert.throws(()=>bootstrapFixedNoto({run:()=>commandResult(statuses[calls++],{stderr:'x'.repeat(9000)}),onStep:row=>rows.push(row)}));
  assert.equal(calls,statuses.length);assert(rows.every(row=>row.stderr.length===8192));
 }
});
test('timeout, signal, uncertain cleanup and malformed outcome refuse before another APT process',()=>{
 for(const outcome of [commandResult(null),commandResult(-1),commandResult(256),...[1,124,125,126,127,130,137,143].map(status=>commandResult(status)),commandResult(null,{signal:'SIGKILL'}),
  commandResult(null,{errorCode:'ETIMEDOUT'}),commandResult('0')]){
  let calls=0;const rows=[];let failure;
  try{bootstrapFixedNoto({run:()=>{calls++;return outcome;},onStep:row=>rows.push(row)});}catch(error){failure=error;}
  assert(failure);assert.equal(calls,1);assert.equal(rows.length,1);assert.equal(failure.fontSetupSteps.length,1);
  assert.equal(rows[0].phase,'install-existing-indexes');assert.equal(rows[0].status,outcome.status);
  assert.equal(rows[0].signal,outcome.signal);assert.equal(rows[0].errorCode,outcome.errorCode);
  assert.deepEqual(failure.fontSetupSteps,rows);
 }
});
test('only the same disposable source-bound repository runner can execute font mutation',()=>{
 const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',
  GITHUB_REPOSITORY_ID:'1333414856',AIHR_CI_HEAD:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'b'.repeat(40)};
 assert.doesNotThrow(()=>assertFixedNotoRunner(env,'linux'));
 for(const change of [{GITHUB_ACTIONS:'false'},{CI:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_REPOSITORY:'foreign/repo'},
  {GITHUB_REPOSITORY_ID:'1'},{AIHR_CI_HEAD:'main'},{AIHR_CI_CONTROL_HEAD:undefined}])assert.throws(()=>assertFixedNotoRunner({...env,...change},'linux'));
 assert.throws(()=>assertFixedNotoRunner(env,'darwin'));
});

const standardUbuntu='Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
const standardMirrors='http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n';
function transportFixture({source=standardUbuntu,writeResult=commandResult(0),badReadback=false,changedBeforeWrite=false}={}){
 let value=source,sourceReads=0;const reads=[],writes=[],observed=[];
 const read=(file,limit)=>{
  reads.push({file,limit});
  if(file==='/etc/apt/apt-mirrors.txt'){assert.equal(limit,4096);return standardMirrors;}
  assert.equal(file,'/etc/apt/sources.list.d/ubuntu.sources');assert.equal(limit,65536);sourceReads++;
  if(changedBeforeWrite&&sourceReads===2)return value+'# changed';
  return value;
 };
 const write=text=>{writes.push(text);if(!badReadback)value=text;return writeResult;};
 return {read,write,onStep:proof=>observed.push({...proof}),reads,writes,observed};
}
test('fixed font transport reuses the existing pure validator and verifies actual after bytes without raw config evidence',()=>{
 const f=transportFixture(),proof=configureFixedNotoTransport(f);
 assert.equal(f.writes.length,1);assert.equal(f.writes[0],standardUbuntu.replace('mirror+file:/etc/apt/apt-mirrors.txt','https://archive.ubuntu.com/ubuntu/'));
 assert.equal(proof.variant,'primary-https');assert.equal(proof.signaturePolicyUnchanged,true);assert.equal(proof.packageSelectionUnchanged,true);
 assert.equal(proof.afterBytesVerified,true);assert.equal(proof.releaseAuthorized,false);assert.notEqual(proof.beforeSha256,proof.afterSha256);
 assert.deepEqual(proof.write.args,['-n','tee','/etc/apt/sources.list.d/ubuntu.sources']);
 assert.equal(f.reads.filter(row=>row.file==='/etc/apt/sources.list.d/ubuntu.sources').length,3);
 assert(!JSON.stringify(proof).includes('Types:'));assert(!JSON.stringify(proof).includes('priority:1'));
});
test('unknown Ubuntu source or concurrent source change refuses before any privileged write',()=>{
 for(const options of [{source:standardUbuntu.replace('mirror+file:/etc/apt/apt-mirrors.txt','https://example.invalid/ubuntu/')},{changedBeforeWrite:true}]){
  const f=transportFixture(options);assert.throws(()=>configureFixedNotoTransport(f),/Fixed Ubuntu transport validation\/write refused/);assert.equal(f.writes.length,0);
 }
});
test('transport wrapper failure and wrong after bytes retain sanitized proof and refuse before APT',()=>{
 for(const options of [{writeResult:commandResult(1,{stderr:'tee failed'})},{writeResult:commandResult(null,{errorCode:'ETIMEDOUT'})},{badReadback:true}]){
  const f=transportFixture(options);let failure;try{configureFixedNotoTransport(f);}catch(error){failure=error;}
  assert(failure);assert.equal(f.writes.length,1);assert(failure.fontTransportProof);assert(!JSON.stringify(failure.fontTransportProof).includes('Types:'));
 }
});
test('rejected mirror content cannot escape through assertion messages or proof',()=>{
 const f=transportFixture(),read=f.read;
 f.read=(file,limit)=>file==='/etc/apt/apt-mirrors.txt'?standardMirrors+'https://private.invalid/secret-token\n':read(file,limit);
 let failure;try{configureFixedNotoTransport(f);}catch(error){failure=error;}
 assert(failure);assert.equal(f.writes.length,0);assert(!String(failure).includes('secret-token'));assert(!JSON.stringify(failure.fontTransportProof).includes('secret-token'));
});
test('fixed bootstrap CLI alone owns source mutation and existing diagnostic workflow guard is unchanged',()=>{
 const helper=readFileSync(new URL('./fixed-noto-bootstrap.mjs',import.meta.url),'utf8');
 const cli=helper.slice(helper.indexOf('if(process.argv[1]'));
 assert(cli.indexOf('assertFixedNotoRunner')<cli.indexOf('configureFixedNotoTransport'));
 assert(cli.indexOf('configureFixedNotoTransport')<cli.indexOf('bootstrapFixedNoto'));
 assert(helper.includes('constants.O_NOFOLLOW'));assert(helper.includes('st.uid===0'));assert(helper.includes('timeout:10000'));
 const diagnostic=readFileSync(new URL('./ubuntu-browser-mirror.mjs',import.meta.url),'utf8');
 assert(diagnostic.includes("process.env.GITHUB_WORKFLOW==='browser-provisioning-diagnostics'"));
});

test('read-only transport diagnostics explain standard/EC2 layouts without expanding mutable sources or leaking unknown fields',()=>{
 const ec2='http://us-east-2.ec2.archive.ubuntu.com/ubuntu/';
 const diag=ubuntuFontTransportDiagnostic('URIs: '+ec2+'\n',ec2+' priority:1\nhttps://archive.ubuntu.com/ubuntu/ priority:2\n');
 assert.equal(diag.sourceUris[0].url,ec2);assert.equal(diag.mirrorList.rows[0].url,ec2);assert.equal(diag.mirrorList.rows[0].priority,1);
 for(const value of ['https://name:secret@archive.ubuntu.com/ubuntu/','https://archive.ubuntu.com/ubuntu/?token=secret',
  'https://private.invalid/secret','https://archive.ubuntu.com/other#secret']){
  const result=ubuntuFontTransportDiagnostic('URIs: '+value+'\n',value+' priority:1\n');
  assert.equal(result.sourceUris[0].redacted,true);assert(!JSON.stringify(result).includes('secret'));
 }
 const unknown=ubuntuFontTransportDiagnostic(standardUbuntu,'https://archive.ubuntu.com/ubuntu/ priority:2 private=secret\n');
 assert.equal(unknown.mirrorList.rows[0].redacted,true);assert(!JSON.stringify(unknown).includes('secret'));
 const f=transportFixture({source:standardUbuntu.replace('mirror+file:/etc/apt/apt-mirrors.txt',ec2)});
 assert.throws(()=>configureFixedNotoTransport(f));assert.equal(f.writes.length,0);
});

test('real Ubuntu source boundary preserves valid Unicode and BOM bytes and refuses replacement decoding',()=>{
 const valid=Buffer.from('# தமிழ்中文\nTypes: deb\n','utf8');
 assert(Buffer.from(decodeUbuntuSourceBytes(valid),'utf8').equals(valid));
 const bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),valid]);
 const decoded=decodeUbuntuSourceBytes(bom);assert.equal(decoded.charCodeAt(0),0xfeff);assert(Buffer.from(decoded,'utf8').equals(bom));
 for(const invalid of [Buffer.from([0xff]),Buffer.from([0xc3,0x28]),Buffer.from([0xe2,0x82])])assert.throws(()=>decodeUbuntuSourceBytes(invalid));
 const helper=readFileSync(new URL('./fixed-noto-bootstrap.mjs',import.meta.url),'utf8');
 assert(helper.includes('return decodeUbuntuSourceBytes(buffer.subarray(0,count))'));
});
