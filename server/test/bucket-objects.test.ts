import { describe, expect, it } from 'vitest';
import { agentSystemPrompt } from '../src/agents/personas.js';
import { CHAT_CAN_DO } from '../src/contract/orchestrator.js';
import { RULES } from '../src/guard/rules.js';

// Seen 23 Nov 2026: asked to check the objects in a bucket made in the console, Sally said she couldn't because the city
// didn't build it. The real reason: the city never reads any bucket's objects, so every agent and chat answer says that.
describe('the city never sees inside a bucket', () => {
  it('has no way to list or read objects', () => {
    expect(Object.keys(RULES).filter((c) => /Object/.test(c) && /^(List|Get|Head)/.test(c))).toEqual([]);
  });
  it('and every agent and chat answer says so, pointing to the S3 console', () => {
    expect(agentSystemPrompt('s3')).toMatch(/never see inside a bucket[\s\S]*Objects tab/);
    expect(agentSystemPrompt('ec2')).toMatch(/never see inside a bucket/);
    expect(CHAT_CAN_DO).toMatch(/never sees inside a bucket[\s\S]*Objects tab in the S3 console/);
  });
});
