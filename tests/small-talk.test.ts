// Seen live, 23 Nov 2026: "Eddie, how are you?" typed in the city's request box was planned as "launch a t4g.nano
// called Eddie". Small talk goes to that agent's HQ chat; every request stays a task.
import { describe, expect, it } from 'vitest';
import { smallTalkTo } from '@/state/smallTalk';
import { FEATURED_REQUESTS, serviceById } from '@/world/taxonomy';

const district = (serviceId: string) => serviceById(serviceId)!.districtId;

describe('small talk in the request box', () => {
  it('a greeting or a social question goes to the named agent’s HQ', () => {
    expect(smallTalkTo('Eddie, how are you?')).toEqual({ districtId: district('ec2') });
    expect(smallTalkTo('Hey Eddie')).toEqual({ districtId: district('ec2') });
    expect(smallTalkTo('Thanks Eddie!')).toEqual({ districtId: district('ec2') });
    expect(smallTalkTo('How’s it going, Sally?')).toEqual({ districtId: district('s3') });
    expect(smallTalkTo('Good morning Sir Shieldon')).toEqual({ districtId: district('shield') });
    expect(smallTalkTo('Who are you, Dyna?')).toEqual({ districtId: district('dynamodb') });
  });

  it('with no agent named: the service it mentions, then the picked building, then the AI district', () => {
    expect(smallTalkTo('Hi S3, what can you do?')).toEqual({ districtId: district('s3') });
    expect(smallTalkTo('hello', 'lambda')).toEqual({ districtId: district('lambda') });
    expect(smallTalkTo('hi')).toEqual({ districtId: district('bedrock') });
  });

  it('anything that asks for a change, or isn’t small talk, stays a task', () => {
    for (const request of [
      'Hello! Create a bucket called photos-1',
      'Hi Eddie, launch a small server',
      'How are you going to store my photos?',
      'Thanks, now delete the bucket jev-test-1',
      'Terminate i-0123456789abcdef0',
      'What is S3?',
      'Eddie',
      'Hi Eddie, can you tell me which of my servers are running in Oregon right now please',
    ])
      expect(smallTalkTo(request), request).toBeUndefined();
  });

  it('every featured request on Home stays a task', () => {
    for (const f of FEATURED_REQUESTS) expect(smallTalkTo(f.prompt), f.prompt).toBeUndefined();
  });
});
