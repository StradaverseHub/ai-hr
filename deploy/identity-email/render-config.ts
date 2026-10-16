/** Root installation input only; never a browser setting or fallback to the migration credential. */
export function reportRenderOrigin(value:string):string{
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid internal report origin.');
 return url.origin;
}
export function reportRenderDatabase(value:string,privateDatabase?:string):URL{
 if(/[\r\n\0]/.test(value))throw new Error('Invalid report render database.');
 let url:URL;try{url=new URL(value);}catch{throw new Error('Invalid report render database.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!=='ai_hr_app'||!url.password||!url.hostname||!/^\/[a-zA-Z0-9_-]+$/.test(url.pathname)||url.hash)throw new Error('Use the unprivileged ai_hr_app render database.');
 if([...url.searchParams.keys()].some(key=>['user','username','password','pass','host','hostname','port','database','dbname','role','options','ssl'].includes(key.toLowerCase())))throw new Error('Report database overrides refused.');
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&(url.searchParams.getAll('sslmode').length!==1||url.searchParams.get('sslmode')!=='verify-full'))throw new Error('Remote report database requires verified TLS.');
 if(privateDatabase){const mail=new URL(privateDatabase);if(url.hostname!==mail.hostname||(url.port||'5432')!==(mail.port||'5432')||url.pathname!==mail.pathname||url.username===mail.username)throw new Error('Render and private worker roles must be separate on the same database.');}
 return url;
}
