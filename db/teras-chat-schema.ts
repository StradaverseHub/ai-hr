/** AI Centre issue 8 — Drizzle declarations for stored chats and the tenant's "Keep chats for" setting (migration 0952).
 *
 * WHY NOT db/teras-schema.ts. That file is now inside the approved provider-data source closure
 * (scripts/ai-provider-data-source-manifest.mjs): core/teras-wiring/turn.ts and switch.ts, both closure roots, import it.
 * Any edit there changes the approved digest. These tables are not part of any provider request, so they are declared
 * here and imported only by core/teras-chats.ts, core/teras-chat-expiry.ts and tests; nothing in the provider-data or
 * module-agent closures imports this file. Fold into db/schema.ts when the next approval of that closure is taken.
 *
 * Columns the database stamps (created_at, last_message_at, expires_at) are written by the 0952 trigger, never by a
 * caller; core/teras-chats.ts writes these tables with plain SQL and reads them through these declarations. */
import {boolean,index,integer,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import {appUser,tenant} from './schema';

const at=(name:string)=>timestamp(name,{withTimezone:true});

export const terasChatRetention=pgTable('teras_chat_retention',{
 tenantId:uuid('tenant_id').primaryKey().references(()=>tenant.id),keepDays:integer('keep_days').notNull().default(30),
 version:integer('version').notNull().default(1),
 changedByUserId:uuid('changed_by_user_id').notNull().references(()=>appUser.id),changedAt:at('changed_at').notNull().defaultNow(),
});

export const terasChat=pgTable('teras_chat',{
 id:uuid('id').primaryKey(),tenantId:uuid('tenant_id').notNull().references(()=>tenant.id),
 appUserId:uuid('app_user_id').notNull().references(()=>appUser.id,{onDelete:'cascade'}),personId:uuid('person_id'),
 companyId:uuid('company_id').notNull(),scopeDigest:text('scope_digest').notNull(),turnCount:integer('turn_count').notNull().default(0),
 createdAt:at('created_at').notNull().defaultNow(),lastMessageAt:at('last_message_at').notNull().defaultNow(),expiresAt:at('expires_at').notNull(),
},t=>[index('teras_chat_owner_idx').on(t.tenantId,t.appUserId,t.lastMessageAt,t.id),index('teras_chat_expiry_idx').on(t.expiresAt)]);

export const terasChatTurn=pgTable('teras_chat_turn',{
 tenantId:uuid('tenant_id').notNull(),appUserId:uuid('app_user_id').notNull(),chatId:uuid('chat_id').notNull(),seq:integer('seq').notNull(),
 createdAt:at('created_at').notNull().defaultNow(),withheld:boolean('withheld').notNull(),
 questionCiphertext:text('question_ciphertext'),replyCiphertext:text('reply_ciphertext'),modelCiphertext:text('model_ciphertext'),
},t=>[primaryKey({columns:[t.tenantId,t.chatId,t.seq]})]);
