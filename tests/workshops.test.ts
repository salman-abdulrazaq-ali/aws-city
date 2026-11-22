// Hands-on workshops (shared/workshops.json): licensed sources, unique steps, checks the server knows, and every
// command and taught mistake proven against the practice terminal (src/learning/terminal.ts).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run, tokenize } from '@/learning/terminal';
import { honestMode, PRACTICE_STEP_XP, REAL_STEP_XP, stepReward } from '@/learning/workshopRewards';
import { LICENSES, WORKSHOPS, isChecked, isWorkshopUrl, terminalStep, commandFor, placeholdersIn } from '@/world/workshops';
import { SERVICES } from '@/world/taxonomy';
import conference from '../shared/conference.json' with { type: 'json' };

// The server's check registry can't be imported from the client tsconfig, so read its keys from the source.
const checksSrc = fs.readFileSync(path.resolve(__dirname, '../server/src/workshops/checks.ts'), 'utf8');
const CHECKS = new Set([...checksSrc.matchAll(/^\s*'([a-z-]+)': \{ kind:/gm)].map((m) => m[1]));

const PLACEHOLDER = /<([a-z0-9-]+)>/gi;
/** The step's own command as a player would type it: every placeholder filled, optional groups included. */
const filled = (cli: string) => cli.replace(PLACEHOLDER, (_, n: string) => `demo-${n}`).replace(/\[([^\]]+)\]/g, '$1');
const quote = (t: string) => `'${t.replace(/'/g, `'\\''`)}'`;
const line = (tokens: string[]) => tokens.map(quote).join(' ');

/**
 * A value that trips each taught mistake whose `when` matches a flag's value (keyed workshop/step/code), or the values
 * to set for several flags at once.
 */
const TRIGGERS: Record<string, string | Record<string, string>> = {
  'dynamodb-first-table/create/ResourceInUseException': 'city-demo',
  'dynamodb-first-table/put/One or more parameter values were invalid': '{"total":{"N":"42"}}',
  's3-first-bucket/create/BucketAlreadyExists': 'my-bucket',
  's3-first-bucket/create/InvalidBucketName': 'My_Bucket',
  's3-first-bucket/create/The unspecified location constraint': 'us-west-2',
  's3-first-bucket/create/IllegalLocationConstraintException': 'us-west-2',
  's3-first-bucket/create/InvalidLocationConstraint': { '--create-bucket-configuration': 'LocationConstraint=us-east-1', '--region': 'us-east-1' },
  's3-first-bucket/download/NoSuchKey': 'Sample.txt',
  'ec2-first-instance/ssh/0.0.0.0/0': '0.0.0.0/0',
  'ec2-first-instance/launch/HttpTokens=optional': 'HttpTokens=optional,HttpEndpoint=enabled',
  'durable-first-function/create/InvalidParameterValueException': '{"RetentionPeriodInDays": 1}',
  'durable-first-function/invoke/qualified': 'demo-function',
  'lmi-capacity-provider/function/MemorySize': '1024',
  'saas-tenant-isolation/tenant-a/One or more parameter values were invalid': '{"sk":{"S":"invoice#1"}}',
  'saas-tenant-isolation/read/AccessDeniedException': '{"tenantId":{"S":"tenant-b"},"sk":{"S":"invoice#1"}}',
};

describe('workshops', () => {
  it('have unique ids, real services, a talk that exists, sane sizes and levels', () => {
    const ids = WORKSHOPS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    const services = new Set(SERVICES.map((s) => s.id));
    const talks = new Set(conference.talks.map((t) => t.id));
    for (const w of WORKSHOPS) {
      expect(services.has(w.serviceId), w.id).toBe(true);
      if (w.talk) expect(talks.has(w.talk), w.id).toBe(true);
      expect([100, 200, 300]).toContain(w.level);
      expect(w.minutes, w.id).toBeGreaterThan(0);
      expect(w.simple.length, w.id).toBeLessThanOrEqual(110);
      expect(w.costNote.length, w.id).toBeGreaterThan(10);
      expect(w.steps.length, w.id).toBeGreaterThanOrEqual(5);
      expect(w.steps.length, w.id).toBeLessThanOrEqual(8);
      expect(new URL(w.source.url).protocol, w.id).toBe('https:');
      expect(JSON.stringify(w), w.id).not.toMatch(/—/);
    }
  });

  it('copy text only from a licensed repo, and credit it', () => {
    for (const w of WORKSHOPS.filter((x) => x.imported)) {
      expect(LICENSES, w.id).toContain(w.source.license);
      expect(w.source.repo, w.id).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
      expect(w.source.attribution?.length, w.id).toBeGreaterThan(3);
    }
  });

  it('steps are unique, short, and checked only by checks the server has, on a placeholder of their own command', () => {
    expect(CHECKS.size).toBeGreaterThan(5);
    for (const w of WORKSHOPS) {
      const stepIds = w.steps.map((s) => s.id);
      expect(new Set(stepIds).size, w.id).toBe(stepIds.length);
      for (const s of w.steps) {
        const where = `${w.id}/${s.id}`;
        expect(s.body.length, where).toBeLessThanOrEqual(280);
        expect(s.cli || s.consolePath || s.body, where).toBeTruthy();
        if (isChecked(s)) {
          expect(CHECKS.has(s.verify.check), `${where}: ${s.verify.check}`).toBe(true);
          expect(s.cli, where).toContain(`<${s.verify.value}>`);
        } else expect(s.verify, where).toEqual({ manual: true });
        for (const e of s.errors ?? []) {
          for (const k of ['code', 'message', 'explain', 'fix'] as const) expect(e[k]?.trim().length, `${where} ${e.code} ${k}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('every command runs cleanly in the practice terminal, and every taught mistake can be made there', () => {
    for (const w of WORKSHOPS)
      for (const s of w.steps) {
        const t = terminalStep(s);
        if (!t) continue;
        const where = `${w.id}/${s.id}`;
        const tokens = tokenize(filled(t.cli));
        expect(run(line(tokens), t).kind, where).toBe('ok');
        for (const e of t.errors ?? []) {
          if (!e.when) continue;
          let attempt = [...tokens];
          // Every condition holds at once: the flag left out, and the flag's value (or values) set.
          if (e.when.missing) {
            const i = attempt.indexOf(e.when.missing);
            expect(i, `${where}: ${e.when.missing} is in the command`).toBeGreaterThan(-1);
            attempt.splice(i, i + 1 < attempt.length && !attempt[i + 1].startsWith('--') ? 2 : 1);
          }
          if (e.when.flag) {
            const trigger = TRIGGERS[`${where}/${e.code}`];
            expect(trigger, `${where}: add a trigger for ${e.code}`).toBeDefined();
            const set = typeof trigger === 'string' ? { [e.when.flag]: trigger } : trigger;
            for (const [flag, value] of Object.entries(set)) {
              const i = attempt.indexOf(flag);
              if (i === -1) attempt = [...attempt, flag, value];
              else attempt[i + 1] = value;
            }
          }
          const r = run(line(attempt), t);
          expect(r.kind, `${where}: ${e.code}`).toBe('error');
          if (r.kind === 'error') expect(r.error, `${where}: ${e.code}`).toBe(e);
        }
      }
  });

  it('every source link opens (AWS Workshop Studio, AWS docs or an AWS GitHub org), and nothing else does', () => {
    for (const w of WORKSHOPS) {
      expect(isWorkshopUrl(w.source.url), `${w.id}: ${w.source.url}`).toBe(true);
      if (w.source.repo) expect(isWorkshopUrl(w.source.repo), `${w.id}: ${w.source.repo}`).toBe(true);
    }
    expect(isWorkshopUrl('https://github.com/someone/fork')).toBe(false);
    expect(isWorkshopUrl('http://catalog.workshops.aws/x')).toBe(false);
    expect(isWorkshopUrl('https://workshops.aws.evil.example/')).toBe(false);
  });

  it('pays each step once per mode, with no daily ledger (a workshop done in one sitting pays in full)', () => {
    expect(stepReward(undefined, 'a', 'practice')).toBe(PRACTICE_STEP_XP);
    expect(stepReward({ steps: { a: 'practice' } }, 'a', 'real')).toBe(REAL_STEP_XP - PRACTICE_STEP_XP);
    expect(stepReward({ steps: { a: 'real' } }, 'a', 'practice')).toBe(0);
    expect(stepReward({ steps: { a: 'practice' } }, 'a', 'practice')).toBe(0);
    // Every step of a run pays in full, however many come the same day.
    const steps = ['a', 'b', 'c', 'd'];
    let prev: { steps: Record<string, 'practice' | 'real'> } = { steps: {} };
    const paid = steps.map((id) => {
      const n = stepReward(prev, id, 'practice');
      prev = { steps: { ...prev.steps, [id]: 'practice' } };
      return n;
    });
    expect(paid).toEqual(steps.map(() => PRACTICE_STEP_XP));
  });

  it('a hint costs a star on its step (a paying step still pays one), and the demo is never "for real"', () => {
    expect(stepReward(undefined, 'a', 'practice', 1)).toBe(PRACTICE_STEP_XP - 1);
    expect(stepReward(undefined, 'a', 'practice', 9)).toBe(1);
    expect(stepReward({ steps: { a: 'practice' } }, 'a', 'practice', 1)).toBe(0);
    expect(stepReward(undefined, 'a', 'real', 2)).toBe(REAL_STEP_XP - 2);
    expect(honestMode('real', true)).toBe('practice');
    expect(honestMode('real', false)).toBe('real');
  });
});

describe('commandFor: the command as typed (practice) or run (real AWS)', () => {
  const S3 = 'aws s3api create-bucket --bucket <bucket> [--create-bucket-configuration LocationConstraint=<region>]';
  it('for real, keeps an optional part once its names are filled: S3 needs its Region outside us-east-1', () => {
    expect(commandFor(S3, { bucket: 'b1', region: 'us-west-2' }, true)).toEqual({ text: 'aws s3api create-bucket --bucket b1 --create-bucket-configuration LocationConstraint=us-west-2', unfilled: [] });
    expect(commandFor(S3, { bucket: 'b1', region: 'us-east-1' }, true)).toEqual({ text: 'aws s3api create-bucket --bucket b1', unfilled: [] });
  });
  it('a name not typed yet stays as <x> and is listed; an optional part with a gap stays out', () => {
    expect(commandFor(S3, { region: 'eu-west-2' }, true)).toEqual({ text: 'aws s3api create-bucket --bucket <bucket> --create-bucket-configuration LocationConstraint=eu-west-2', unfilled: ['bucket'] });
    expect(commandFor(S3, { bucket: 'b1' }, true)).toEqual({ text: 'aws s3api create-bucket --bucket b1', unfilled: [] });
  });
  it('practice drops the optional parts, as before', () => {
    expect(commandFor(S3, { bucket: 'b1', region: 'us-west-2' }, false).text).toBe('aws s3api create-bucket --bucket b1');
    expect(placeholdersIn(S3)).toEqual(['bucket', 'region']);
  });
});
