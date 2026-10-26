import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {LocationCaptureError} from '../mobile/lib/errors';
function fixture(){
  const state={currentState:'active'};
  const permission={status:'granted',canAskAgain:true,ios:{accuracy:'full'},android:{accuracy:'fine'}};
  const fix={timestamp:Date.now(),mocked:false,coords:{latitude:3,longitude:101,accuracy:5}};
  const location={requestForegroundPermissionsAsync:vi.fn(async()=>permission),hasServicesEnabledAsync:vi.fn(async()=>true),getCurrentPositionAsync:vi.fn(async()=>fix),Accuracy:{High:4}};
  const module={exports:{} as {capturePosition:()=>Promise<unknown>}};
  const code=transpileModule(readFileSync('mobile/lib/capture.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText;
  runInNewContext(code,{exports:module.exports,module,Date,setTimeout,clearTimeout,require:(id:string)=>{
    if(id==='expo-location')return location;
    if(['expo-image-picker','expo-image-manipulator','expo-file-system','expo-crypto'].includes(id))return {};
    if(id==='react-native')return {AppState:state};
    if(id==='./i18n')return {t:(key:string)=>key};
    if(id==='./errors')return {LocationCaptureError};
    throw new Error(id);
  }});
  return {capture:module.exports.capturePosition,location,permission,fix,state};
}
afterEach(()=>vi.useRealTimers());
describe('foreground location quality',()=>{
  it('distinguishes denied and blocked permission before any position request',async()=>{
    const f=fixture();f.permission.status='denied';
    await expect(f.capture()).rejects.toMatchObject({issue:'permission_denied'});f.permission.canAskAgain=false;
    await expect(f.capture()).rejects.toMatchObject({issue:'permission_blocked'});expect(f.location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });
  it('retains approximate permission as quality metadata without inventing a stricter geofence policy',async()=>{
    const f=fixture();f.permission.ios.accuracy='reduced';
    await expect(f.capture()).resolves.toMatchObject({accuracy:5,permissionAccuracy:'approximate'});
    f.permission.ios.accuracy='full';f.permission.android.accuracy='coarse';
    await expect(f.capture()).resolves.toMatchObject({permissionAccuracy:'approximate'});
  });
  it('reports disabled services and refuses mock-provider evidence',async()=>{
    const f=fixture();f.location.hasServicesEnabledAsync.mockResolvedValueOnce(false);
    await expect(f.capture()).rejects.toMatchObject({issue:'services_disabled'});expect(f.location.getCurrentPositionAsync).not.toHaveBeenCalled();
    f.fix.mocked=true;await expect(f.capture()).rejects.toMatchObject({issue:'mock_location'});
  });
  it('rejects stale, future, invalid and negative-uncertainty fixes',async()=>{
    const f=fixture();f.fix.timestamp=Date.now()-180000;await expect(f.capture()).rejects.toMatchObject({issue:'stale_fix'});
    f.fix.timestamp=Date.now()+180000;await expect(f.capture()).rejects.toMatchObject({issue:'future_fix'});
    f.fix.timestamp=Date.now();f.fix.coords.accuracy=-1;await expect(f.capture()).rejects.toMatchObject({issue:'invalid_fix'});
    f.fix.coords.accuracy=0;f.fix.coords.latitude=91;await expect(f.capture()).rejects.toMatchObject({issue:'invalid_fix'});
    f.fix.coords.latitude=3;f.fix.timestamp=NaN;await expect(f.capture()).rejects.toMatchObject({issue:'invalid_fix'});
  });
  it('checks foreground state again after a delayed native response',async()=>{
    const f=fixture();f.location.getCurrentPositionAsync.mockImplementationOnce(async()=>{f.state.currentState='background';return f.fix;});
    await expect(f.capture()).rejects.toThrow('unlockContinue');
  });
  it('bounds one position request without launching another automatically',async()=>{
    vi.useFakeTimers();const f=fixture();f.location.getCurrentPositionAsync.mockImplementationOnce(()=>new Promise(()=>{}));
    const result=f.capture().catch(error=>error);await vi.advanceTimersByTimeAsync(20001);
    expect(await result).toMatchObject({issue:'unavailable'});expect(f.location.getCurrentPositionAsync).toHaveBeenCalledOnce();
  });
  it('does not start a late position query after a stalled services check has timed out',async()=>{
    vi.useFakeTimers();const f=fixture();let release!:(enabled:boolean)=>void;
    f.location.hasServicesEnabledAsync.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const result=f.capture().catch(error=>error);await vi.advanceTimersByTimeAsync(20001);
    expect(await result).toMatchObject({issue:'unavailable'});release(true);await Promise.resolve();await Promise.resolve();
    expect(f.location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });
});
