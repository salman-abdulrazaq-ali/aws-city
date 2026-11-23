// Hands-on workshops (shared/workshops.json): step by step, each step a command for the practice terminal
// (src/learning/terminal.ts) or AWS CloudShell, checked for real by the server (contract v2.10 workshop.verify) or
// ticked by the player. Text taken from an AWS workshop carries its source and licence; the rest is ours.
import data from '../../shared/workshops.json' with { type: 'json' };
import type { TerminalError, TerminalStep } from '@/learning/terminal';

export interface WorkshopStep {
  id: string;
  title: string;
  body: string;
  /** The command, with `<placeholders>` (absent for a console-only step). */
  cli?: string;
  /** Where in the console the same step is done (a console path like "dynamodbv2/home"). */
  consolePath?: string;
  output?: string;
  outputs?: TerminalStep['outputs'];
  itemKey?: string[];
  errors?: TerminalError[];
  verify: { check: string; value: string } | { manual: true };
  /** A tidy-up step (shown with the cleanup checklist). */
  cleanup?: boolean;
}

export interface Workshop {
  id: string;
  title: string;
  serviceId: string;
  level: 100 | 200 | 300;
  minutes: number;
  simple: string;
  costNote: string;
  /** The AWS North talk it follows, when it does. */
  talk?: string;
  /** True when step text comes from the source repo (licence in `source.license`). */
  imported: boolean;
  source: { title: string; url: string; repo?: string; license?: string; attribution?: string };
  steps: WorkshopStep[];
}

export const LICENSES: string[] = data.licenses;
export const WORKSHOPS = data.workshops as Workshop[];
export const workshopById = (id: string) => WORKSHOPS.find((w) => w.id === id);
export const workshopsFor = (serviceId: string) => WORKSHOPS.filter((w) => w.serviceId === serviceId);
export const isChecked = (s: WorkshopStep): s is WorkshopStep & { verify: { check: string; value: string } } => 'check' in s.verify;
/** The step as the practice terminal reads it (undefined for a console-only step). */
export const terminalStep = (s: WorkshopStep): TerminalStep | undefined => (s.cli ? { cli: s.cli, output: s.output ?? '', outputs: s.outputs, itemKey: s.itemKey, errors: s.errors } : undefined);

/** Hosts a workshop's source link may open on: AWS Workshop Studio, AWS docs, and the source repos in AWS's own GitHub orgs. */
const WORKSHOP_HOSTS = ['catalog.workshops.aws', 'workshops.aws', 'docs.aws.amazon.com'];
const GITHUB_ORGS = ['aws-samples', 'awslabs', 'aws', 'aws-ia', 'strands-agents', 'aws-solutions-library-samples'];
export const isWorkshopUrl = (raw: string) => {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    if (WORKSHOP_HOSTS.includes(u.hostname) || u.hostname.endsWith('.workshops.aws')) return true;
    return u.hostname === 'github.com' && GITHUB_ORGS.includes(u.pathname.split('/')[1] ?? '');
  } catch {
    return false;
  }
};

/** The `<x>` placeholders in a command, in order, once each. */
export const placeholdersIn = (cli = '') => [...new Set([...cli.matchAll(/<([a-z0-9-]+)>/gi)].map((m) => m[1]!))];

/**
 * A step's command as you'd type it: placeholders filled from `values`, optional `[…]` parts kept only when `keepOptional`
 * and every placeholder inside them is filled. For real AWS (CloudShell) the optional parts matter: S3 needs
 * `--create-bucket-configuration LocationConstraint=<region>` in every Region but us-east-1, where it must be left out.
 * Seen 22 Nov 2026: "for real" dropped it and left `<bucket>` as typed, so the command failed in Oregon.
 */
export function commandFor(cli: string, values: Record<string, string>, keepOptional: boolean): { text: string; unfilled: string[] } {
  const fill = (s: string) => s.replace(/<([a-z0-9-]+)>/gi, (m, k: string) => values[k]?.trim() || m);
  const text = cli
    .replace(/\[([^\]]*)\]/g, (_, inner: string) => {
      const part = fill(inner);
      // A part with a gap stays out; so does a us-east-1 location constraint, which S3 refuses.
      return keepOptional && !/<[a-z0-9-]+>/i.test(part) && !/LocationConstraint=us-east-1\b/.test(part) ? ` ${part} ` : ' ';
    })
    .replace(/<([a-z0-9-]+)>/gi, (m, k: string) => values[k]?.trim() || m)
    .replace(/\s+/g, ' ')
    .trim();
  return { text, unfilled: placeholdersIn(text) };
}
