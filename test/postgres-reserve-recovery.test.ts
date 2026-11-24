/** postgres.js reserve() across a connection that closes (patches/postgres@3.4.9.patch, patches/README.md).
 *
 * The import worker's queue-owner pool has one connection, and every bulk-job tick reserves it
 * (core/bulk-job-worker.ts runBulkJobTick). On 24 November staging's payroll lane waited in reserve() for 1,822 s
 * until the stall watchdog ended it, with nothing running in PostgreSQL: the connection had reached postgres.js's
 * default max_lifetime (30-60 min; the lane had run 38 min) between two ticks, and the next tick's reserve() arrived
 * while that connection was still closing. Unpatched, the pool reconnects for the waiting reservation and then drops
 * it, so reserve() never settles. These tests drive the driver against a fake server (test/helpers/fake-postgres-server.ts)
 * that decides exactly when a connection closes; each fails without the patch. */
import {afterEach,expect,it} from 'vitest';
import type net from 'node:net';
import postgres from 'postgres';
import {startFakePostgres,type FakePostgresServer} from './helpers/fake-postgres-server';

const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{while(cleanups.length)await cleanups.pop()!().catch(()=>undefined);});

async function serve(hooks:Parameters<typeof startFakePostgres>[0]={}):Promise<FakePostgresServer>{
 const server=await startFakePostgres(hooks);cleanups.push(()=>server.close());return server;
}
function pool(server:FakePostgresServer,options:postgres.Options<{}>={}){
 const sql=postgres({host:'127.0.0.1',port:server.port,user:'worker',database:'aihr',password:'',ssl:false,max:1,onnotice:()=>undefined,...options});
 cleanups.push(()=>sql.end({timeout:0}));
 return sql;
}
/** The value, or a failure naming what never settled (the unpatched driver waits for ever). */
async function settles<T>(work:Promise<T>,what:string,ms=5000):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${what} did not settle within ${ms} ms`)),ms);})]);}
 finally{clearTimeout(timer);}
}

it('gives a reservation requested while the lifetime-ended connection closes the reconnected connection',async()=>{
 let closing:net.Socket|null=null,terminated!:()=>void;
 const terminate=new Promise<void>(resolve=>{terminated=resolve;});
 // The first Terminate is held, so the next reserve() arrives while that connection is still closing.
 const server=await serve({terminate:socket=>{if(closing)return void socket.end();closing=socket;terminated();}});
 const sql=pool(server,{max_lifetime:0.3});
 const tick=await sql.reserve();
 await tick`select 'first tick'`;
 tick.release();
 await settles(terminate,'the lifetime end of the idle connection');
 const next=sql.reserve();
 closing!.end();
 const reserved=await settles(next,'reserve() after the connection lifetime ended');
 await settles(reserved`select 'next tick'`,'a query on the new reservation');
 reserved.release();
 expect(server.connections).toHaveLength(2);
 expect(server.statements.filter(text=>text.includes('tick'))).toEqual(["select 'first tick'","select 'next tick'"]);
});

it('keeps the pool working when a reservation is released after its connection was lost',async()=>{
 const server=await serve({statement:text=>text.includes('lost')?'destroy':'answer'});
 const sql=pool(server);
 const reserved=await sql.reserve();
 await reserved`select 'before'`;
 await expect(settles(reserved`select 'lost'`,'the statement whose connection is lost')).rejects.toBeInstanceOf(Error);
 // The lost reservation refuses further statements; unpatched it wrote to a connection with no socket, an uncaught
 // TypeError (this test then fails on the unhandled error).
 await expect(settles(reserved`select 'after loss'`,'a statement on the lost reservation')).rejects.toMatchObject({code:'CONNECTION_CLOSED'});
 // As runBulkJobTick's finally does. Unpatched this put the closed connection in the open queue.
 reserved.release();
 await settles(sql`select 'pool'`,'a pool query after the release');
 const again=await settles(sql.reserve(),'the next reservation');
 await settles(again`select 'reserved again'`,'a query on the next reservation');
 again.release();
 expect(server.connections).toHaveLength(2);
});

it('fails a reservation whose connection is refused, and serves the next one once the server is back',async()=>{
 const server=await serve();
 const sql=pool(server);
 const first=await sql.reserve();await first`select 'first'`;first.release();
 await server.refuse();
 await new Promise(resolve=>setTimeout(resolve,50));
 await expect(settles(sql.reserve(),'a reservation while the server refuses')).rejects.toMatchObject({code:'ECONNREFUSED'});
 await server.accept();
 // The failed request must have left the queue: answered later, it would strand the only connection.
 const reserved=await settles(sql.reserve(),'a reservation after the outage');
 await settles(reserved`select 'after outage'`,'a query on that reservation');
 reserved.release();
 await settles(sql`select 'pool after outage'`,'a pool query after the outage');
});
