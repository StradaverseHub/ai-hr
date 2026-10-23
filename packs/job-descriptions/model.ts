/** Client-safe document vocabulary. Stable identifiers, never translated labels, own stored answers. */
export type FieldType = 'text' | 'longText' | 'number' | 'date' | 'boolean' | 'choice';
export type FieldDefinition = {
    id: string;
    label: string;
    type: FieldType;
    required: boolean;
    options?: string[];
    custom?: boolean;
};
export type SectionDefinition = {
    id: string;
    form: 'analysis' | 'description' | 'specification' | 'quality';
    label: string;
    repeated?: boolean;
    fields: FieldDefinition[];
};
export type Answers = Record<string, Record<string, string | number | boolean>[]>;
export type FormDefinition = {
    version: number;
    sections: SectionDefinition[];
};
export type OrgAssignment = {
    businessUnit?: string;
    department?: string;
    section?: string;
    team?: string;
    position?: string;
    grade?: string;
    family?: string;
    location?: string;
    reportsTo?: string;
    employmentType?: string;
};
export type JobInput = {
    companyId: string;
    jobCode: string;
    title: string;
    owner: string;
    org: OrgAssignment;
    answers: Answers;
    effectiveOn: string;
    reviewOn: string;
    reason: string;
    approverId: string;
    reviewerIds: string[];
};
export const STATUSES = ['draft', 'submitted', 'approved', 'inactive'] as const;
export type JobStatus = typeof STATUSES[number];
export class JobDocumentError extends Error {
    constructor(message: string) { super(message); this.name = 'JobDocumentError'; }
}
const f = (id: string, label: string, type: FieldType = 'longText', required = false): FieldDefinition => ({ id, label, type, required });
const s = (id: string, form: SectionDefinition['form'], label: string, fields: FieldDefinition[], repeated = false): SectionDefinition => ({ id, form, label, fields, repeated });
export const DEFAULT_FORM: FormDefinition = { version: 1, sections: [
        s('analysisDetails', 'analysis', 'Position and analysis details', [f('analyst', 'Job analyst / title', 'text'), f('manager', 'Manager / subject-matter expert', 'text'), f('consulted', 'Job holders / roles consulted (optional)'), f('analysisOn', 'Analysis date', 'date'), f('reason', 'Reason for analysis')]),
        s('evidence', 'analysis', 'Evidence and methods used', [f('method', 'Evidence method', 'choice'), f('source', 'Evidence / source reviewed'), f('sourceOn', 'Source date', 'date'), f('consultation', 'People / roles consulted'), f('consultedOn', 'Consultation date', 'date')], true),
        s('tasks', 'analysis', 'Task and activity analysis', [f('task', 'Task / activity'), f('tools', 'How / tools used'), f('frequency', 'Frequency', 'text'), f('time', 'Time allocation %', 'number'), f('importance', 'Importance / impact'), f('output', 'Output / evidence')], true),
        s('context', 'analysis', 'Job demands, authority and work context', [f('autonomy', 'Decision-making and autonomy'), f('accountability', 'Accountability / consequences of errors'), f('contacts', 'Internal and external contacts'), f('systems', 'Systems, tools and equipment'), f('schedule', 'Work schedule / travel'), f('environment', 'Work environment and physical demands'), f('safety', 'Safety, regulatory and compliance requirements')]),
        s('taskSkills', 'analysis', 'Knowledge, skills and competency analysis', [f('task', 'Task / responsibility'), f('skill', 'Knowledge / skill needed'), f('proficiency', 'Required proficiency', 'text'), f('evidence', 'Evidence / rationale'), f('trainable', 'Trainable after hire?', 'boolean')], true),
        s('findings', 'analysis', 'Findings and recommendations', [f('findings', 'Key findings'), f('workload', 'Workload / process issues'), f('training', 'Training / development needs'), f('descriptionChanges', 'Recommended JD changes'), f('specificationChanges', 'Recommended JS requirements'), f('evaluation', 'Job evaluation referral'), f('limitations', 'Limitations / items requiring validation')]),
        s('validation', 'analysis', 'Validation', [f('analystValidation', 'Job analyst validation / date'), f('managerValidation', 'Department manager validation / date'), f('hrValidation', 'HR review / date')]),
        s('identification', 'description', 'Position identification', [f('positionStatus', 'Position status', 'choice'), f('subfamily', 'Job subfamily', 'text'), f('bandReference', 'Approved grade / level / salary band reference', 'text'), f('directReports', 'Direct reports / supervisory scope'), f('budget', 'Budget / assets / functional scope')]),
        s('purpose', 'description', 'Job purpose', [f('purpose', 'Overall job purpose', 'longText', true), f('summary', 'Job summary'), f('objectives', 'Main objectives'), f('scope', 'Scope of responsibility / business impact')]),
        s('responsibilities', 'description', 'Key duties and responsibilities', [f('responsibility', 'Key responsibility / activity'), f('duties', 'Detailed duties / activities'), f('frequency', 'Frequency', 'text'), f('output', 'Expected output / deliverables'), f('time', 'Time allocation %', 'number'), f('kpi', 'KPI'), f('standard', 'Performance standard / target')], true),
        s('authority', 'description', 'Authority and working relationships', [f('decision', 'Decision-making authority'), f('approval', 'Approval authority / financial limits or policy reference'), f('escalation', 'Escalation requirements'), f('internal', 'Internal stakeholders / relationship purpose'), f('external', 'External stakeholders / relationship purpose'), f('confidentiality', 'Confidentiality / data / asset responsibility')]),
        s('conditions', 'description', 'Working conditions and requirements', [f('hours', 'Working hours / shift / overtime'), f('travel', 'Travel requirements'), f('environment', 'Work environment'), f('physical', 'Physical / operational job demands'), f('safety', 'Safety and compliance responsibilities')]),
        s('kpis', 'description', 'Performance expectations', [f('outcome', 'KPI / outcome'), f('definition', 'Definition / calculation (descriptive only)'), f('target', 'Target / standard'), f('frequency', 'Review frequency', 'text'), f('source', 'Data source / owner')], true),
        s('career', 'description', 'Career and additional information', [f('path', 'Job family / career path'), f('policies', 'Related policies / procedures'), f('requirements', 'Other job requirements'), f('additional', 'Additional responsibilities'), f('comments', 'Remarks / comments')]),
        s('acknowledgement', 'description', 'Preparation and acknowledgement', [f('prepared', 'Prepared by / title / date'), f('departmentReview', 'Department manager review / date'), f('hrReview', 'HR review / date'), f('holder', 'Job holder acknowledgement / date (receipt only, if used)')]),
        s('qualifications', 'specification', 'Qualifications and experience', [f('owner', 'Specification owner', 'text'), f('reviewedOn', 'Date reviewed', 'date'), f('education', 'Minimum education / qualification'), f('preferredEducation', 'Preferred education / qualification'), f('certifications', 'Professional qualifications / certifications'), f('licences', 'Mandatory licences / jurisdiction'), f('experience', 'Minimum relevant experience and rationale'), f('preferredExperience', 'Preferred experience'), f('training', 'Required training before / after appointment')]),
        s('skills', 'specification', 'Skills and knowledge', [f('category', 'Skill category', 'choice'), f('skill', 'Skill / knowledge area'), f('priority', 'Essential or preferred', 'choice'), f('level', 'Required proficiency level', 'text'), f('justification', 'How requirement is justified / task link'), f('assessment', 'Assessment / evidence')], true),
        s('competencies', 'specification', 'Competencies and behaviours', [f('category', 'Competency category', 'choice'), f('competency', 'Competency'), f('behaviour', 'Expected behaviour'), f('level', 'Required proficiency level', 'text'), f('priority', 'Essential or preferred', 'choice'), f('assessment', 'Assessment method / task link')], true),
        s('otherRequirements', 'specification', 'Language, tools and other job requirements', [f('language', 'Language and work-task proficiency'), f('software', 'Computer / software / systems / equipment'), f('physical', 'Physical / schedule / travel requirements (refer to JA)'), f('safety', 'Regulatory / safety requirements')]),
        s('selection', 'specification', 'Recruitment and assessment guidance', [f('essential', 'Essential selection criteria'), f('preferred', 'Preferred selection criteria'), f('methods', 'Assessment methods'), f('evidence', 'Evidence required'), f('justification', 'Justification for critical requirements'), f('training', 'Training after appointment')]),
        s('specificationReview', 'specification', 'Review and preparation', [f('prepared', 'Prepared by / date'), f('managerReview', 'Hiring manager review / date'), f('hrReview', 'HR review / date')]),
        s('quality', 'quality', 'HR quality checklist', [
            f('sources', 'JA evidence sources are recorded', 'boolean'), f('actualWork', 'Tasks reflect the work actually performed', 'boolean'), f('time', 'Task time percentages total 100% (if used)', 'boolean'), f('validated', 'Job holder / manager validated the analysis', 'boolean'), f('purpose', 'JD purpose is clear and concise', 'boolean'), f('measurable', 'Major duties and outputs are measurable where practical', 'boolean'), f('authority', 'Reporting line and authority are clear', 'boolean'), f('kpis', 'KPIs are realistic and role-related', 'boolean'), f('taskLinks', 'JS requirements are linked to job tasks', 'boolean'), f('priority', 'Essential vs preferred criteria are distinguished', 'boolean'), f('justification', 'Qualifications and experience are justified', 'boolean'), f('safety', 'Safety / legal requirements are verified where applicable', 'boolean'), f('proportionate', 'No unnecessary personal criteria included', 'boolean'), f('commonId', 'Common Job ID matches across all forms', 'boolean'), f('approval', 'Approvals and effective date are complete', 'boolean'), f('history', 'Version and revision history are recorded', 'boolean')
        ]),
    ] };
const choices: Record<string, string[]> = {
    'evidence.method': ['Job-holder interview', 'Manager interview', 'Direct observation', 'Questionnaire / survey', 'SOPs / work instructions', 'Organization chart', 'Work samples / reports', 'KPI / performance data', 'Regulatory / safety documents', 'Other'],
    'identification.positionStatus': ['New position', 'Replacement', 'Revised role'],
    'skills.category': ['Technical', 'Functional knowledge', 'Computer / software', 'Language'],
    'competencies.category': ['Behavioural', 'Leadership / management'],
    'skills.priority': ['Essential', 'Preferred'], 'competencies.priority': ['Essential', 'Preferred'],
};
for (const section of DEFAULT_FORM.sections)
    for (const field of section.fields)
        if (choices[`${section.id}.${field.id}`])
            field.options = choices[`${section.id}.${field.id}`];
export function normalizedJobCode(code: string): string { return code.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase(); }
const ID = /^[a-z][a-zA-Z0-9]{0,63}$/;
export function validateDefinition(value: unknown): FormDefinition {
    if (!value || typeof value !== 'object')
        throw new JobDocumentError('Invalid form definition');
    const x = value as FormDefinition;
    if (!Number.isInteger(x.version) || x.version < 1 || !Array.isArray(x.sections) || x.sections.length > 40)
        throw new JobDocumentError('Invalid form version / sections');
    const seen = new Set<string>();
    for (const section of x.sections) {
        if (!ID.test(section.id) || seen.has(section.id) || !['analysis', 'description', 'specification', 'quality'].includes(section.form) || typeof section.label !== 'string' || !section.label.trim() || section.label.length > 160 || !Array.isArray(section.fields) || section.fields.length > 60)
            throw new JobDocumentError('Invalid section');
        seen.add(section.id);
        const fields = new Set<string>();
        for (const field of section.fields) {
            if (!ID.test(field.id) || fields.has(field.id) || !['text', 'longText', 'number', 'date', 'boolean', 'choice'].includes(field.type) || typeof field.required !== 'boolean' || typeof field.label !== 'string' || !field.label.trim() || field.label.length > 160)
                throw new JobDocumentError('Invalid field');
            fields.add(field.id);
            if (field.type === 'choice' && (!Array.isArray(field.options) || !field.options.length || field.options.length > 50 || field.options.some(v => typeof v !== 'string' || !v.trim() || v.length > 160) || new Set(field.options).size !== field.options.length))
                throw new JobDocumentError('Invalid choices');
        }
    }
    // The attached forms cannot be removed or reinterpreted by configuration. Optionality may change.
    for (const original of DEFAULT_FORM.sections) {
        const section = x.sections.find(v => v.id === original.id);
        if (!section || section.form !== original.form || !!section.repeated !== !!original.repeated)
            throw new JobDocumentError('Keep the standard document sections');
        for (const field of original.fields) {
            const stored = section.fields.find(v => v.id === field.id);
            if (!stored || stored.type !== field.type)
                throw new JobDocumentError('Keep standard field identifiers and types');
        }
    }
    return structuredClone(x);
}
export function validateAnswers(def: FormDefinition, answers: Answers, complete = false): void {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || JSON.stringify(answers).length > 750000)
        throw new JobDocumentError('Invalid document answers');
    for (const key of Object.keys(answers))
        if (!def.sections.some(s => s.id === key))
            throw new JobDocumentError('Unknown document section');
    for (const section of def.sections) {
        const rows = answers[section.id] ?? [];
        if (!Array.isArray(rows) || rows.length > (section.repeated ? 100 : 1))
            throw new JobDocumentError(`Invalid rows: ${section.label}`);
        if (complete && section.fields.some(f => f.required) && !rows.length)
            throw new JobDocumentError(`Complete ${section.label}`);
        for (const row of rows) {
            if (!row || typeof row !== 'object' || Array.isArray(row))
                throw new JobDocumentError('Invalid row');
            for (const key of Object.keys(row))
                if (!section.fields.some(f => f.id === key))
                    throw new JobDocumentError('Unknown document field');
            for (const field of section.fields) {
                const v = row[field.id];
                const empty = v === undefined || v === '';
                if (empty) {
                    if (complete && field.required)
                        throw new JobDocumentError(`Complete ${section.label}: ${field.label}`);
                    continue;
                }
                if (field.type === 'boolean' ? typeof v !== 'boolean' : field.type === 'number' ? typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1000000000 : typeof v !== 'string' || v.length > (field.type === 'longText' ? 12000 : 2000))
                    throw new JobDocumentError(`Invalid ${field.label}`);
                if (field.type === 'date' && !validDate(String(v)))
                    throw new JobDocumentError(`Invalid ${field.label}`);
                if (field.type === 'choice' && !field.options?.includes(String(v)))
                    throw new JobDocumentError(`Choose ${field.label}`);
                if (field.id === 'time' && field.type === 'number' && (Number(v) < 0 || Number(v) > 100))
                    throw new JobDocumentError('Time allocation must be between 0 and 100');
            }
        }
        if (complete && ['tasks', 'responsibilities'].includes(section.id) && rows.some(r => r.time !== undefined && r.time !== '')) {
            if (rows.some(r => typeof r.time !== 'number') || Math.abs(rows.reduce((n, r) => n + Number(r.time), 0) - 100) > 0.001)
                throw new JobDocumentError(`${section.label}: complete the time distribution to total 100%`);
        }
    }
}
export function validDate(value: string): boolean { if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false; const d = new Date(`${value}T12:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value; }
export function validateInput(x: JobInput, definition: FormDefinition, complete = false): void {
    if (!x || typeof x.title !== 'string' || !x.title.trim() || x.title.length > 200 || typeof x.jobCode !== 'string' || !normalizedJobCode(x.jobCode) || x.jobCode.length > 80 || typeof x.owner !== 'string' || x.owner.length > 200 || typeof x.reason !== 'string' || x.reason.length > 2000)
        throw new JobDocumentError('Enter a Job ID, title and valid document details');
    if (!x.org || typeof x.org !== 'object' || Object.entries(x.org).some(([k, v]) => !['businessUnit', 'department', 'section', 'team', 'position', 'grade', 'family', 'location', 'reportsTo', 'employmentType'].includes(k) || typeof v !== 'string' || v.length > 200))
        throw new JobDocumentError('Invalid organizational assignment');
    for (const day of [x.effectiveOn, x.reviewOn])
        if (day && !validDate(day))
            throw new JobDocumentError('Choose valid document dates');
    if (x.effectiveOn && x.reviewOn && x.reviewOn < x.effectiveOn)
        throw new JobDocumentError('Review date cannot precede effective date');
    if (!Array.isArray(x.reviewerIds) || x.reviewerIds.length > 20 || new Set(x.reviewerIds).size !== x.reviewerIds.length)
        throw new JobDocumentError('Choose valid reviewers');
    if (complete && (!x.owner.trim() || !x.effectiveOn || !x.reviewOn || !x.approverId || !x.reviewerIds.length))
        throw new JobDocumentError('Set the owner, reviewers, approver, effective date and next review date');
    validateAnswers(definition, x.answers, complete);
}
