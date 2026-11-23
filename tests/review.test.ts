import { describe, expect, it } from 'vitest';
import type { CityFinding } from '@/backend/contract';
import { PILLAR_ORDER, risksLine, waReview } from '@/state/review';
import { WA_RULES } from '@/world/citizens';

const finding = (ruleId: string, severity: CityFinding['severity'], status: CityFinding['status'] = 'open') =>
  ({ id: `${ruleId}-x`, ruleId, severity, status, pillar: WA_RULES.find((r) => r.id === ruleId)!.pillar }) as CityFinding;

describe('Well-Architected review', () => {
  it('has every pillar, every rule once, and counts the open findings as risks found, never a score', () => {
    const r = waReview([finding('s3-public-access', 'high'), finding('ebs-default-encryption', 'medium', 'resolved')]);
    expect(r.map((p) => p.pillar)).toEqual(PILLAR_ORDER);
    expect(r.flatMap((p) => p.checks.map((c) => c.rule.id)).sort()).toEqual(WA_RULES.map((x) => x.id).sort());
    const sec = r.find((p) => p.pillar === 'security')!;
    expect(sec.risks).toBe(1);
    expect(sec.checks.find((c) => c.rule.id === 'ebs-default-encryption')!.open).toEqual([]);
    expect(r.find((p) => p.pillar === 'cost')!.risks).toBe(0);
    // The Well-Architected Tool scores no pillar, so neither does the city.
    expect(r.every((p) => !('score' in p))).toBe(true);
  });

  it('says what each pillar found in words', () => {
    expect(risksLine(0)).toBe('no issue found');
    expect(risksLine(1)).toBe('1 risk found');
    expect(risksLine(3)).toBe('3 risks found');
    expect([0, 1, 3].map(risksLine).join(' ')).not.toMatch(/\/100/);
  });
});
