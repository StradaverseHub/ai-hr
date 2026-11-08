/** The same closed native observation contract is used at capture and replay.
 * The actual capture separately binds database to its admitted worker owner. */
import {z} from 'zod';
export const notificationCatalogueSessionSchema=z.object({
 database:z.string(),pid:z.number().int().positive(),
 backendStart:z.string(),postmasterStart:z.string(),snapshot:z.string(),
 version:z.number().int(),versionText:z.string(),
 session:z.literal('postgres'),current:z.literal('postgres'),loopback:z.literal(true),
 isolation:z.literal('repeatable read'),readOnly:z.literal('on'),statement:z.literal('20s'),lock:z.literal('300ms'),
 encoding:z.literal('UTF8'),clientEncoding:z.literal('UTF8'),searchPath:z.literal('pg_catalog'),application:z.literal('aihr-canonical-inventory'),
}).strict();
