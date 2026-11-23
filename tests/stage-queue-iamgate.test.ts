// Queue Juggler and Permission Gate are scenes, not forms (batch B3a): the city's own sprites on an integer-scaled play
// group in the play column, the desk's colour tokens only, and the same rules, keys and spoken lines as before. Checked
// from the source: a Phaser scene is not practical to run in a test (as in tests/a11y-games.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
/** Code without its comments: comments may name old colours. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** The body of a scene's method, from its signature to the next method at the same indent. */
const method = (src: string, sig: string) => {
  const at = src.indexOf(sig);
  expect(at, sig).toBeGreaterThan(-1);
  const rest = src.slice(at + sig.length);
  const end = rest.search(/\n {2}(private|protected|override|public) /);
  return end < 0 ? rest : rest.slice(0, end);
};
const queue = read('src/game/scenes/games/QueueGame.ts');
const gate = read('src/game/scenes/games/IamGateGame.ts');

describe('no colour of their own: theme tokens, PAL and the district colour', () => {
  for (const [name, src] of [
    ['QueueGame.ts', queue],
    ['IamGateGame.ts', gate],
  ] as const) {
    it(`${name} names no hex colour (pixel borders are PAL.black)`, () => {
      const c = code(src);
      expect(c, name).not.toMatch(/'#[0-9a-f]{3,8}'/i);
      expect(c, name).not.toMatch(/0x[0-9a-f]{6}/i);
      expect(c).toMatch(/from '\.\.\/\.\.\/theme'/);
      expect(c).toMatch(/districtColor\('(sqs|iam)'\)/);
    });
  }
});

describe('a scene with the city’s people and props, at a whole-number scale in the play column', () => {
  it('Queue Juggler: Eddie at the bench, the SQS agent by the tray, parcels and a dead-letter chute', () => {
    const c = code(queue);
    expect(c).toMatch(/import \{[^}]*\bact\b[^}]*\bfitScale\b[^}]*\bperson\b[^}]*\bprop\b[^}]*\} from '\.\/cast'/);
    expect(c).toMatch(/person\(this, 'ec2'/);
    expect(c).toMatch(/person\(this, 'sqs'/);
    expect(c).toMatch(/'pack:data_box_SE'/);
    expect(c).toMatch(/'combo:mail-chute'/);
    // Eddie hammers while busy and idles when free; his chip says which in words, not colour alone.
    expect(method(c, '  private showWorker(free: boolean) {')).toMatch(/act\(this\.worker, free \? 'idle' : 'hammer'/);
    expect(c).toMatch(/'worker · free'/);
    expect(c).toMatch(/'worker · busy'/);
    // Poison is marked ☠, never only by its red chip.
    expect(method(c, '  private parcel(')).toMatch(/poison \? `☠ \$\{text\}` : text/);
    expect(c).toMatch(/this\.s = Math\.min\(fitScale\(/);
    expect(method(c, '  protected setup() {')).toMatch(/this\.column\(/);
  });

  it('Permission Gate: the IAM landmark, a paper notice board, IAM checking at the boom, citizens with tickets', () => {
    const c = code(gate);
    expect(c).toMatch(/import \{[^}]*\bcast\b[^}]*\bfitScale\b[^}]*\blandmarkFrame\b[^}]*\bperson\b[^}]*\bprop\b[^}]*\} from '\.\/cast'/);
    expect(c).toMatch(/landmarkFrame\('iam'\)/);
    expect(c).toMatch(/person\(this, 'iam', [^)]*'check', 'SW'\)/);
    expect(c).toMatch(/this\.crowd = cast\(/);
    expect(c).toMatch(/PAL\.paper\b/);
    expect(c).toMatch(/'Policy', TXT\(14, PAL\.paperMeta\)/);
    // The ticket is paper, the boom lifts for an Allow (set, not tweened, under reduced motion).
    expect(method(c, '  private next() {')).toMatch(/backgroundColor: CSS\.paper/);
    const send = method(c, '  private send(through: boolean) {');
    expect(send).toMatch(/if \(reducedMotion\(\)\) \{[\s\S]*setRotation/);
    expect(c).toMatch(/this\.s = Math\.min\(fitScale\(/);
    expect(method(c, '  protected setup() {')).toMatch(/this\.column\(/);
  });
});

describe('the rules, keys and spoken lines are unchanged', () => {
  it('Queue Juggler: Space queues, D dead-letters, the chute is a tap target, drags end on it; same timing and tray', () => {
    const c = code(queue);
    expect(c).toMatch(/const WORK_MS = 800;/);
    expect(c).toMatch(/if \(k === ' '\) this\.decide\(f, false\);\s*else if \(k === 'd' \|\| k === 'D'\) this\.decide\(f, true\);/);
    expect(c).toMatch(/\.zone\([^)]*\)\s*\.setInteractive\(\{ useHandCursor: true \}\)/);
    expect(c).toMatch(/setInteractive\(\{ useHandCursor: true, draggable: true \}\)/);
    expect(c).toMatch(/c\.on\('dragstart', \(\) => \(tw\.pause\(\)/);
    expect(c).toMatch(/this\.decide\(entry, this\.dlqZone\.contains\(ptr\.x, ptr\.y\)\)/);
    expect(method(c, '  private enqueue(')).toMatch(/this\.queued\.length > 12/);
    expect(method(c, '  private spawn(poison: boolean) {')).toMatch(/this\.speak\(`\$\{poison \? 'Poison message' : 'Message'\}: \$\{label\}\.`, true\)/);
    const decide = method(c, '  private decide(e: Live, toDlq: boolean) {');
    expect(decide.match(/this\.speak\(/g)?.length).toBe(4);
    for (const line of ["'Right: poison to the dead-letter queue.'", "'Wrong: a good message thrown away.'", "'Wrong: poison fails over and over. Send poison to the dead-letter queue with D.'", '`Queued. ${this.queued.length} in the queue.`'])
      expect(decide).toContain(`this.speak(${line})`);
    const arrive = method(c, '  private arrive(');
    expect(arrive.match(/this\.speak\(/g)?.length).toBe(2);
    expect(arrive).toContain('this.speak(`Poison reached the worker and fails forever. Score ${this.score}.`)');
    expect(arrive).toContain("this.speak(`Lost: the worker was busy and it wasn't queued. Score ${this.score}.`)");
    for (const k of ['dlq', 'wrong', 'poisoned', 'lost', 'direct', 'worked', 'overflow']) expect(c).toContain(`POINTS.queue.${k}`);
  });

  it('Permission Gate: A or ← allows, D or → denies, the clock with pace, the verdict under the boom, the same lines', () => {
    const c = code(gate);
    expect(c).toMatch(/if \(k === 'a' \|\| k === 'A' \|\| k === 'ArrowLeft'\) this\.answer\(true\);/);
    expect(c).toMatch(/if \(k === 'd' \|\| k === 'D' \|\| k === 'ArrowRight'\) this\.answer\(false\);/);
    expect(c).toMatch(/'✅ Allow \(A\)', \(\) => this\.answer\(true\)/);
    expect(c).toMatch(/'⛔ Deny \(D\)', \(\) => this\.answer\(false\)/);
    expect(method(c, '  private next() {')).toMatch(/this\.time\.delayedCall\(pace\(Math\.max\(2600, 5200 - this\.wave \* 400\)\), \(\) => this\.answer\(undefined\)\)/);
    expect(method(c, '  private next() {')).toContain('this.speak(`Request: ${this.current.text}. A allows, D denies.`, true)');
    expect(method(c, '  private nextWave() {')).toContain("this.speak(`New role: ${wv.role}. Its policy: ${wv.policy.join('. ')}.`, true)");
    const answer = method(c, '  private answer(allow: boolean | undefined) {');
    expect(answer).toMatch(/this\.verdict\(x, y, `✓ \$\{c\.why\}`, FEEDBACK\.right/);
    expect(answer).toMatch(/this\.verdict\(x, y, `✗ \$\{allow === undefined \? 'Too slow\. ' : ''\}\$\{c\.why\}`, FEEDBACK\.wrong/);
    expect(answer).toMatch(/const y = this\.verdictY;/);
    for (const k of ['right', 'wrong', 'slow']) expect(answer).toContain(`POINTS.iamgate.${k}`);
    // The board is as tall as the longest policy, so the gate never moves between roles; the verdict sits below the boom.
    const setup = method(c, '  protected setup() {');
    expect(setup).toMatch(/IAM_GATE\.waves\.map\(\(wv\) => this\.policyLines\(wv\.policy\)\)/);
    expect(setup).toMatch(/this\.verdictY = boomY \+/);
    expect(setup).toMatch(/this\.cardAt = yardTop \+/);
  });
});
