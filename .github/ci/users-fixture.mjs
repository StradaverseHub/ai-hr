// Disposable fictional data only. The controller creates the named database before this runs.
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs';
const req=createRequire(resolve('package.json'));
const dependency=async name=>import(pathToFileURL(req.resolve(name)).href);
const source=async name=>import(pathToFileURL(resolve(name)).href);
const postgres=(await dependency('postgres')).default;
const {drizzle}=await dependency('drizzle-orm/postgres-js');
const {migrate}=await dependency('drizzle-orm/postgres-js/migrator');
const owner=postgres(process.env.MIGRATION_DATABASE_URL,{max:1});
await migrate(drizzle(owner),{migrationsFolder:'db/migrations'});
await (await source('scripts/seed-catalogs.ts')).seedCatalogs(drizzle(owner));
await owner.end();
const harness=await source('test/harness.ts');
const base=await harness.seedBase();
await (await source('lib/internal-auth/bootstrap.ts')).bootstrapInternalOwner(harness.owner.client,{
 appUserId:base.adminUserId,organization:'walkthrough',username:'fixture.owner',email:'owner@example.test',
 password:'Initial fictional passphrase 2026!',installationOperator:false,
});
const auth=await source('lib/internal-auth/service.ts');
const login=await auth.startLogin({organization:'walkthrough',username:'fixture.owner',password:'Initial fictional passphrase 2026!',native:false});
if(!login.challenge)throw Error('Initial password challenge missing');
const setup=await auth.changeInitialPassword(login.challenge,'Changed fictional passphrase 2026!',false);
if(setup.step!=='enroll'||!setup.secret)throw Error('MFA enrollment missing');
const {generate}=await dependency('otplib');
const signed=await auth.verifyMfa(setup.challenge,await generate({secret:setup.secret}),false);
if(signed.step!=='complete')throw Error('Authenticated session missing');
await (await source('core/org.ts')).hireEmployee(harness.adminCtx(base),{
 person:{fullName:'Existing Employee',primaryEmail:'employee@example.test'},companyId:base.companyId,
 departmentId:base.deptA,employmentType:'full_time',hiredOn:(await source('lib/hr-date.ts')).todayInKualaLumpur(),
});
writeFileSync(process.env.USERS_PRIVATE_FIXTURE,JSON.stringify({tenantId:base.tenantId,companyId:base.companyId,session:signed.access_token}),{mode:0o600});
await harness.closeAll();
process.exit(0);
