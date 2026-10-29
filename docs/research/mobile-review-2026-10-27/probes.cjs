const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(process.argv[2] || 'typescript');
const root = process.cwd();
const observations = [];
function load(path, ports, globals = {}) {
  const module = {exports:{}};
  const source = fs.readFileSync(root+'/'+path,'utf8');
  const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require(id){if(id in ports)return ports[id];throw Error('Missing '+id);},Date,FormData,AbortController,setTimeout,clearTimeout,...globals});
  return module.exports;
}
(async()=>{
  const errors=load('mobile/lib/errors.ts',{});
  let fix={coords:{latitude:3,longitude:101,accuracy:5000},timestamp:Date.now(),mocked:false};
  const capture=load('mobile/lib/capture.ts',{'expo-location':{requestForegroundPermissionsAsync:async()=>({status:'granted'}),getCurrentPositionAsync:async()=>fix,Accuracy:{High:4}},'expo-image-picker':{},'expo-image-manipulator':{},'expo-file-system':{},'expo-crypto':{},'react-native':{AppState:{currentState:'active'}},'./i18n':{t:x=>x}});
  assert.equal((await capture.capturePosition()).accuracy,5000);
  observations.push({probe:'foreground capture accepts a 5 km accuracy estimate',result:'confirmed'});
  fix={...fix,timestamp:Date.now()+600000};
  assert((await capture.capturePosition()).sampledAt>Date.now()+500000);
  observations.push({probe:'foreground capture accepts future timestamp by ten minutes (server separately rejects outside two-minute window)',result:'confirmed'});
  fix={...fix,mocked:true};
  await assert.rejects(capture.capturePosition(),/mockLocation/);
  observations.push({probe:'reported Android mock flag is rejected locally',result:'confirmed'});
  const source=fs.readFileSync(root+'/core/attendance.ts','utf8');
  const ast=ts.createSourceFile('attendance.ts',source,ts.ScriptTarget.Latest,true);
  const functions=ast.statements.filter(s=>ts.isFunctionDeclaration(s)&&['resolveGeofence','haversineMetres'].includes(s.name?.text)).map(s=>s.getText(ast)).join('\n');
  const geocode=ts.transpileModule(functions,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const geo={exports:{}};
  vm.runInNewContext(geocode,{module:geo,exports:geo.exports,employment:{},clockingLocation:{},employeeClockingLocation:{},eq(){},and(){},isNull(){},sql(){},GeolocationRequiredError:class extends Error{},OutsideGeofenceError:class extends Error{}});
  let queries=0;
  const tx={select(){const rows=++queries===1?[{geofencingEnabled:true,companyId:'company'}]:[{id:'site',lat:3,lng:101,radiusM:50}];const q={from(){return q;},innerJoin(){return q;},where(){return q;},limit(){return Promise.resolve(rows);},then(resolve,reject){return Promise.resolve(rows).then(resolve,reject);}};return q;}};
  const decision=await geo.exports.resolveGeofence(tx,{employmentId:'own',date:'2026-10-27',time:'09:00',punch:'in',lat:3,lng:101,accuracy:5000});
  assert.equal(decision.enforced,true); assert.equal(decision.radiusM,50);
  observations.push({probe:'actual geofence resolver accepts site-centre coordinate despite 5 km uncertainty around a 50 m fence',result:'confirmed',coverage:'function extracted unchanged; query rows injected, no database'});
  const ports={'react':{},'./auth':{authGeneration:()=>1,assertAuthGeneration(){},getAccessToken:async()=>'access',refresh:async()=>'refreshed'},'./config':{config:{apiUrl:'https://hr.example.test'},apiOriginProblem:()=>null,configProblem:()=>null},'./errors':errors,'./i18n':{appLocale:()=>'en'}};
  let timerActive=false,bodyStarted=false,finishBody;
  const api=load('mobile/lib/api.ts',ports,{setTimeout(){timerActive=true;return 1;},clearTimeout(){timerActive=false;},fetch:async()=>({status:200,ok:true,json(){bodyStarted=true;return new Promise(r=>{finishBody=r;});}})});
  const pending=api.apiGet('me');
  await new Promise(r=>setImmediate(r));
  assert.equal(bodyStarted,true); assert.equal(timerActive,false);
  finishBody({unexpected:'accepted as MeResponse'});
  assert.equal((await pending).unexpected,'accepted as MeResponse');
  observations.push({probe:'API deadline is cleared before JSON body resolves; successful payload is returned without runtime contract validation',result:'confirmed'});
  let cells=[],cursor=0,effects=[],deps=[],fetchFailed=false;
  const react={useState(initial){const i=cursor++;if(!(i in cells))cells[i]=initial;return[cells[i],v=>{cells[i]=typeof v==='function'?v(cells[i]):v;}];},useCallback(fn){cursor++;return fn;},useEffect(fn,next){const i=cursor++;if(!deps[i]||next.some((v,j)=>v!==deps[i][j])){deps[i]=next;effects.push(fn);}}};
  const hook=load('mobile/lib/api.ts',{...ports,react},{fetch:async()=>fetchFailed?{status:503,ok:false}:{status:200,ok:true,json:async()=>({name:'saved employee'})}});
  const onSignIn=()=>{};
  function render(){cursor=0;return hook.useApi('me',{},onSignIn);}
  async function flush(){const current=effects.splice(0);current.forEach(f=>f());await new Promise(r=>setImmediate(r));}
  render();await flush();let view=render();assert.equal(view.data.name,'saved employee');
  fetchFailed=true;view.reload();render();effects.splice(0).forEach(f=>f());view=render();assert.equal(view.data,null);assert.equal(view.loading,true);
  await new Promise(r=>setImmediate(r));view=render();assert.equal(view.data,null);assert.equal(view.error?.name,'UnavailableError');
  observations.push({probe:'same-account refresh discards previously loaded data and leaves only error after 503',result:'confirmed',coverage:'shipped hook executed with deterministic hook-state ports'});
  fs.writeFileSync('/tmp/aihr-mobile-review-probes-20261027.json',JSON.stringify({baseline:'67be2710c35035af433bdb2fcdfb2cb30277ceda',observations},null,2)+'\n');
  console.log(JSON.stringify({observations},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
