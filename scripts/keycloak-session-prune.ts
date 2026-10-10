/** Privileged daily maintenance; the web role cannot enumerate or prune sessions. */
import postgres from 'postgres';
async function main() {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Maintenance database connection required.');
  const db=postgres(process.env.MIGRATION_DATABASE_URL,{max:1});
  try { await db`select app.identity_session_prune()`; }
  finally { await db.end(); }
}
main().then(()=>process.exit(0),()=>{console.error('Identity session pruning failed.');process.exit(1);});
