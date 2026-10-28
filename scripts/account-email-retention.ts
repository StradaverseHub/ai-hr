/** Owner-only scheduled delivery-log cleanup. Never sends mail or changes account state. */
import postgres from 'postgres';
async function main(){
 if(!process.env.MIGRATION_DATABASE_URL)throw Error('Maintenance database connection required.');
 const db=postgres(process.env.MIGRATION_DATABASE_URL,{max:1,connection:{statement_timeout:30000,lock_timeout:5000}});
 try{
  const [result]=await db<{removed:number}[]>`select app.account_email_retention_prune() removed`;
  console.log(JSON.stringify({kind:'ACCOUNT_EMAIL_RETENTION_COMPLETED',removed:result.removed}));
 }finally{await db.end();}
}
main().then(()=>process.exit(0),()=>{console.error('Email delivery log cleanup failed; no successful cleanup claimed.');process.exit(1);});
