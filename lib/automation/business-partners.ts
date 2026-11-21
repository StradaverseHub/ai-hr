/** Business responsibility rules, separate from named document/email recipient routings. */
import {z} from 'zod';

export const businessPartnerDimensionSchema=z.enum(['businessGroup','company','department']);
export type BusinessPartnerDimension=z.infer<typeof businessPartnerDimensionSchema>;
export const businessPartnerRuleSchema=z.object({
 userId:z.uuid(),
 rules:z.object({businessGroup:z.array(z.uuid()).optional(),company:z.array(z.uuid()).optional(),department:z.array(z.uuid()).optional()}).strict(),
}).strict();
export const businessPartnerRulesSchema=z.array(businessPartnerRuleSchema).max(500);
export type BusinessPartnerRule=z.infer<typeof businessPartnerRuleSchema>;
export const businessPartnerPersonSchema=z.object({id:z.uuid(),name:z.string().min(1)}).strict();
export type BusinessPartnerPerson=z.infer<typeof businessPartnerPersonSchema>;
export const businessPartnerWorkspaceSchema=z.object({
 revision:z.number().int().nonnegative(),rules:businessPartnerRulesSchema,people:z.array(businessPartnerPersonSchema).max(500),
 scopeLabels:z.object({businessGroup:z.array(businessPartnerPersonSchema),company:z.array(businessPartnerPersonSchema),department:z.array(businessPartnerPersonSchema)}).strict(),
}).strict();
export type BusinessPartnerWorkspace=z.infer<typeof businessPartnerWorkspaceSchema>;
export const saveBusinessPartnersSchema=z.object({
 expectedRevision:z.number().int().nonnegative(),rules:businessPartnerRulesSchema,reason:z.string().trim().min(20).max(5000),
}).strict();
export type SaveBusinessPartnersInput=z.infer<typeof saveBusinessPartnersSchema>;
