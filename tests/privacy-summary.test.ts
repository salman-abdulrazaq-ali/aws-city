// The privacy policy opens with a short plain summary for parents (Dana): what's kept, what's never collected, the AI
// and Jev, how to export and delete, and children. Every full section and the setup wizard's placeholders stay.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const policy = readFileSync('docs/privacy-policy.md', 'utf8');

describe('privacy policy summary', () => {
  it('comes first, in plain words, and covers what a parent asks', () => {
    const start = policy.indexOf('## In short (for parents and guardians)');
    const end = policy.indexOf('## Who runs this service');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(end);
    const summary = policy.slice(start, end);
    for (const topic of ['demo needs no account', 'What we keep', 'What we never collect', 'The AI', 'Jev', 'Download my data', 'Delete my account', 'Children', 'under 13'])
      expect(summary, topic).toContain(topic);
    expect(summary).toContain('{{CONTACT_EMAIL}}');
    // short: a parent reads it in a minute
    expect(summary.split('\n').length).toBeLessThan(30);
  });

  it('keeps every full section and the placeholders the setup wizard fills', () => {
    for (const h of ['## Who runs this service', '## Children', '## What we store', '## What we process but don\'t keep', '## Network and security logs', '## Browser permissions', '## Deleting your data', '## Contact'])
      expect(policy, h).toContain(h);
    for (const p of ['{{OPERATOR_NAME}}', '{{CONTACT_EMAIL}}', '{{REGION}}']) expect(policy).toContain(p);
  });
});
