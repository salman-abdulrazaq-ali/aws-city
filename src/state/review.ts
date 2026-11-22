// A Well-Architected review of the account, from the citizens' checks (shared/wa-rules.json, server/src/agents/
// findings.ts): one row per pillar, each check either flagging something open or not finding an issue. "No issue
// found" is all it can say: a setting the server couldn't read never raises a finding, so a pass isn't a guarantee.
// A pillar shows the risks its checks found, never a score: the Well-Architected Tool counts risks and scores nothing.
// Pure; src/ui/WaReview.tsx renders it.
import type { CityFinding, PillarKey } from '@/backend/contract';
import { WA_RULES, type WaRule } from '@/world/citizens';

export const PILLAR_ORDER: PillarKey[] = ['operational', 'security', 'reliability', 'performance', 'cost', 'sustainability'];

export interface PillarReview {
  pillar: PillarKey;
  /** Open findings across the pillar's checks. */
  risks: number;
  checks: { rule: WaRule; open: CityFinding[] }[];
}

export function waReview(findings: CityFinding[]): PillarReview[] {
  const open = findings.filter((f) => f.status === 'open');
  return PILLAR_ORDER.map((pillar) => {
    const checks = WA_RULES.filter((r) => r.pillar === pillar).map((rule) => ({ rule, open: open.filter((f) => f.ruleId === rule.id) }));
    return { pillar, risks: checks.reduce((n, c) => n + c.open.length, 0), checks };
  });
}

/** A pillar's line: "no issue found", "1 risk found", "3 risks found". */
export const risksLine = (n: number) => (n === 0 ? 'no issue found' : `${n} ${n === 1 ? 'risk' : 'risks'} found`);
