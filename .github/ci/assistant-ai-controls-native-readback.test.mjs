/** Pure guard cases only: NOT real app-role/database/browser experience. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAiControlsReadbackTarget,assertAiControlsReadbackPhysical} from './assistant-ai-controls-native-readback.mjs';
const database='aihr_assistant_browser_0123456789abcdef';
const env=()=>({DATABASE_URL:`postgres://ai_hr_app:FICTIONAL@127.0.0.1:5433/${database}?sslmode=disable`,MIGRATION_DATABASE_URL:`postgres://fixture_owner:FICTIONAL@127.0.0.1:5433/${database}?sslmode=disable`});
test('target requires one randomized loopback5433 database and distinct genuine roles, never a default/fallback target',()=>{
 assert.deepEqual(parseAiControlsReadbackTarget(env()),{database,ownerName:'fixture_owner'});
 for(const patch of [{DATABASE_URL:undefined},{MIGRATION_DATABASE_URL:'not-a-url'},{DATABASE_URL:env().DATABASE_URL.replace('5433','5432')},{MIGRATION_DATABASE_URL:env().MIGRATION_DATABASE_URL.replace('127.0.0.1','remote.invalid')},{MIGRATION_DATABASE_URL:env().MIGRATION_DATABASE_URL.replace(database,'aihr_assistant_browser_fedcba9876543210')},{MIGRATION_DATABASE_URL:env().MIGRATION_DATABASE_URL.replace('fixture_owner','ai_hr_app')},{DATABASE_URL:env().DATABASE_URL.replace(database,'aihr_ai_delivery_browser_v4_20261027')},{DATABASE_URL:env().DATABASE_URL+'&application_name=forged'},{DATABASE_URL:env().DATABASE_URL+'#secret'}])assert.throws(()=>parseAiControlsReadbackTarget({...env(),...patch}),{message:'assistant_ai_controls_native_readback:unavailable'});
});
test('physical guard rejects default isolation, writable snapshots, role elevation and owner/app confusion',()=>{
 const target=parseAiControlsReadbackTarget(env()),app={name:'ai_hr_app',database,address:'127.0.0.1',port:5433,readonly:'on',isolation:'read committed',super:false,bypass:false};
 assert.doesNotThrow(()=>assertAiControlsReadbackPhysical(app,target,false));assert.doesNotThrow(()=>assertAiControlsReadbackPhysical({...app,name:'fixture_owner',full:true},target,true));
 for(const patch of [{name:'fixture_owner'},{database:'preserved_foreign_fixture'},{address:'10.0.0.1'},{port:5432},{readonly:'off'},{isolation:'repeatable read'},{super:true},{bypass:true},{super:null}])assert.throws(()=>assertAiControlsReadbackPhysical({...app,...patch},target,false),{message:'assistant_ai_controls_native_readback:unavailable'});
 for(const patch of [{name:'ai_hr_app',full:true},{name:'fixture_owner',full:false},{name:'other_owner',full:true}])assert.throws(()=>assertAiControlsReadbackPhysical({...app,...patch},target,true));
});
