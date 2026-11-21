import { describe, expect, it } from 'vitest';
import { agentSystemPrompt, CONCIERGE_PROMPT, lookoutPrompt } from '../src/agents/personas.js';
import { NO_SECRETS_RULE, redactSecrets } from '../src/secrets.js';

describe('player text never carries credentials to a model', () => {
  it('takes out access keys, secret keys, session tokens and emails', () => {
    // AWS's documented example credentials.
    const out = redactSecrets('my key is AKIAIOSFODNN7EXAMPLE and secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, mail me at a@b.co');
    expect(out).not.toMatch(/AKIAIOSFODNN7EXAMPLE|wJalrXUtnFEMI|a@b\.co/);
    expect(out).toContain('[access key]');
    expect(out).toContain('[secret key]');
    expect(out).toContain('[email]');
    expect(redactSecrets(`token ${'A1b2'.repeat(40)}`)).toBe('token [token]');
  });

  it('keeps what the agents need: bucket names, ARNs, instance types, account-free text', () => {
    for (const keep of ['create a bucket called my-very-long-bucket-name-for-the-workshop-2026', 'launch a t4g.nano', 'arn:aws:s3:::my-bucket', 'what is a VPC?'])
      expect(redactSecrets(keep)).toBe(keep);
  });

  it('every persona carries the never-ask-for-secrets rule', () => {
    for (const p of [agentSystemPrompt('s3'), CONCIERGE_PROMPT, lookoutPrompt]) expect(p).toContain(NO_SECRETS_RULE);
  });
});
