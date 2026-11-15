/** Dead-peer detection on the import worker's real connections (db/worker-connection.ts), against the CI PostgreSQL:
 * - a worker-role process's HR-transaction pool (both connections) and the queue-owner connection the runner opens
 *   carry the server keepalive, user timeout and connection check from startup (pg_settings source 'client'), and the
 *   client keepalive is pinned;
 * - a role that is not a superuser (ai_hr_app) opens them, so the restricted ai_hr_owner on staging and production can;
 * - a web-role process's connections keep the server's defaults.
 * The option builder itself is in test/worker-connection.test.ts. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {client as webClient} from '../db/client';
import {databaseProcessRole} from '../db/capacity';
import {closeAll,migrateTestDb} from './harness';

type Probe={role:string;superuser:boolean;tcp:boolean;pid:number;shownIdle:string;settings:Record<string,{setting:string;source:string}>};
const expected={
 tcp_keepalives_idle:{setting:'60',source:'client'},
 tcp_keepalives_interval:{setting:'15',source:'client'},
 tcp_keepalives_count:{setting:'8',source:'client'},
 tcp_user_timeout:{setting:'180000',source:'client'},
 client_connection_check_interval:{setting:'10000',source:'client'},
};

beforeAll(async()=>{await migrateTestDb();});
afterAll(async()=>{await closeAll();});

// One child compiles db/client's module graph with tsx (about 10-20 s on a hosted runner); 4x headroom.
it('gives every worker connection the dead-peer settings, including under a role that is not a superuser',()=>{
 const child=spawnSync(process.execPath,['--import','tsx','test/helpers/worker-connection-probe.ts'],{cwd:process.cwd(),encoding:'utf8',timeout:90_000,
  env:{...process.env,NODE_ENV:process.env.NODE_ENV??'test',AIHR_DB_PROCESS_ROLE:'worker',AIHR_DB_POOL_MAX:'2',
   DATABASE_URL:process.env.DATABASE_URL,MIGRATION_DATABASE_URL:process.env.MIGRATION_DATABASE_URL}});
 expect(child.status,child.stdout+child.stderr+String(child.error??'')).toBe(0);
 const result=JSON.parse(child.stdout.trim().split('\n').at(-1)!) as {poolMax:number;poolKeepAlive:number;pool:Probe[];owner:Probe&{keepAlive:number};appOwner:Probe&{keepAlive:number}};

 // The HR-transaction pool: two distinct backends, both as the app role, both with the settings from startup.
 expect(result.poolMax).toBe(2);
 expect(result.poolKeepAlive).toBe(60);
 expect(result.pool).toHaveLength(2);
 expect(result.pool[0].pid).not.toBe(result.pool[1].pid);
 for(const probe of result.pool){
  expect(probe).toMatchObject({role:'ai_hr_app',superuser:false,tcp:true});
  // PostgreSQL's SHOW reads the socket's own value back (variable.c show_tcp_keepalives_idle), without a unit.
  expect(['60','1min']).toContain(probe.shownIdle);
  expect(probe.settings).toEqual(expected);
 }
 // The queue-owner connection, exactly as the runner opens it.
 expect(result.owner.keepAlive).toBe(60);
 expect(result.owner.tcp).toBe(true);
 expect(['60','1min']).toContain(result.owner.shownIdle);
 expect(result.owner.settings).toEqual(expected);
 // The same owner factory under a role that is not a superuser: the server accepts every parameter.
 expect(result.appOwner).toMatchObject({role:'ai_hr_app',superuser:false,tcp:true,keepAlive:60});
 expect(result.appOwner.settings).toEqual(expected);
},90_000);

it('leaves a web process on the server defaults',async()=>{
 expect(databaseProcessRole(process.env)).toBe('web');
 const rows=await webClient<{name:string;source:string}[]>`select name,source from pg_settings where name in ${webClient(Object.keys(expected))} order by name`;
 expect(rows.map(r=>r.name)).toEqual(Object.keys(expected).sort());
 for(const row of rows)expect(row.source,row.name).not.toBe('client');
});
