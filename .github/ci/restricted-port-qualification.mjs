/** Closed opt-in for standard focused CI; no DB connection or candidate import in this controller. */
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {join} from 'node:path';
export const FIXED_ENTRY='scripts/qualify-restricted-port-prerequisites.ts';
export const REQUIRED_DB_FILES=Object.freeze(['test/personnel-draft-discard-role-transfer.test.ts','test/employee-draft-discard-port.test.ts']);
// Source-review frozen constants; root updates ONLY through an independently reviewed new proposal.
export const SOURCE_PINS=Object.freeze({
  "scripts/qualify-restricted-port-prerequisites.ts": "24faa15d5083e3b987dc51666a75ea42015dfc532f1304f5643c50142f507311",
  "scripts/lib/restricted-port-qualification.ts": "3f9d9f138e617cc5b33969cf2267a6c984714e6da0666ea48a60fac139442ef4",
  "scripts/fixtures/restricted-port-operator-v4/qualification-source-manifest.json": "a5d2e5705a98674784aa1255406a5c3217508299944c07dad4a303bdec0c99e7",
  ".github/ci/restricted-port-history.mjs": "297fa5166942ebf084f86a661a85a1743efa3594457a57979d2e4d88c3fcceb5",
  ".github/ci/migration-history.mjs": "e9ebfb9d97f6c3eac0bb4a6884c31ebfdba00e7492e979b76ca0f51c6ca9a6e2",
  ".github/ci/historical-migrations/0180_profile_option.sql": "ae128e75c9491bd1d39537fdddd18ad9307b2050f813b8a056d473dcfda9d41f",
  ".github/ci/historical-migrations/0212_dashboard_card_config.sql": "aa9337028da35cd3816d8d66486455595e36aea709c98405868ca36320c99f41"
});
export function restrictedPortRequest(value,groups,typecheck){
 if(value===undefined||value==='false')return false;
 if(value!=='true')throw Error('Invalid restricted-port qualification opt-in');
 if(typecheck!=='true'||groups?.DB?.length!==REQUIRED_DB_FILES.length||groups?.NODB?.length!==0||REQUIRED_DB_FILES.some(file=>!groups.DB.includes(file)))throw Error('Restricted-port qualification requires its real DB files and whole typecheck');
 return true;
}
export function fixedQualificationArgs(mode,evidence){
 if(!['before','after'].includes(mode)||typeof evidence!=='string'||!evidence.startsWith('/')||!evidence.endsWith('/aihr-focused')||evidence.split('/').some(part=>part==='..'||part==='.')||evidence.includes('\0'))throw Error('Invalid closed qualification phase');
 return ['--import','tsx',FIXED_ENTRY,mode,evidence];
}
export function assertPinnedSources(cwd){
 for(const [path,digest]of Object.entries(SOURCE_PINS)){
  const file=join(cwd,path);if(realpathSync(file)!==file)throw Error('Qualification source symlink refused');
  const index=execFileSync('git',['ls-files','--stage','--',path],{cwd,encoding:'utf8'}).trim();
  if(!/^(100644|100755) [0-9a-f]{40} 0\t/.test(index)||createHash('sha256').update(readFileSync(file)).digest('hex')!==digest)throw Error('Qualification source differs from reviewed controller pins');
 }
}
export function runRestrictedPortQualification(cwd,mode,evidence,env){
 assertPinnedSources(cwd);
 const result=spawnSync(process.execPath,fixedQualificationArgs(mode,evidence),{cwd,env,stdio:'inherit'});
 if(result.error||result.signal||result.status!==0)throw Error('Restricted-port qualification failed: '+mode);
}
/** Synchronous fixed controller owner; injected functions are controller closures, never workflow inputs. */
export function executeDatabaseSetup(enabled,owners){
 owners.reset();if(enabled)owners.before();owners.migrate();if(enabled)owners.after();
}
