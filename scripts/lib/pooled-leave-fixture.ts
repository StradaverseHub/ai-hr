/** Synthetic display fixture only. Exact row custody is independent of shared dates, names and types. */
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,sql} from 'drizzle-orm';
import * as s from '../../db/schema';
import type {Tx} from '../../db/client';
import {assertOwnedFixtureRows} from './disposable-demo-fixture';

const names=['Pooled Leave (dev fixture)','Standalone Pool (dev fixture)'];
export type PooledFixtureReceipt={version:1;tenantId:string;source:string;groups:(typeof s.leaveSharedGroup.$inferSelect)[];members:(typeof s.leaveSharedGroupMember.$inferSelect)[];requests:(typeof s.leaveRequest.$inferSelect)[];borrowerId:string;previousSourceId:string|null;poolId:string};

async function ownedRows(tx:Tx,tenantId:string,receipt:PooledFixtureReceipt){
 if(receipt.version!==1||receipt.tenantId!==tenantId||receipt.groups.length!==2)throw Error('Invalid pooled fixture receipt.');
 const groups=await tx.select().from(s.leaveSharedGroup).where(and(eq(s.leaveSharedGroup.tenantId,tenantId),inArray(s.leaveSharedGroup.id,receipt.groups.map(r=>r.id)))).for('update');
 const members=await tx.select().from(s.leaveSharedGroupMember).where(and(eq(s.leaveSharedGroupMember.tenantId,tenantId),inArray(s.leaveSharedGroupMember.groupId,receipt.groups.map(r=>r.id)))).for('update');
 const requests=receipt.requests.length?await tx.select().from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,tenantId),inArray(s.leaveRequest.id,receipt.requests.map(r=>r.id)))).for('update'):[];
 assertOwnedFixtureRows(receipt.groups,groups);assertOwnedFixtureRows(receipt.members,members);assertOwnedFixtureRows(receipt.requests,requests);
 const [borrower]=await tx.select().from(s.leaveType).where(and(eq(s.leaveType.tenantId,tenantId),eq(s.leaveType.id,receipt.borrowerId))).for('update');
 if(!borrower||borrower.balanceSourceTypeId!==receipt.poolId)throw Error('Fixture routing changed; refusing to overwrite it.');
 return {groups,members,requests};
}

export async function preparePooledFixture(tx:Tx,tenantId:string,today:string,source:string,previous?:PooledFixtureReceipt):Promise<PooledFixtureReceipt>{
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dev-fixture:pooled:${tenantId}`},0))`);
 if(previous){await ownedRows(tx,tenantId,previous);return previous;}
 const collisions=await tx.select({id:s.leaveSharedGroup.id}).from(s.leaveSharedGroup).where(and(eq(s.leaveSharedGroup.tenantId,tenantId),inArray(s.leaveSharedGroup.name,names)));
 if(collisions.length)throw Error('Unreceipted fixture groups already exist; refusing to guess ownership.');
 const types=await tx.select().from(s.leaveType).where(eq(s.leaveType.tenantId,tenantId)).for('update');
 const get=(code:string)=>{const row=types.find(r=>r.code===code);if(!row)throw Error(`Seeded leave type ${code} is required.`);return row;};
 const pool=get('SICK'),borrower=get('HOSPITALIZATION'),also=get('ANNUAL'),standalone=get('MATERNITY');
 const [grant]=await tx.select({days:sql<string>`coalesce(sum(${s.leaveLedger.days}),0)`}).from(s.leaveLedger).where(and(eq(s.leaveLedger.tenantId,tenantId),eq(s.leaveLedger.leaveTypeId,pool.id)));
 if(Number(grant.days)<=0)throw Error('The pool must have independently granted days before fixture preparation.');
 const groups=await tx.insert(s.leaveSharedGroup).values([
  {id:randomUUID(),tenantId,name:names[0],totalLimitDays:'10.00',maxDaysPerApplication:'3.00',essPlacement:'secondary'},
  {id:randomUUID(),tenantId,name:names[1],totalLimitDays:'6.00',maxDaysPerApplication:null,essPlacement:'secondary'},
 ]).returning();
 const members=await tx.insert(s.leaveSharedGroupMember).values([
  {tenantId,groupId:groups[0].id,leaveTypeId:pool.id},{tenantId,groupId:groups[0].id,leaveTypeId:borrower.id},
  {tenantId,groupId:groups[0].id,leaveTypeId:also.id},{tenantId,groupId:groups[1].id,leaveTypeId:standalone.id},
 ]).returning();
 await tx.update(s.leaveType).set({balanceSourceTypeId:pool.id}).where(eq(s.leaveType.id,borrower.id));
 const employees=await tx.select({id:s.employment.id}).from(s.employment).where(and(eq(s.employment.tenantId,tenantId),sql`${s.employment.terminatedOn} is null`));
 const year=today.slice(0,4);
 const requests=employees.length?await tx.insert(s.leaveRequest).values(employees.map(e=>({id:randomUUID(),tenantId,employmentId:e.id,leaveTypeId:pool.id,startDate:`${year}-01-12`,endDate:`${year}-01-13`,days:'2.00',status:'approved' as const}))).returning():[];
 return {version:1,tenantId,source,groups,members,requests,borrowerId:borrower.id,previousSourceId:borrower.balanceSourceTypeId,poolId:pool.id};
}

export async function clearPooledFixture(tx:Tx,tenantId:string,receipt:PooledFixtureReceipt):Promise<void>{
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dev-fixture:pooled:${tenantId}`},0))`);
 await ownedRows(tx,tenantId,receipt);
 // Request date/type/name never participates in destructive selection.
 if(receipt.requests.length)await tx.delete(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,tenantId),inArray(s.leaveRequest.id,receipt.requests.map(r=>r.id))));
 await tx.delete(s.leaveSharedGroup).where(and(eq(s.leaveSharedGroup.tenantId,tenantId),inArray(s.leaveSharedGroup.id,receipt.groups.map(r=>r.id))));
 await tx.update(s.leaveType).set({balanceSourceTypeId:receipt.previousSourceId}).where(and(eq(s.leaveType.tenantId,tenantId),eq(s.leaveType.id,receipt.borrowerId),eq(s.leaveType.balanceSourceTypeId,receipt.poolId)));
}
