// The practice terminal behind a workshop step (pure, no AWS). The player types the step's command; we read it the way a
// shell would (quotes, `\` line breaks), then compare it with the step's expected command: the same words in the same
// order (`aws lambda create-function`), and every expected flag present in any order. A `<name>` in the expected
// command takes any value and is captured, so the simulated output can echo it back (`{{name}}`). A flag in brackets
// (`[--description <text>]`) may be left out. A known mistake (a missing flag, a wrong value) answers with the error the
// real CLI prints and a teaching note; pasting a real error runs through the same list (`explainError`). Only an
// argument the real CLI requires (`CLI_REQUIRED`) gets its ParamValidation error when it's left out; a flag the step
// uses but the CLI doesn't require gets a coaching line in the game's voice, never a made-up CLI error.

export interface TerminalError {
  /** The error code or text the real CLI prints (`AccessDeniedException`, `ResourceConflictException`). */
  code: string;
  /** What the terminal prints when the mistake happens in practice; `{{name}}` takes the value given for `<name>`. */
  message: string;
  /**
   * When practice triggers it; every condition given must hold: a flag left out, a flag given a value that matches the
   * pattern, a `<name>` the command uses twice given two different values (`mismatch`).
   */
  when?: { missing?: string; flag?: string; value?: string; mismatch?: string };
  explain: string;
  fix: string;
  /**
   * A command that does the fix, shown with its own Copy under the explanation (`<placeholders>` filled from the step's
   * names). Seen 24 Nov 2026: "I expected to have a code to do it, ready", after BucketNotEmpty said "list … delete each".
   */
  fixCli?: string;
}

export interface TerminalStep {
  /** The expected command, with `<placeholders>` and optional `[--flag value]` groups. */
  cli: string;
  /** What a successful run prints; `{{name}}` takes the value the player gave for `<name>`. */
  output: string;
  /** What a successful run prints instead when a flag's value matches (`--region` us-east-1); the first match wins. */
  outputs?: { when: { flag: string; value: string }; output: string }[];
  /** `--item` may be any well-formed DynamoDB item that carries these key attributes, not only the step's own. */
  itemKey?: string[];
  errors?: TerminalError[];
}

/** A line in the game's own voice (a coaching note), not something the real CLI prints. */
export const isCoaching = (text: string) => text.startsWith('Practice terminal:');

export type RunResult =
  | { kind: 'ok'; output: string; values: Record<string, string> }
  | { kind: 'error'; output: string; error: TerminalError }
  | { kind: 'other'; output: string }
  | { kind: 'empty' };

/** Splits a command line like a POSIX shell: quotes group, `\` escapes, a backslash-newline continues the line. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  const src = line.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) cur += src[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < src.length) {
      cur += src[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

interface Parsed {
  words: string[];
  flags: Map<string, string | true>;
  /** Positional arguments after the flags (`get-object … downloaded-sample.txt`), a shell redirect (`> key.pem`) left out. */
  rest: string[];
}

/** Positional words until the first flag; `--flag value`, `--flag=value` or a bare `--flag` after that. */
function parse(all: string[]): Parsed {
  // `> file` is the shell's, not the CLI's.
  const tokens = all.includes('>') ? all.slice(0, all.indexOf('>')) : all;
  const words: string[] = [];
  const rest: string[] = [];
  const flags = new Map<string, string | true>();
  let i = 0;
  while (i < tokens.length && !tokens[i].startsWith('-')) words.push(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i++];
    if (!t.startsWith('-')) {
      rest.push(t);
      continue;
    }
    const eq = t.indexOf('=');
    if (eq > 0) flags.set(t.slice(0, eq), t.slice(eq + 1));
    else if (i < tokens.length && !tokens[i].startsWith('--')) flags.set(t, tokens[i++]);
    else flags.set(t, true);
  }
  return { words, flags, rest };
}

interface Expected extends Parsed {
  optional: Set<string>;
}

/** The expected command, with `[ ... ]` groups marking optional flags. */
function expected(cli: string): Expected {
  const optional = new Set<string>();
  // `[--flag value]` is an optional group; a JSON array in a value (`'[{"Create":…}]'`) is not.
  const plain = cli.replace(/\[(--[^\]]+)\]/g, (_, inner: string) => {
    for (const t of tokenize(inner)) if (t.startsWith('--')) optional.add(t.split('=')[0]);
    return inner;
  });
  return { ...parse(tokenize(plain)), optional };
}

const PLACEHOLDER = /<([a-z0-9-]+)>/gi;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * One expected word or value against what the player typed: `<name>` parts take any non-empty text (and are captured
 * into `values`, the latest one kept; a name already given another value goes into `mismatched`); JSON compares by
 * meaning, not spacing; everything else exactly.
 */
function matches(want: string, got: string, values: Record<string, string>, mismatched?: Set<string>) {
  if (want === got) return true;
  const names: string[] = [];
  const re = want.split(PLACEHOLDER).map((part, i) => (i % 2 ? (names.push(part), '(.+?)') : escape(part))).join('');
  if (names.length) {
    const m = new RegExp(`^${re}$`, 's').exec(got);
    if (!m) return false;
    if (m.slice(1).some((v) => !v.trim())) return false;
    names.forEach((n, i) => {
      if (values[n] !== undefined && values[n] !== m[i + 1]) mismatched?.add(n);
      values[n] = m[i + 1];
    });
    return true;
  }
  try {
    return JSON.stringify(JSON.parse(want)) === JSON.stringify(JSON.parse(got));
  } catch {
    return false;
  }
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{\{([a-z0-9-]+)\}\}/gi, (m, k: string) => values[k] ?? m);

/** A name to suggest in place of a placeholder the player left in (`<table>` → `orders`). */
const EXAMPLES: Record<string, string> = {
  table: 'orders',
  bucket: 'my-city-bucket-2026',
  function: 'hello-city',
  name: 'city-demo',
  'queue-name': 'orders-queue',
  'dlq-name': 'orders-dlq',
  topic: 'city-alerts',
  alarm: 'city-high-cpu',
  role: 'city-app-role',
  user: 'city-dev',
  group: 'city-devs',
  'group-name': 'city-web-sg',
  rule: 'city-nightly',
  space: 'city-space',
  description: 'my-first-try',
  'oac-name': 'city-oac',
  region: 'us-east-1',
  email: 'you@example.com',
  key: 'photo.jpg',
  db: 'city-db',
  provider: 'city-provider',
};
const LITERAL = /<([a-z0-9-]+)>|\{\{([a-z0-9-]+)\}\}/i;

/** A name to try for `<name>`: the example the notes suggest, or `my-<name>`. */
const exampleName = (name: string) => EXAMPLES[name] ?? `my-${name}`;

/** The teaching note for a placeholder typed as it was shown: a name to pick, or a value an earlier step printed. */
export function placeholderNote(name: string): string {
  const example = EXAMPLES[name];
  return example
    ? `Swap \`<${name}>\` for a name of your own, like \`${example}\`.`
    : `Swap \`<${name}>\` for the real value: an earlier step or the console shows it.`;
}

/** Runs one line of practice against a step. */
export function run(line: string, step: TerminalStep): RunResult {
  const tokens = tokenize(line.trim());
  if (!tokens.length) return { kind: 'empty' };
  // The command as shown, `<table>` and all, is not a run: the CLI would get the angle brackets as the name.
  const literal = tokens.map((t) => LITERAL.exec(t)).find(Boolean);
  if (literal) return { kind: 'other', output: placeholderNote(literal[1] ?? literal[2]) };
  const want = expected(step.cli);
  const got = parse(tokens);
  got.words = sameAsCli(want.words, got.words);
  const name = want.words.join(' ');
  const values: Record<string, string> = {};
  const mismatched = new Set<string>();
  if (got.words.length !== want.words.length || !want.words.every((w, i) => matches(w, got.words[i], values, mismatched))) {
    if (got.words[0] !== 'aws') return { kind: 'other', output: `${got.words[0] ?? tokens[0]}: this practice terminal only runs the AWS CLI. This step uses \`${name}\`.` };
    return { kind: 'other', output: parserRefusal(want.words, got.words) ?? `Not this step's command. This step runs \`${name}\`.` };
  }
  // The same settings written another way the CLI reads alike (keys in another order, the JSON form) count as the step's.
  for (const [flag, v] of want.flags) {
    const g = got.flags.get(flag);
    if (typeof v === 'string' && typeof g === 'string') got.flags.set(flag, sameShape(v, g));
  }
  // Everything given is read first, in the command's order: names fill the messages, and a `<name>` given two values
  // is a mismatch a taught mistake can name. A positional argument may be any file name.
  const right = new Set<string>();
  for (const [flag, v] of want.flags) {
    const g = got.flags.get(flag);
    if (typeof v === 'string' && typeof g === 'string' && matches(v, g, values, mismatched)) right.add(flag);
  }
  want.rest.forEach((w, i) => got.rest[i] !== undefined && matches(w, got.rest[i], values, mismatched));
  const item = got.flags.get('--item');
  if (step.itemKey && typeof item === 'string' && isItem(item, step.itemKey)) right.add('--item');
  // A taught mistake first: it names the exact thing that went wrong.
  const fires = (w: TerminalError['when']) => {
    if (!w || !(w.missing || (w.flag && w.value) || w.mismatch)) return false;
    if (w.missing && got.flags.has(w.missing)) return false;
    if (w.flag && w.value) {
      const v = got.flags.get(w.flag);
      if (typeof v !== 'string' || !new RegExp(w.value).test(v)) return false;
    }
    return !w.mismatch || mismatched.has(w.mismatch);
  };
  const taught = (step.errors ?? []).find((e) => fires(e.when));
  if (taught) return { kind: 'error', output: fill(taught.message, values), error: taught };
  // What the CLI's own parser refuses: a flag with no value, then the arguments it requires (all of them, like the CLI).
  for (const [flag, v] of want.flags)
    if (v !== true && got.flags.get(flag) === true) return { kind: 'other', output: `aws: [ERROR]: An error occurred (ParamValidation): argument ${flag}: expected one argument` };
  const lacking = requiredBy(want).filter((r) => (r === OUTFILE ? !got.rest.length : !got.flags.has(r)));
  if (lacking.length) return { kind: 'other', output: `aws: [ERROR]: An error occurred (ParamValidation): the following arguments are required: ${lacking.join(', ')}` };
  // Anything else the step uses, the CLI runs without: coach, never a made-up CLI error.
  for (const [flag, v] of want.flags)
    if (!got.flags.has(flag) && !want.optional.has(flag))
      return { kind: 'other', output: `Practice terminal: this step also ${v === true ? `uses ${flag}` : `sets ${flag} ${v}`}. Add it and run it again.` };
  if (got.rest.length < want.rest.length) return { kind: 'other', output: `Practice terminal: this step ends with ${want.rest.slice(got.rest.length).join(' ')}. Add it and run it again.` };
  for (const [flag, v] of want.flags) if (v !== true && got.flags.has(flag) && !right.has(flag)) return { kind: 'other', output: `Close. This step sets ${flag} to ${v}.` };
  const shown = step.outputs?.find(({ when }) => {
    const v = got.flags.get(when.flag);
    return typeof v === 'string' && new RegExp(when.value).test(v);
  });
  return { kind: 'ok', output: fill(shown?.output ?? step.output, values), values };
}

/** A flat shorthand value (`A=1,B=2`: no lists, no nesting) as its pairs, or undefined. */
function shorthand(s: string): [string, string][] | undefined {
  if (!s.includes('=') || /[{}[\]]/.test(s)) return undefined;
  const pairs = s.split(',').map((p) => (p.indexOf('=') > 0 ? ([p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as [string, string]) : undefined));
  return pairs.every(Boolean) ? (pairs as [string, string][]) : undefined;
}

/**
 * A value the CLI reads the same as the step's shorthand, rewritten the step's way: the same keys in another order
 * (`IgnorePublicAcls=true,BlockPublicAcls=true,…`) or the JSON form (`{"LocationConstraint":"eu-west-1"}`). Anything
 * else comes back as typed.
 */
function sameShape(want: string, got: string): string {
  const keys = shorthand(want)?.map(([k]) => k);
  if (!keys) return got;
  let given: Map<string, string> | undefined;
  const pairs = shorthand(got);
  if (pairs) given = new Map(pairs);
  else {
    try {
      const o: unknown = JSON.parse(got);
      if (o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every((v) => ['string', 'number', 'boolean'].includes(typeof v)))
        given = new Map(Object.entries(o).map(([k, v]) => [k, String(v)]));
    } catch {
      return got;
    }
  }
  if (!given || given.size !== keys.length || !keys.every((k) => given.has(k))) return got;
  return keys.map((k) => `${k}=${given.get(k)}`).join(',');
}

const ATTRIBUTE_TYPES = new Set(['S', 'N', 'B', 'BOOL', 'NULL', 'M', 'L', 'SS', 'NS', 'BS']);
/** A well-formed DynamoDB item (every attribute one typed value) whose key attributes are each a string, number or binary. */
function isItem(text: string, key: string[]): boolean {
  try {
    const o: unknown = JSON.parse(text);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const item = o as Record<string, unknown>;
    const typeOf = (a: unknown) => (a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).length === 1 ? Object.keys(a)[0] : undefined);
    const attrs = Object.values(item);
    return attrs.length > 0 && attrs.every((a) => ATTRIBUTE_TYPES.has(typeOf(a) ?? '')) && key.every((k) => ['S', 'N', 'B'].includes(typeOf(item[k]) ?? ''));
  } catch {
    return false;
  }
}

/** How alike two words are, like Python's difflib ratio (2 × common letters in order ÷ both lengths). */
function likeness(a: string, b: string): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const ca of a) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = ca === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return (2 * row[b.length]) / (a.length + b.length || 1);
}

const CLI_ERROR = 'aws: [ERROR]: An error occurred (ParamValidation): ';
/** The CLI's usage block (aws-cli v2 `awscli/argparser.py`: USAGE and HELP_BLURB), printed after a parser error. */
const CLI_USAGE =
  'usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\nTo see help text, you can run:\n\n  aws help\n  aws <command> help\n  aws <command> <subcommand> help';
/** The usage `aws s3` prints for a path that should be an S3 URI (aws-cli v2 `customizations/s3/subcommands.py`). */
const S3_USAGE: Record<string, string> = {
  cp: 'usage: aws s3 cp <LocalPath> <S3Uri> or <S3Uri> <LocalPath> or <S3Uri> <S3Uri>',
  mb: '<S3Uri>',
  rb: '<S3Uri>',
};
/** Commands that exist, so a near miss of the step's (`get-object` for `put-object`) isn't taken for a typo. */
const S3_COMMANDS = ['cp', 'mv', 'rm', 'rb', 'mb', 'ls', 'sync', 'presign', 'website'];
const known = (service: string, op: string) =>
  service === 's3' ? S3_COMMANDS.includes(op) : Object.keys(CLI_REQUIRED).some((k) => k === `${service} ${op}` || k.startsWith(`${service} ${op} `));

/**
 * What the CLI's own parser prints for a command word typed wrong (aws-cli v2 `argparser.py` `_check_value`: "Found
 * invalid choice", with the step's word as "Maybe you meant" when difflib would offer it, cutoff 0.8) or an `aws s3`
 * path without `s3://` ("Error: Invalid argument type"). Undefined when the line is just another command.
 */
function parserRefusal(want: string[], got: string[]): string | undefined {
  const [, service, op] = got;
  if (got[0] !== 'aws' || service !== want[1] || op === undefined || want[2] === undefined) return undefined;
  if (op !== want[2]) {
    if (known(service, op) || likeness(op, want[2]) < 0.8) return undefined;
    return `${CLI_ERROR}argument ${service === 's3' ? 'subcommand' : 'operation'}: Found invalid choice '${op}'\n\nMaybe you meant:\n\n  * ${want[2]}\n\n${CLI_USAGE}`;
  }
  const usage = S3_USAGE[op];
  if (service !== 's3' || !usage || got.length !== want.length || got.slice(3).some((g) => g.startsWith('s3://'))) return undefined;
  return want.slice(3).some((w) => w.startsWith('s3://')) ? `${CLI_ERROR}${usage}\nError: Invalid argument type` : undefined;
}

/** A command's file to save to (`aws s3api get-object … <outfile>`): a positional argument, named so in the CLI's errors. */
const OUTFILE = 'outfile';
/**
 * The arguments the real AWS CLI requires, for the commands the workshops and client jobs use: the options its reference
 * page's synopsis shows without brackets (in that order), and `outfile` for a command that saves to a file. A command
 * not listed here, or an option not listed for it, is one the CLI runs without: leaving it out gets a coaching line.
 */
const CLI_REQUIRED: Record<string, string[]> = {
  'athena start-query-execution': ['--query-string'],
  'autoscaling update-auto-scaling-group': ['--auto-scaling-group-name'],
  'backup create-backup-vault': ['--backup-vault-name'],
  'cloudformation deploy': ['--template-file', '--stack-name'],
  'cloudfront create-invalidation': ['--distribution-id'],
  'cloudfront create-origin-access-control': ['--origin-access-control-config'],
  'cloudfront delete-distribution': ['--id'],
  'cloudfront wait distribution-deployed': ['--id'],
  'cloudwatch delete-alarms': ['--alarm-names'],
  'cloudwatch put-metric-alarm': ['--alarm-name', '--evaluation-periods', '--comparison-operator'],
  'cloudwatch put-metric-data': ['--namespace'],
  'cloudwatch set-alarm-state': ['--alarm-name', '--state-value', '--state-reason'],
  'cognito-idp create-user-pool': ['--pool-name'],
  'dynamodb create-table': ['--attribute-definitions', '--table-name', '--key-schema'],
  'dynamodb delete-table': ['--table-name'],
  'dynamodb get-item': ['--table-name', '--key'],
  'dynamodb put-item': ['--table-name', '--item'],
  'dynamodb update-table': ['--table-name'],
  'dynamodb wait table-exists': ['--table-name'],
  'ec2 create-key-pair': ['--key-name'],
  'ec2 create-security-group': ['--description', '--group-name'],
  'ec2 create-tags': ['--resources', '--tags'],
  'ec2 stop-instances': ['--instance-ids'],
  'ec2 terminate-instances': ['--instance-ids'],
  'ecs describe-services': ['--services'],
  'events delete-rule': ['--name'],
  'events put-events': ['--entries'],
  'events put-rule': ['--name'],
  'events put-targets': ['--rule', '--targets'],
  'events remove-targets': ['--rule', '--ids'],
  'iam attach-role-policy': ['--role-name', '--policy-arn'],
  'kinesis create-stream': ['--stream-name'],
  'kinesis put-record': ['--data', '--partition-key'],
  'kms create-alias': ['--alias-name', '--target-key-id'],
  'kms decrypt': ['--ciphertext-blob'],
  'kms enable-key-rotation': ['--key-id'],
  'kms encrypt': ['--key-id', '--plaintext'],
  'kms generate-data-key': ['--key-id'],
  'kms schedule-key-deletion': ['--key-id'],
  'lambda create-function': ['--function-name', '--role'],
  'lambda delete-function': ['--function-name'],
  'lambda invoke': ['--function-name', OUTFILE],
  'lambda publish-version': ['--function-name'],
  'lambda put-function-concurrency': ['--function-name', '--reserved-concurrent-executions'],
  'polly synthesize-speech': ['--output-format', '--text', '--voice-id', OUTFILE],
  'rds create-db-instance': ['--db-instance-identifier', '--db-instance-class', '--engine'],
  'rds delete-db-instance': ['--db-instance-identifier'],
  'rds modify-db-instance': ['--db-instance-identifier'],
  's3api create-bucket': ['--bucket'],
  's3api delete-bucket': ['--bucket'],
  's3api delete-object': ['--bucket', '--key'],
  's3api get-bucket-lifecycle-configuration': ['--bucket'],
  's3api get-object': ['--bucket', '--key', OUTFILE],
  's3api put-bucket-policy': ['--bucket', '--policy'],
  's3api put-bucket-versioning': ['--bucket', '--versioning-configuration'],
  's3api put-object': ['--bucket', '--key'],
  's3api put-public-access-block': ['--bucket', '--public-access-block-configuration'],
  'sagemaker describe-endpoint': ['--endpoint-name'],
  'sns create-topic': ['--name'],
  'sns delete-topic': ['--topic-arn'],
  'sns subscribe': ['--topic-arn', '--protocol'],
  'sqs create-queue': ['--queue-name'],
  'sqs delete-message': ['--queue-url', '--receipt-handle'],
  'sqs delete-queue': ['--queue-url'],
  'sqs get-queue-attributes': ['--queue-url'],
  'sqs receive-message': ['--queue-url'],
  'sqs send-message': ['--queue-url', '--message-body'],
  'sqs set-queue-attributes': ['--queue-url', '--attributes'],
  'ssm get-parameter': ['--name'],
  'sts assume-role': ['--role-arn', '--role-session-name'],
  'textract detect-document-text': ['--document'],
};

/** What the CLI requires of the step's command, as far as the step's command uses it (a check never trips the right answer). */
function requiredBy(want: Expected): string[] {
  const cmd = want.words.slice(1).join(' ');
  const key = Object.keys(CLI_REQUIRED).find((k) => cmd === k || cmd.startsWith(`${k} `));
  return (key ? CLI_REQUIRED[key] : []).filter((r) => (r === OUTFILE ? want.rest.length > 0 : want.flags.has(r) && !want.optional.has(r)));
}

const S3_KEYED = /^s3:\/\/[^/]+\/([^/<>{}]+)$/;
const S3_BUCKET = /^(s3:\/\/[^/]+?)\/?$/;
/**
 * Words the real CLI treats the same as the step's, rewritten to the step's form: `./seat-map.png` is `seat-map.png`,
 * and copying a file to `s3://bucket` or `s3://bucket/` keeps its name as the key (`aws s3 cp seat-map.png
 * s3://arena` uploads `s3://arena/seat-map.png`), so it stands for `s3://<bucket>/seat-map.png`.
 */
function sameAsCli(want: string[], got: string[]): string[] {
  return got.map((g, i) => {
    const w = want[i];
    if (w === undefined || w === g) return g;
    if (!w.includes('/') && g === `./${w}`) return w;
    const key = S3_KEYED.exec(w)?.[1];
    const bucket = S3_BUCKET.exec(g)?.[1];
    if (key && bucket && got.slice(0, i).some((x) => x === key || x.endsWith(`/${key}`))) return `${bucket}/${key}`;
    return g;
  });
}

/** A pasted error (from a real terminal or the console) matched against a step's known mistakes, by its code. */
export function explainError(text: string, errors: TerminalError[] = []): TerminalError | undefined {
  const t = text.toLowerCase();
  return errors.find((e) => t.includes(e.code.toLowerCase()));
}

// ── Typing help: Tab, Hint and "Fill my names" (src/ui/PracticeTerminal.tsx) ──

type Unit = { kind: 'word' | 'flag' | 'value' | 'stray'; text: string; flag?: string };

/** The step's command as the order a player would type it: words, then each required flag and its value, then extras. */
function units(cli: string): Unit[] {
  const toks = tokenize(cli.replace(/\[--[^\]]*\]/g, ' '));
  const out: Unit[] = [];
  let i = 0;
  while (i < toks.length && !toks[i].startsWith('-')) out.push({ kind: 'word', text: toks[i++] });
  while (i < toks.length) {
    const t = toks[i++];
    if (!t.startsWith('-')) {
      out.push({ kind: 'stray', text: t });
      continue;
    }
    const eq = t.indexOf('=');
    if (eq > 0) {
      out.push({ kind: 'flag', text: t.slice(0, eq) }, { kind: 'value', text: t.slice(eq + 1), flag: t.slice(0, eq) });
      continue;
    }
    out.push({ kind: 'flag', text: t });
    if (i < toks.length && !toks[i].startsWith('--')) out.push({ kind: 'value', text: toks[i++], flag: t });
  }
  return out;
}

/** Quoted the way a shell needs it (JSON, spaces), or as it is. */
const shellWord = (w: string) => (/[\s"'{}$`\\*;&|()]/.test(w) ? `'${w.replace(/'/g, `'\\''`)}'` : w);

export interface NextWord {
  kind: Unit['kind'];
  /** The word as it would be typed: names already known filled in. Empty when it starts with a placeholder still unnamed. */
  word: string;
  /** The template word, placeholders and all (`--table-name`, `<table>`), for a hint to show. */
  shown: string;
  /** A placeholder in this word with no name yet (`table`): the player picks one. */
  placeholder?: string;
  /** The word started at the end of the line (Tab finishes it). */
  partial: string;
  /** The line with the word typed in, or undefined when there's nothing to insert yet. */
  line?: string;
}

/**
 * What comes next in the step's command after what's typed (`typed`), in the command's own order: the next word, a
 * flag not given yet, or a flag's value. `values` are names the player used earlier in this workshop: a `<table>` the
 * player already named completes to that name. Undefined when nothing is left to type (or what's started fits nothing).
 */
export function nextWord(typed: string, cli: string, values: Record<string, string> = {}): NextWord | undefined {
  const want = units(cli);
  const ends = typed === '' || /\s$/.test(typed);
  const toks = tokenize(typed);
  const partial = ends ? '' : (toks.pop() ?? '');
  const base = ends ? typed : typed.slice(0, typed.search(/\S+$/));
  // What's typed so far: words up to the first flag, then the flags given and whether the last one waits for a value.
  let words = 0;
  while (words < toks.length && !toks[words].startsWith('-')) words++;
  const flags = new Set(toks.slice(words).filter((t) => t.startsWith('-')).map((t) => t.split('=')[0]));
  const last = toks[toks.length - 1];
  const wantWords = want.filter((u) => u.kind === 'word');
  // Off the command's path already (`aws s3` for a DynamoDB step): nothing to finish.
  if (toks.slice(0, Math.min(words, wantWords.length)).some((t, i) => !matches(wantWords[i].text, t, {}))) return undefined;
  let next: Unit | undefined;
  if (words < wantWords.length && flags.size === 0 && !partial.startsWith('-')) next = wantWords[words];
  else if (partial.startsWith('-')) next = want.find((u) => u.kind === 'flag' && !flags.has(u.text) && u.text.startsWith(partial));
  else {
    if (last?.startsWith('-') && !last.includes('=') && toks.length > words) next = want.find((u) => u.kind === 'value' && u.flag === last);
    next ??= want.find((u) => u.kind === 'flag' && !flags.has(u.text)) ?? want.find((u) => u.kind === 'stray' && !toks.includes(u.text));
  }
  if (!next) return undefined;
  // A known name fills its placeholder; the first unnamed one stops the word there (the player types that part).
  let placeholder: string | undefined;
  const filled = next.text.replace(PLACEHOLDER, (m, k: string) => {
    if (placeholder) return m;
    if (values[k]) return values[k];
    placeholder = k;
    return m;
  });
  const cut = placeholder ? filled.slice(0, filled.indexOf(`<${placeholder}>`)) : filled;
  const word = placeholder ? (/[\s"'{}]/.test(cut) ? '' : cut) : shellWord(filled);
  if (partial && !word.startsWith(partial) && !(placeholder && partial.startsWith(word))) return undefined;
  const line = word && word.length > partial.length ? `${base}${word}${placeholder ? '' : ' '}` : undefined;
  return { kind: next.kind, word, shown: next.text, placeholder, partial, line };
}

/**
 * Tab: finishes the word you've started (from the step's command), types the next command word, or fills a name you
 * used earlier. A flag needs its first letters (`--b` then Tab): Hint is for not knowing what comes next.
 */
export function tabComplete(typed: string, cli: string, values: Record<string, string> = {}): { line: string; note?: string } {
  const n = nextWord(typed, cli, values);
  if (!n) return { line: typed, note: tokenize(typed).length ? 'Nothing to finish here: check the command above, or press Enter to run it.' : undefined };
  if (n.kind === 'flag' && !n.partial) return { line: typed, note: 'Type the start of the next option (like --) and press Tab, or tap Hint.' };
  if (n.line) return { line: n.line, note: n.placeholder ? placeholderNote(n.placeholder) : undefined };
  return { line: typed, note: n.placeholder ? placeholderNote(n.placeholder) : undefined };
}

/**
 * Hint: the next word, like nextWord. At a placeholder it first types up to it (`s3://`) and says to pick a name; asked
 * again right there, it finishes the word with an example name (`s3://my-city-bucket-2026/seat-map.png`), so a hint is
 * never a dead end. `example` is the name it used.
 */
export function hintWord(typed: string, cli: string, values: Record<string, string> = {}): (NextWord & { example?: { name: string; value: string } }) | undefined {
  const n = nextWord(typed, cli, values);
  if (!n?.placeholder || n.line) return n;
  const value = exampleName(n.placeholder);
  const filled = nextWord(typed, cli, { ...values, [n.placeholder]: value });
  return filled?.line ? { ...filled, example: { name: n.placeholder, value } } : n;
}

/** "Fill my names": every `<name>` typed in the line swapped for the name used earlier in this workshop. */
export function fillNames(typed: string, values: Record<string, string>): string {
  return typed.replace(/<([a-z0-9-]+)>|\{\{([a-z0-9-]+)\}\}/gi, (m, a: string | undefined, b: string | undefined) => values[(a ?? b)!] ?? m);
}
