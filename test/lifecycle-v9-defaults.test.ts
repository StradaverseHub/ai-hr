import { expect, it } from 'vitest';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { parseV9Config, validateV9ConfigChange } from '../lib/lifecycle-v9-validation';

it('imports the complete supplied definitions without fixture users or cases', () => {
  const config = v9Defaults();
  expect(config.templates).toHaveLength(7); expect(config.emails).toHaveLength(8);
  expect(config.checklists).toHaveLength(6); expect(config.workflows).toHaveLength(15);
  expect(config.groups.every(g => g.members.length === 0)).toBe(true);
  expect(config.workflows.filter(w => w.status === 'draft')).toHaveLength(2);
  expect(config.workflows.find(w => w.id === 'w4')?.steps.map(s => s.type)).toEqual(['doc', 'waitSign']);
  expect(config.emails.find(e => e.id === 'e3')?.cc).toEqual(['supervisor', 'pbp']);
  expect(config.checklists.find(c => c.id === 'oc1')?.tasks.some(t => t.documentTemplate === 'txi')).toBe(true);
  expect(config.templates.find(t => t.id === 'tsv')?.versions.at(-1)?.fields).toHaveLength(48);
});
it('protects published history while allowing a new draft', () => {
  const previous = v9Defaults(), next = structuredClone(previous);
  const template = next.templates.find(t => t.versions.some(v => v.state === 'published'))!;
  const published = template.versions.find(v => v.state === 'published')!;
  const draft = structuredClone(published); draft.version = Math.max(...template.versions.map(v => v.version)) + 1; draft.state = 'draft';
  template.versions = template.versions.filter(v => v.state !== 'draft'); template.versions.push(draft);
  expect(() => validateV9ConfigChange(previous, next)).not.toThrow();
  published.blocks[0].text += 'changed';
  expect(() => validateV9ConfigChange(previous, next)).toThrow('immutable');
});
it('rejects cross-module workflow links and duplicate form identifiers', () => {
  const config = v9Defaults(), onb = config.workflows.find(w => w.module === 'onb')!, off = config.templates.find(t => t.module === 'off')!;
  onb.steps = [{ id: 'bad', type: 'doc', template: off.id, release: true }];
  expect(() => parseV9Config(config)).toThrow('same module');
  const other = v9Defaults(), version = other.templates.find(t => t.versions.some(v => v.fields.length))!.versions.find(v => v.fields.length)!;
  version.fields.push(structuredClone(version.fields[0]));
  expect(() => parseV9Config(other)).toThrow('Duplicate form field');
});
it('preserves real assignment groups by identity and rejects duplicate definitions', () => {
  const config = v9Defaults([{ id: 'g-people', name: 'HR Ops', members: ['11111111-1111-4111-8111-111111111111'], limit: 7 }]);
  expect(config.groups.find(g => g.id === 'g-people')).toMatchObject({ members: ['11111111-1111-4111-8111-111111111111'], limit: 7 });
  config.workflows.push(config.workflows[0]); expect(() => parseV9Config(config)).toThrow('Duplicate workflow');
});
it('links supplied Facility tasks to the existing group identity', () => {
  const config = v9Defaults([{ id: 'facility', name: 'Facility', members: [], limit: 8 }]);
  expect(config.groups.some(g => g.id === 'g-facility')).toBe(false);
  expect(config.checklists.flatMap(c => c.tasks).filter(t => t.group === 'facility')).toHaveLength(2);
});

it('saves incomplete workflow drafts but independently rejects making them live', () => {
  const config = v9Defaults();
  const workflow = config.workflows[0];
  workflow.status = 'draft'; workflow.steps = [{ id: 'draft-step', type: 'doc', template: '', release: false }];
  expect(() => parseV9Config(config)).not.toThrow();
  workflow.status = 'published';
  expect(() => parseV9Config(config)).toThrow('choose a template');
  workflow.steps = [];
  expect(() => parseV9Config(config)).toThrow('Add at least one step');
});
it('deletes only an unused non-current version with canonical usage evidence', () => {
  const previous = v9Defaults(), template = previous.templates[0];
  template.versions = [1,2,3].map(version => ({ ...structuredClone(template.versions[0]), version, state: 'published' as const })); template.currentVersion = 2;
  const next = structuredClone(previous); next.templates[0].versions = next.templates[0].versions.filter(version => version.version !== 3);
  expect(() => validateV9ConfigChange(previous, next)).toThrow('history');
  expect(() => validateV9ConfigChange(previous, next, [])).not.toThrow();
  expect(() => validateV9ConfigChange(previous, next, [{ templateId: template.id, version: 3, documents: 1 }])).toThrow('history');
  const current = structuredClone(previous); current.templates[0].versions = current.templates[0].versions.filter(version => version.version !== 2); current.templates[0].currentVersion = 1;
  expect(() => validateV9ConfigChange(previous, current, [])).toThrow('in use');
  const deleted = structuredClone(previous); deleted.templates.shift();
  expect(() => validateV9ConfigChange(previous, deleted, [])).not.toThrow();
  expect(() => validateV9ConfigChange(previous, deleted, [{ templateId: template.id, version: 1, documents: 1 }])).toThrow('Retire');
});

it('allows turning an email off while protecting new or edited live workflow activation', () => {
  const previous = v9Defaults(), next = structuredClone(previous);
  const workflow = next.workflows.find(workflow => workflow.status === 'published' && workflow.steps.some(step => step.type === 'email'))!;
  const step = workflow.steps.find(step => step.type === 'email')!;
  if (step.type !== 'email') throw Error('Expected email step');
  next.emails.find(email => email.id === step.template)!.active = false;
  expect(() => parseV9Config(next, previous)).not.toThrow();
  expect(parseV9Config(next, previous).emails.find(email => email.id === step.template)?.active).toBe(false);
  expect(() => parseV9Config(next)).toThrow('active email');
  workflow.name += ' changed';
  expect(() => parseV9Config(next, previous)).toThrow('active email');
  workflow.status = 'draft';
  expect(() => parseV9Config(next, previous)).not.toThrow();
});
