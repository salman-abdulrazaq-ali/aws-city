import { describe, expect, it } from 'vitest';
import { explainError, fillNames, hintWord, isCoaching, nextWord, run, tabComplete, tokenize, type RunResult, type TerminalStep } from '@/learning/terminal';
import { WORKSHOPS, terminalStep } from '@/world/workshops';

// The practice terminal reads a command like a shell, accepts flags in any order, and teaches the real CLI's errors.
const step: TerminalStep = {
  cli: 'aws dynamodb create-table --table-name <table> --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST [--region <region>]',
  output: '{ "TableDescription": { "TableName": "{{table}}", "TableStatus": "CREATING" } }',
  errors: [
    {
      code: 'ValidationException',
      message: 'An error occurred (ValidationException) when calling the CreateTable operation: No provisioned throughput specified',
      when: { missing: '--billing-mode' },
      explain: 'Without a billing mode the table defaults to provisioned capacity, which needs throughput numbers.',
      fix: 'Add --billing-mode PAY_PER_REQUEST.',
    },
    {
      code: 'ResourceInUseException',
      message: 'An error occurred (ResourceInUseException) when calling the CreateTable operation: Table already exists: city-demo',
      when: { flag: '--table-name', value: '^city-demo$' },
      explain: 'Table names are unique per Region in your account.',
      fix: 'Pick another name, or delete the old table first.',
    },
  ],
};

describe('practice terminal', () => {
  it('splits like a shell: quotes, escapes and line continuations', () => {
    expect(tokenize(`aws s3 cp "my file.txt" s3://b/ \\\n  --acl 'private'`)).toEqual(['aws', 's3', 'cp', 'my file.txt', 's3://b/', '--acl', 'private']);
    expect(tokenize('echo a\\ b ""')).toEqual(['echo', 'a b', '']);
  });

  it('accepts the expected command with flags in any order and echoes placeholders', () => {
    const r = run(
      'aws dynamodb create-table --billing-mode PAY_PER_REQUEST --key-schema AttributeName=pk,KeyType=HASH --table-name orders --attribute-definitions AttributeName=pk,AttributeType=S',
      step,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.output).toContain('"TableName": "orders"');
      expect(r.values.table).toBe('orders');
    }
  });

  it('allows `--flag=value` and optional flags', () => {
    const r = run('aws dynamodb create-table --table-name=t1 --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST --region eu-west-2', step);
    expect(r.kind).toBe('ok');
  });

  it('teaches a known mistake with the real error text', () => {
    const r = run('aws dynamodb create-table --table-name t --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH', step);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.fix).toMatch(/PAY_PER_REQUEST/);
    const taken = run('aws dynamodb create-table --table-name city-demo --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST', step);
    expect(taken.kind === 'error' && taken.error.code).toBe('ResourceInUseException');
  });

  it('names what is off when it is not a taught mistake', () => {
    expect(run('aws s3 ls', step)).toMatchObject({ kind: 'other', output: expect.stringContaining('aws dynamodb create-table') });
    expect(run('rm -rf /', step)).toMatchObject({ kind: 'other', output: expect.stringContaining('only runs the AWS CLI') });
    expect(run('aws dynamodb create-table --table-name t --billing-mode PAY_PER_REQUEST --key-schema AttributeName=pk,KeyType=HASH', step)).toMatchObject({
      output: 'aws: [ERROR]: An error occurred (ParamValidation): the following arguments are required: --attribute-definitions',
    });
    expect(run('aws dynamodb create-table --table-name t --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST', step)).toMatchObject({
      output: expect.stringContaining('Close.'),
    });
    expect(run('   ', step)).toEqual({ kind: 'empty' });
  });

  it('matches placeholders inside a word', () => {
    const s3: TerminalStep = { cli: 'aws s3 mb s3://<bucket>', output: 'make_bucket: {{bucket}}' };
    expect(run('aws s3 mb s3://city-logs-42', s3)).toMatchObject({ kind: 'ok', output: 'make_bucket: city-logs-42' });
    expect(run('aws s3 mb city-logs-42', s3).kind).toBe('other');
  });

  it('refuses the command pasted with its placeholders, and teaches what to type instead', () => {
    const shown = 'aws dynamodb create-table --table-name <table> --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST';
    expect(run(shown, step)).toEqual({ kind: 'other', output: 'Swap `<table>` for a name of your own, like `orders`.' });
    expect(run(shown.replace('<table>', '{{table}}'), step).kind).toBe('other');
    const s3: TerminalStep = { cli: 'aws s3 mb s3://<bucket>', output: 'make_bucket: {{bucket}}' };
    expect(run('aws s3 mb s3://<bucket>', s3)).toMatchObject({ kind: 'other', output: expect.stringContaining('`<bucket>`') });
    // An id or URL from an earlier step: no made-up example.
    const q: TerminalStep = { cli: 'aws sqs get-queue-attributes --queue-url <queue-url>', output: '{}' };
    expect(run('aws sqs get-queue-attributes --queue-url <queue-url>', q)).toMatchObject({ output: expect.stringContaining('an earlier step') });
    // Captures hold real values only.
    expect(run(shown.replace('<table>', '" "'), step).kind).toBe('other');
  });

  it('compares JSON values by meaning', () => {
    const s: TerminalStep = { cli: `aws lambda invoke --function-name f --payload '{"a":1}' out.json`, output: 'ok' };
    expect(run(`aws lambda invoke --payload '{ "a": 1 }' --function-name f out.json`, s).kind).toBe('ok');
  });

  it('explains a pasted error by its code', () => {
    expect(explainError('An error occurred (ResourceInUseException) when calling...', step.errors)?.fix).toMatch(/another name/);
    expect(explainError('something else', step.errors)).toBeUndefined();
  });
});

describe('typing help', () => {
  const cli = step.cli;
  it('Tab types the command words, finishes a started flag, and fills a name used before', () => {
    expect(tabComplete('', cli).line).toBe('aws ');
    expect(tabComplete('aws dyn', cli).line).toBe('aws dynamodb ');
    expect(tabComplete('aws dynamodb ', cli).line).toBe('aws dynamodb create-table ');
    // A flag needs its first letters: not knowing what comes next is what Hint is for.
    expect(tabComplete('aws dynamodb create-table ', cli)).toMatchObject({ line: 'aws dynamodb create-table ', note: expect.stringMatching(/Hint/) });
    expect(tabComplete('aws dynamodb create-table --ta', cli).line).toBe('aws dynamodb create-table --table-name ');
    expect(tabComplete('aws dynamodb create-table --bil', cli).line).toBe('aws dynamodb create-table --billing-mode ');
    // No name yet: Tab teaches instead of typing `<table>`; with a name from an earlier step, it types it.
    const none = tabComplete('aws dynamodb create-table --table-name ', cli);
    expect(none.line).toBe('aws dynamodb create-table --table-name ');
    expect(none.note).toMatch(/orders/);
    expect(tabComplete('aws dynamodb create-table --table-name ', cli, { table: 'shop' }).line).toBe('aws dynamodb create-table --table-name shop ');
    expect(tabComplete('aws dynamodb create-table --table-name sh', cli, { table: 'shop' }).line).toBe('aws dynamodb create-table --table-name shop ');
    // A value that isn't a placeholder completes from nothing.
    expect(tabComplete('aws dynamodb create-table --billing-mode ', cli).line).toBe('aws dynamodb create-table --billing-mode PAY_PER_REQUEST ');
    expect(tabComplete('aws s3 ', cli).line).toBe('aws s3 ');
  });

  it('Hint shows the next flag in order, skipping those given, and nothing once the command is whole', () => {
    expect(nextWord('aws dynamodb create-table ', cli)).toMatchObject({ kind: 'flag', shown: '--table-name' });
    expect(nextWord('aws dynamodb create-table --billing-mode PAY_PER_REQUEST --table-name t ', cli)?.shown).toBe('--attribute-definitions');
    expect(nextWord('aws dynamodb create-table --table-name ', cli)).toMatchObject({ kind: 'value', shown: '<table>', placeholder: 'table' });
    const whole = 'aws dynamodb create-table --table-name t --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST ';
    expect(nextWord(whole, cli)).toBeUndefined();
    expect(run(whole, step).kind).toBe('ok');
  });

  it('quotes JSON values so the shell keeps them whole', () => {
    const put = { cli: `aws dynamodb put-item --table-name <table> --item '{"pk":{"S":"order#1"}}'`, output: '' };
    const line = tabComplete('aws dynamodb put-item --table-name shop --it', put.cli).line;
    const done = tabComplete(line, put.cli).line;
    expect(done).toBe(`aws dynamodb put-item --table-name shop --item '{"pk":{"S":"order#1"}}' `);
    expect(run(done, put).kind).toBe('ok');
  });

  it('Tab and Hint alone can type every workshop command, given the names', () => {
    for (const w of WORKSHOPS)
      for (const s of w.steps) {
        const t = terminalStep(s);
        if (!t) continue;
        // A Region has to be a real one: S3 answers a bucket outside us-east-1 differently.
        const names = Object.fromEntries([...t.cli.matchAll(/<([a-z0-9-]+)>/gi)].map((m) => [m[1], m[1] === 'region' ? 'us-east-1' : `demo-${m[1]}`]));
        let line = '';
        for (let i = 0; i < 60; i++) {
          const n = nextWord(line, t.cli, names);
          if (!n) break;
          line = n.line ?? line;
          if (!n.line) break;
        }
        expect(run(line, t).kind, `${w.id}/${s.id}: ${line}`).toBe('ok');
      }
  });

  it('Fill my names swaps placeholders for names used before', () => {
    expect(fillNames('aws dynamodb get-item --table-name <table> --key <key>', { table: 'shop' })).toBe('aws dynamodb get-item --table-name shop --key <key>');
  });

  it('Hint never stops at a placeholder: asked again there, it finishes the word with an example name', () => {
    const cli = 'aws s3 cp seat-map.png s3://<bucket>/seat-map.png';
    let line = '';
    for (let i = 0; i < 10; i++) {
      const n = hintWord(line, cli);
      if (!n?.line) break;
      line = n.line;
    }
    expect(line.trim()).toBe('aws s3 cp seat-map.png s3://my-city-bucket-2026/seat-map.png');
    expect(hintWord('aws s3 cp seat-map.png s3://', cli)?.example).toEqual({ name: 'bucket', value: 'my-city-bucket-2026' });
    expect(run(line, { cli, output: 'upload: ./seat-map.png to s3://{{bucket}}/seat-map.png' }).kind).toBe('ok');
  });
});

describe('only what the real CLI requires is a CLI error', () => {
  const stepOf = (workshop: string, id: string) => terminalStep(WORKSHOPS.find((w) => w.id === workshop)!.steps.find((s) => s.id === id)!)!;
  const required = (args: string) => `aws: [ERROR]: An error occurred (ParamValidation): the following arguments are required: ${args}`;

  it('a flag the step uses but the CLI runs without gets a coaching line, never a made-up ParamValidation', () => {
    const key = stepOf('ec2-first-instance', 'key');
    const noQuery = run('aws ec2 create-key-pair --key-name city-key --output text > city-key.pem', key);
    expect(noQuery).toMatchObject({ kind: 'other', output: 'Practice terminal: this step also sets --query KeyMaterial. Add it and run it again.' });
    expect(run('aws ec2 create-key-pair --query KeyMaterial --output text > city-key.pem', key)).toMatchObject({ output: required('--key-name') });
    expect(run('aws ec2 create-key-pair --key-name city-key --query KeyMaterial --output text > city-key.pem', key).kind).toBe('ok');
    // Every argument the CLI requires is named at once, the way it names them.
    expect(run('aws s3api put-object --body sample.txt', stepOf('s3-first-bucket', 'upload'))).toMatchObject({ output: required('--bucket, --key') });
  });

  it('put-object without --body, delete-object without --version-id, s3 rb without --force: the real outcome, coached', () => {
    const body = run('aws s3api put-object --bucket city-photos-4f9c2a --key sample.txt', stepOf('s3-first-bucket', 'upload'));
    expect(body.kind).toBe('error');
    expect(body.kind === 'error' && body.output).toMatch(/^Practice terminal: .*empty object/);
    const marker = run('aws s3api delete-object --bucket city-photos-4f9c2a --key sample.txt', stepOf('s3-first-bucket', 'delete-version'));
    expect(marker.kind === 'error' && marker.output).toMatch(/^Practice terminal: .*delete marker/);
    const rb = run('aws s3 rb s3://city-photos-4f9c2a', stepOf('cloudfront-s3-oac', 'cleanup'));
    expect(rb.kind === 'error' && rb.output).toBe(
      'remove_bucket failed: s3://city-photos-4f9c2a An error occurred (BucketNotEmpty) when calling the DeleteBucket operation: The bucket you tried to delete is not empty',
    );
    for (const r of [body, marker, rb]) expect('output' in r && r.output).not.toMatch(/ParamValidation/);
  });

  it('get-object needs the file to save to, as the CLI does; any file name works', () => {
    const get = stepOf('s3-first-bucket', 'download');
    expect(run('aws s3api get-object --bucket city-photos-4f9c2a --key sample.txt', get)).toMatchObject({ output: required('outfile') });
    expect(run('aws s3api get-object --bucket city-photos-4f9c2a --key sample.txt my-copy.txt', get).kind).toBe('ok');
    expect(run('aws s3api get-object --bucket city-photos-4f9c2a downloaded-sample.txt --key sample.txt', get).kind).toBe('ok');
  });
});

describe('the S3 workshop answers like S3', () => {
  const create = terminalStep(WORKSHOPS.find((w) => w.id === 's3-first-bucket')!.steps.find((s) => s.id === 'create')!)!;
  const codeOf = (line: string) => {
    const r = run(line, create);
    return r.kind === 'error' ? r.error.code : r.kind;
  };

  it('teaches the naming rules and suggests a name S3 accepts, never the reserved amzn-s3-demo- prefix', () => {
    const body = WORKSHOPS.find((w) => w.id === 's3-first-bucket')!.steps[0].body;
    for (const rule of ['3 to 63', 'lowercase', 'no underscores', 'amzn-s3-demo-', 'xn--']) expect(body).toContain(rule);
    expect(JSON.stringify(create.errors?.map((e) => e.fix))).not.toMatch(/amzn-s3-demo-/);
    expect(codeOf('aws s3api create-bucket --bucket city-photos-4f9c2a --region us-east-1')).toBe('ok');
    for (const bad of ['My_Bucket', 'amzn-s3-demo-4f9c2a', 'xn--city', 'ab', 'city..photos', '192.168.5.4', '-city'])
      expect(codeOf(`aws s3api create-bucket --bucket ${bad} --region us-east-1`), bad).toBe('InvalidBucketName');
  });

  it('outside us-east-1 needs the same Region in the location constraint', () => {
    expect(codeOf('aws s3api create-bucket --bucket city-photos-4f9c2a --region eu-west-1 --create-bucket-configuration LocationConstraint=eu-west-1')).toBe('ok');
    const none = run('aws s3api create-bucket --bucket city-photos-4f9c2a --region us-west-2', create);
    expect(none.kind === 'error' && none.output).toContain('(IllegalLocationConstraintException) when calling the CreateBucket operation: The unspecified location constraint');
    const other = run('aws s3api create-bucket --bucket city-photos-4f9c2a --region us-west-2 --create-bucket-configuration LocationConstraint=eu-west-1', create);
    expect(other.kind === 'error' && other.output).toBe(
      'An error occurred (IllegalLocationConstraintException) when calling the CreateBucket operation: The eu-west-1 location constraint is incompatible for the region specific endpoint this request was sent to.',
    );
    expect(codeOf('aws s3api create-bucket --bucket city-photos-4f9c2a --region us-east-1 --create-bucket-configuration LocationConstraint=us-east-1')).toBe('InvalidLocationConstraint');
    // No Region named: the practice terminal has no default one, and says so in its own voice.
    const unnamed = run('aws s3api create-bucket --bucket city-photos-4f9c2a', create);
    expect(unnamed.kind === 'error' && unnamed.output).toMatch(/^Practice terminal: which Region\?/);
  });
});

describe('the real CLI’s other spellings', () => {
  const seat: TerminalStep = { cli: 'aws s3 cp seat-map.png s3://<bucket>/seat-map.png', output: 'upload: ./seat-map.png to s3://{{bucket}}/seat-map.png' };
  it('a copy to s3://bucket, with or without the slash, keeps the file name as its key', () => {
    for (const line of ['aws s3 cp seat-map.png s3://arena-bucket', 'aws s3 cp seat-map.png s3://arena-bucket/', 'aws s3 cp ./seat-map.png s3://arena-bucket/seat-map.png']) {
      const r = run(line, seat);
      expect(r.kind, line).toBe('ok');
      expect(r.kind === 'ok' && r.output).toBe('upload: ./seat-map.png to s3://arena-bucket/seat-map.png');
    }
  });
  it('a different key is still a different command', () => {
    expect(run('aws s3 cp seat-map.png s3://arena-bucket/other.png', seat).kind).toBe('other');
    expect(run('aws s3 cp other.png s3://arena-bucket', seat).kind).toBe('other');
  });
});

const said = (r: RunResult) => ('output' in r ? r.output : '');

describe('the S3 and DynamoDB workshops answer like the CLI reference (Okafor)', () => {
  const s3 = WORKSHOPS.find((w) => w.id === 's3-first-bucket')!;
  const stepOf = (w: (typeof WORKSHOPS)[number], id: string) => terminalStep(w.steps.find((s) => s.id === id)!)!;
  const create = stepOf(s3, 'create');

  it('create-bucket says "/<bucket>" in us-east-1 and the bucket address elsewhere', () => {
    const east = run('aws s3api create-bucket --bucket city-photos-4f9c2a --region us-east-1', create);
    expect(east.kind === 'ok' && JSON.parse(said(east))).toEqual({ Location: '/city-photos-4f9c2a' });
    const west = run('aws s3api create-bucket --bucket city-photos-4f9c2a --region eu-west-1 --create-bucket-configuration LocationConstraint=eu-west-1', create);
    expect(west.kind === 'ok' && JSON.parse(said(west))).toEqual({ Location: 'http://city-photos-4f9c2a.s3.amazonaws.com/' });
  });

  it('takes the JSON form of --create-bucket-configuration, and its mistakes are taught the same', () => {
    expect(run(`aws s3api create-bucket --bucket city-photos-4f9c2a --region eu-west-1 --create-bucket-configuration '{"LocationConstraint":"eu-west-1"}'`, create).kind).toBe('ok');
    const other = run(`aws s3api create-bucket --bucket city-photos-4f9c2a --region us-west-2 --create-bucket-configuration '{"LocationConstraint": "eu-west-1"}'`, create);
    expect(other.kind === 'error' && other.error.code).toBe('IllegalLocationConstraintException');
  });

  it('takes the Block Public Access keys in any order, and still refuses a wrong value', () => {
    const bpa = stepOf(s3, s3.steps.find((s) => s.cli?.includes('put-public-access-block'))!.id);
    const line = (cfg: string) => run(`aws s3api put-public-access-block --bucket city-photos-4f9c2a --public-access-block-configuration ${cfg}`, bpa);
    expect(line('RestrictPublicBuckets=true,BlockPublicPolicy=true,IgnorePublicAcls=true,BlockPublicAcls=true').kind).toBe('ok');
    expect(line(`'{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}'`).kind).toBe('ok');
    expect(said(line('RestrictPublicBuckets=false,BlockPublicPolicy=true,IgnorePublicAcls=true,BlockPublicAcls=true'))).toContain('Close.');
  });

  it('takes any well-formed DynamoDB item that carries the key', () => {
    const put = stepOf(WORKSHOPS.find((w) => w.steps.some((s) => s.itemKey))!, WORKSHOPS.flatMap((w) => w.steps).find((s) => s.itemKey)!.id);
    const item = (json: string) => run(`aws dynamodb put-item --table-name orders --item '${json}'`, put);
    expect(item('{"pk":{"S":"order#7"},"customer":{"S":"Ana"},"paid":{"BOOL":true}}').kind).toBe('ok');
    expect(said(item('{"pk":"order#7"}'))).toContain('Close.');
    expect(item('{"total":{"N":"5"}}').kind).toBe('error');
  });

  it("put-object's answer is the CLI reference's shape, its ETag the MD5 of the 10 bytes it uploads", () => {
    const up = run('aws s3api put-object --bucket city-photos-4f9c2a --key sample.txt --body sample.txt', stepOf(s3, 'upload'));
    const out = up.kind === 'ok' ? JSON.parse(said(up)) : {};
    expect(Object.keys(out)).toEqual(['ETag', 'ChecksumCRC64NVME', 'ChecksumType', 'ServerSideEncryption', 'VersionId']);
    // echo "Hello, S3" > sample.txt writes "Hello, S3\n": 10 bytes, MD5 34604da2…, CRC64NVME vL37ViPe6JI=.
    expect(out.ETag).toBe('"34604da2079f37530dc71b117b9cd58b"');
    const down = run('aws s3api get-object --bucket city-photos-4f9c2a --key sample.txt downloaded-sample.txt', stepOf(s3, 'download'));
    expect(down.kind === 'ok' && JSON.parse(said(down))).toMatchObject({ ContentLength: 10, ETag: out.ETag });
  });
});

describe('a mistyped command gets the CLI parser’s own words (aws-cli v2 argparser.py, customizations/s3)', () => {
  const s3 = WORKSHOPS.find((w) => w.id === 's3-first-bucket')!;
  const create = terminalStep(s3.steps.find((s) => s.id === 'create')!)!;

  it('a typo in the operation is "Found invalid choice", with the step’s word as the suggestion', () => {
    const r = run('aws s3api creat-bucket --bucket city-photos-4f9c2a --region us-east-1', create);
    expect(said(r)).toMatch(/^aws: \[ERROR\]: An error occurred \(ParamValidation\): argument operation: Found invalid choice 'creat-bucket'\n\nMaybe you meant:\n\n {2}\* create-bucket\n\nusage: aws \[options\]/);
    // Another real command is just not this step's.
    expect(said(run('aws s3api delete-bucket --bucket city-photos-4f9c2a', create))).toContain("Not this step's command");
  });

  it('an aws s3 path without s3:// is "Invalid argument type"', () => {
    const cp: TerminalStep = { cli: 'aws s3 cp index.html s3://<bucket>/index.html', output: '' };
    expect(said(run('aws s3 cp index.html city-site/index.html', cp))).toBe(
      'aws: [ERROR]: An error occurred (ParamValidation): usage: aws s3 cp <LocalPath> <S3Uri> or <S3Uri> <LocalPath> or <S3Uri> <S3Uri>\nError: Invalid argument type',
    );
    const rb: TerminalStep = { cli: 'aws s3 rb s3://<bucket> --force', output: '' };
    expect(said(run('aws s3 rb city-site --force', rb))).toBe('aws: [ERROR]: An error occurred (ParamValidation): <S3Uri>\nError: Invalid argument type');
    expect(said(run('aws s3 cpp index.html s3://city-site/index.html', cp))).toContain("argument subcommand: Found invalid choice 'cpp'");
  });

  it('coaching lines are the game’s voice, never the CLI’s', () => {
    expect(isCoaching(said(run('aws s3api create-bucket --bucket city-photos-4f9c2a', create)))).toBe(true);
    expect(isCoaching('aws: [ERROR]: An error occurred (ParamValidation): <S3Uri>')).toBe(false);
  });
});
