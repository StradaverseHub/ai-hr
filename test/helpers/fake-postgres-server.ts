/** A minimal PostgreSQL wire-protocol server for driver-state tests that need exact control over when a connection
 * closes or a statement answers, which a real server cannot give deterministically. It trusts every login and
 * answers every statement with no rows. Hooks decide, per connection, what happens on Terminate and on each statement:
 * answer it, never answer (`hold`, as a stalled backend), or drop the socket (`destroy`, as a lost connection). */
import net from 'node:net';

export type FakeStatementAction='answer'|'hold'|'destroy';
export type FakePostgresHooks={
 /** The client sent Terminate. The default ends the socket at once. */
 terminate?(socket:net.Socket):void;
 /** A statement arrived (the Parse or simple Query text). */
 statement?(text:string,socket:net.Socket):FakeStatementAction;
};
export type FakePostgresServer={
 port:number;
 /** Connections that completed startup, in order. */
 readonly connections:net.Socket[];
 statements:string[];
 /** Stop accepting connections (the port refuses) and drop every open one. */
 refuse():Promise<void>;
 /** Accept connections again on the same port. */
 accept():Promise<void>;
 close():Promise<void>;
};

function message(type:string,body:Buffer=Buffer.alloc(0)){
 const head=Buffer.alloc(5);head.write(type,0,'latin1');head.writeUInt32BE(body.length+4,1);
 return Buffer.concat([head,body]);
}
const int32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const READY=message('Z',Buffer.from('I'));
const SELECT_NONE=message('C',Buffer.from('SELECT 0\0'));

export async function startFakePostgres(hooks:FakePostgresHooks={}):Promise<FakePostgresServer>{
 const connections:net.Socket[]=[];const open=new Set<net.Socket>();const statements:string[]=[];
 const server=net.createServer(socket=>{
  open.add(socket);socket.on('close',()=>open.delete(socket));socket.on('error',()=>undefined);
  let buffer=Buffer.alloc(0),started=false,held=false;
  socket.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   for(;;){
    if(!started){
     if(buffer.length<4)return;
     const length=buffer.readUInt32BE(0);if(buffer.length<length)return;
     buffer=buffer.subarray(length);started=true;connections.push(socket);
     // AuthenticationOk, BackendKeyData, ReadyForQuery.
     socket.write(Buffer.concat([message('R',int32(0)),message('K',Buffer.concat([int32(connections.length),int32(7)])),READY]));
     continue;
    }
    if(buffer.length<5)return;
    const type=String.fromCharCode(buffer[0]!),length=buffer.readUInt32BE(1);
    if(buffer.length<length+1)return;
    const body=buffer.subarray(5,length+1);buffer=buffer.subarray(length+1);
    if(type==='X'){(hooks.terminate??(s=>s.end()))(socket);return;}
    if(held)continue;
    if(type==='P'||type==='Q'){
     // Parse: statement name, then the text; Query: the text.
     const text=type==='P'?body.toString('utf8',body.indexOf(0)+1,body.indexOf(0,body.indexOf(0)+1)):body.toString('utf8',0,body.indexOf(0));
     statements.push(text);
     const action=hooks.statement?.(text,socket)??'answer';
     if(action==='destroy'){socket.destroy();return;}
     if(action==='hold'){held=true;continue;}
    }
    if(type==='P')socket.write(message('1'));
    else if(type==='D')socket.write(Buffer.concat([message('t',Buffer.from([0,0])),message('n')]));
    else if(type==='B')socket.write(message('2'));
    else if(type==='E')socket.write(SELECT_NONE);
    else if(type==='S')socket.write(READY);
    else if(type==='Q')socket.write(Buffer.concat([SELECT_NONE,READY]));
   }
  });
 });
 let port=0;
 const listen=()=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const stop=()=>new Promise<void>(resolve=>{server.close(()=>resolve());for(const socket of open)socket.destroy();});
 await listen();port=(server.address() as net.AddressInfo).port;
 return{port,connections,statements,refuse:stop,accept:listen,close:()=>server.listening?stop():Promise.resolve()};
}
