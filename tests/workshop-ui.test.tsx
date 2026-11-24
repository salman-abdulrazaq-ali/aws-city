// @vitest-environment jsdom
// Workshops that feel like a game: Tab and Hint in the practice terminal (a hint costs a star), names that carry over to
// CloudShell's check, stars and the next step inside the dialog, the demo never "for real", and the finished card.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));
const verify = vi.fn();
// "I got an error": the question goes to the building's agent; the answer comes back through the store's chats.
const asked = vi.fn((districtId: string, _q: string, shown: string) => {
  useCity.getState().addUserChat(districtId, 'err-1', shown);
  return 'err-1';
});
vi.mock('@/app/runtime', async (importOriginal) => ({ ...(await importOriginal<object>()), verifyWorkshopStep: verify, askDistrict: asked }));

const { useCity, cleanUnticked } = await import('@/state/store');
const { bus } = await import('@/state/bus');
const { Workshop } = await import('@/ui/Workshop');
const { WorkshopDone, DONE_CARD_MS } = await import('@/ui/WorkshopDone');
const { PRACTICE_STEP_XP } = await import('@/learning/workshopRewards');

const ID = 'dynamodb-first-table';
const base = useCity.getState().progress;
// The first render pays for loading the workshop's modules; do it once here, so no test runs near its time limit under load.
beforeAll(() => {
  act(() => useCity.getState().openWorkshop(ID));
  render(<Workshop />);
  cleanup();
});
beforeEach(() => {
  verify.mockReset();
  useCity.setState({ progress: { ...base, workshops: {} }, workshopOpen: undefined, backendKind: 'mock', prefs: { ...useCity.getState().prefs, workshopMemory: undefined } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const open = () => act(() => useCity.getState().openWorkshop(ID));
// By its label, not its role: a role query computes every element's role and name (slow under load).
const terminal = () => screen.getAllByLabelText(/Practice terminal for/).find((e) => e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement) as HTMLTextAreaElement;
const enter = (line: string) => {
  fireEvent.change(terminal(), { target: { value: line } });
  fireEvent.keyDown(terminal(), { key: 'Enter' });
};

describe('the practice terminal in a workshop', () => {
  it('Tab finishes a word; Hint types the next one and costs a star on that step', () => {
    open();
    render(<Workshop />);
    fireEvent.change(terminal(), { target: { value: 'aws st' } });
    fireEvent.keyDown(terminal(), { key: 'Tab' });
    expect(terminal().value).toBe('aws sts ');
    fireEvent.click(screen.getByText(/💡 Hint/).closest('button')!);
    expect(terminal().value).toBe('aws sts get-caller-identity ');
    expect(screen.getByText(/1 hint/).textContent).toMatch(/−1⭐/);
    act(() => fireEvent.keyDown(terminal(), { key: 'Enter' }));
    expect(useCity.getState().progress.workshops?.[ID]?.steps.whoami).toBe('practice');
    // The stars float in the dialog with the building's growth line.
    expect(screen.getByText(new RegExp(`\\+${PRACTICE_STEP_XP - 1}⭐ · `))).toBeTruthy();
  });

  it('moves to the next step a second after a pass, and remembers the names and lines for the whole workshop', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    open();
    render(<Workshop />);
    act(() => enter('aws sts get-caller-identity'));
    expect(screen.getByRole('region', { name: 'Check who you are' })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('region', { name: 'Create the table' })).toBeTruthy();
    act(() => enter('aws dynamodb create-table --table-name shop --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST'));
    const memory = useCity.getState().prefs.workshopMemory?.[ID];
    expect(memory?.names.table).toBe('shop');
    expect(memory?.history).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1000));
    // The next step's command shows the name, ↑ brings back the last line, and Tab types the name.
    expect(screen.getByText(/aws dynamodb wait table-exists --table-name shop/)).toBeTruthy();
    fireEvent.keyDown(terminal(), { key: 'ArrowUp' });
    expect(terminal().value).toMatch(/^aws dynamodb create-table/);
    fireEvent.change(terminal(), { target: { value: 'aws dynamodb wait table-exists --table-name ' } });
    fireEvent.keyDown(terminal(), { key: 'Tab' });
    expect(terminal().value).toBe('aws dynamodb wait table-exists --table-name shop ');
  });
});

// Asked for on 24 Nov 2026: the ⬜ looked like a tick box but only opened the step.
describe('the step list’s tick boxes', () => {
  const box = (title: string) => screen.getByLabelText(`${title} done`) as HTMLInputElement;
  const steps = () => useCity.getState().progress.workshops?.[ID]?.steps ?? {};

  it('a tick marks the step done (practice stars, once); unticking undoes it, and ticking again pays nothing twice', () => {
    useCity.setState({ prefs: { ...useCity.getState().prefs, workshopUnticked: undefined } });
    open();
    render(<Workshop />);
    expect(box('Check who you are').checked).toBe(false);
    const before = useCity.getState().progress;
    act(() => fireEvent.click(box('Check who you are')));
    expect(steps().whoami).toBe('practice');
    expect(box('Check who you are').checked).toBe(true);
    const paid = JSON.stringify(useCity.getState().progress.landmarks) !== JSON.stringify(before.landmarks) || JSON.stringify(useCity.getState().progress.cities) !== JSON.stringify(before.cities);
    expect(paid).toBe(true);
    act(() => fireEvent.click(box('Check who you are')));
    expect(steps().whoami).toBeUndefined();
    expect(box('Check who you are').checked).toBe(false);
    expect(useCity.getState().prefs.workshopUnticked).toEqual({ [`${ID}/whoami`]: 'practice' });
    // Ticked again: done again, no new stars, and the ledger entry goes.
    let stars = -1;
    const off = bus.on('workshopStep', (e) => (stars = e.stars));
    act(() => fireEvent.click(box('Check who you are')));
    off();
    expect(stars).toBe(0);
    expect(steps().whoami).toBe('practice');
    expect(useCity.getState().prefs.workshopUnticked).toBeUndefined();
  });

  it('a step checked for real shows ✅; unticked and ticked again, it comes back as real', () => {
    useCity.setState({ progress: { ...base, workshops: { [ID]: { steps: { whoami: 'real' } } } }, prefs: { ...useCity.getState().prefs, workshopUnticked: undefined } });
    open();
    render(<Workshop />);
    expect(screen.getByRole('button', { name: /Check who you are/ }).textContent).toMatch(/✅/);
    act(() => fireEvent.click(box('Check who you are')));
    expect(steps().whoami).toBeUndefined();
    act(() => fireEvent.click(box('Check who you are')));
    expect(steps().whoami).toBe('real');
  });

  it('unticking keeps a finished workshop finished (its bonus isn’t paid again)', () => {
    useCity.setState({ progress: { ...base, workshops: { [ID]: { steps: { whoami: 'practice' }, done: '2026-11-20' } } } });
    act(() => useCity.getState().untickWorkshopStep(ID, 'whoami'));
    expect(useCity.getState().progress.workshops?.[ID]).toEqual({ steps: {}, done: '2026-11-20' });
  });

  it('the unticked steps read back strictly from storage', () => {
    expect(cleanUnticked({ [`${ID}/whoami`]: 'real', 'x/y': 'practice', 'bad key': 'real', [`${ID}/create`]: 'maybe' })).toEqual({ [`${ID}/whoami`]: 'real', 'x/y': 'practice' });
    expect(cleanUnticked('nope')).toBeUndefined();
    expect(cleanUnticked({})).toBeUndefined();
  });

  it('pressing a step’s title opens it without ticking it', () => {
    open();
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /Create the table/ }));
    expect(screen.getByRole('region', { name: 'Create the table' })).toBeTruthy();
    expect(steps().create).toBeUndefined();
  });
});

describe('a quest’s workshop step', () => {
  it('says the quest step is done, so the player knows they can close the workshop', () => {
    useCity.setState({ progress: { ...base, workshops: {}, quests: { 'database-library-card': { status: 'active', step: 2, count: 0 } } } });
    open();
    render(<Workshop />);
    expect(screen.queryByText(/Quest step done/)).toBeNull();
    act(() => enter('aws sts get-caller-identity'));
    expect(useCity.getState().progress.quests?.['database-library-card']?.step).toBe(3);
    expect(screen.getByText(/Quest step done/).textContent).toBe('✓ Quest step done — you can close this');
  });

  it('says nothing when no quest was waiting on this workshop', () => {
    open();
    render(<Workshop />);
    act(() => enter('aws sts get-caller-identity'));
    expect(screen.queryByText(/Quest step done/)).toBeNull();
  });
});

describe('for real', () => {
  it('in the demo, runs in the practice terminal and pays practice, never "real"', () => {
    open();
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /Practice account \(demo\)/ }));
    expect(screen.getByRole('note').textContent).toMatch(/demo/);
    expect(screen.queryByRole('button', { name: /Open CloudShell/ })).toBeNull();
    act(() => enter('aws sts get-caller-identity'));
    expect(useCity.getState().progress.workshops?.[ID]?.steps.whoami).toBe('practice');
    // Even a "real" step from elsewhere (a check, the Copilot) is practice in the demo.
    act(() => void useCity.getState().workshopStep(ID, 'create', 'real'));
    expect(useCity.getState().progress.workshops?.[ID]?.steps.create).toBe('practice');
  });

  it('with an account, asks only for the name its check reads, filled in from practice, and says the Region', () => {
    useCity.setState({ backendKind: 'server', account: { linked: true, region: 'eu-west-2' } });
    useCity.getState().rememberWorkshop(ID, { names: { table: 'shop' } });
    open();
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
    expect(screen.getByRole('note').textContent).toMatch(/Use the same names: table shop\. Region: Europe \(London\) \(eu-west-2\)/);
    fireEvent.click(screen.getByRole('button', { name: /Create the table/ }));
    // One box for the name: it fills the command and the account check (never asked twice).
    const input = screen.getByRole('textbox', { name: /Your table name/ }) as HTMLInputElement;
    expect(input.value).toBe('shop');
    expect(screen.getAllByRole('textbox').filter((t) => t.tagName === 'INPUT')).toHaveLength(1);
    // For real, the optional Region is the linked account's, so the command runs against the Region the city checks.
    expect(document.querySelector('.workshop-cmd')?.textContent).toBe(
      'aws dynamodb create-table --table-name shop --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST --region eu-west-2',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check my account' }));
    expect(verify).toHaveBeenCalledWith(ID, 'create', { table: 'shop' });
  });

  // Seen 22 Nov 2026 in Oregon: "for real" copied `aws s3api create-bucket --bucket <bucket>`, without the location
  // constraint S3 needs outside us-east-1 and with the placeholder as typed, and CloudShell refused it.
  // Seen 23 Nov 2026: CloudShell ran in another account, so the check never found the bucket.
  it('for real, it says which account CloudShell must run in, how to see it, and where the check looked', () => {
    useCity.setState({ backendKind: 'server', account: { linked: true, accountId: '047463438585', region: 'us-west-2' }, consoleAccount: '422929814205' });
    act(() => useCity.getState().openWorkshop('s3-first-bucket'));
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
    expect(screen.getByText(/CloudShell must run in account/).textContent).toMatch(/AWSCity-8585 \(0474-6343-8585\)/);
    // Seen 23 Nov 2026: a new account's CloudShell waits for verification; the terminal is the way round it.
    expect(screen.getByText(/account verification is in progress/).textContent).toMatch(/your own terminal/);
    expect(screen.getByRole('button', { name: 'Ask AWS Support ↗' })).toBeTruthy();
    expect(screen.getByText(/--output text prints just the 12-digit number/).textContent).toMatch(/047463438585/);
    expect([...document.querySelectorAll('.workshop-account .workshop-cmd')].map((c) => c.textContent)).toEqual(['aws sts get-caller-identity --query Account --output text']);
    expect(screen.getByRole('alert').textContent).toMatch(/signed in to account 4229-2981-4205/);
  });

  // Seen 23 Nov 2026: CloudShell was blocked on a new account; the player ran the workshop in their own terminal.
  it('for real, the player picks CloudShell or their own terminal; the terminal gets a set-up-once box and no Open CloudShell', () => {
    useCity.setState({ backendKind: 'server', account: { linked: true, accountId: '047463438585', region: 'us-west-2' }, consoleAccount: undefined });
    useCity.getState().setPref('workshopShell', undefined);
    act(() => useCity.getState().openWorkshop('s3-first-bucket'));
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
    const choice = screen.getByRole('group', { name: 'Where will you run the commands?' });
    expect(within(choice).getByRole('button', { name: '☁️ CloudShell' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('button', { name: /Open CloudShell/ }).length).toBeGreaterThan(0);
    // Blocked CloudShell: one press to the terminal path.
    fireEvent.click(screen.getByRole('button', { name: 'Use my own terminal instead' }));
    expect(useCity.getState().prefs.workshopShell).toBe('terminal');
    expect(within(choice).getByRole('button', { name: '💻 My own terminal' }).getAttribute('aria-pressed')).toBe('true');
    const setup = screen.getByRole('group', { name: 'Set up your terminal once' });
    expect(setup.textContent).toMatch(/AWSCity-8585 \(0474-6343-8585\)/);
    // The Region to type is the city's (seen 24 Nov 2026: us-east-1 was picked for an Oregon city), and no placeholder
    // export is ever offered (it was pasted with <your profile> in it).
    expect(setup.textContent).toMatch(/When it asks for a Region, type us-west-2/);
    expect([...setup.querySelectorAll('.workshop-cmd')].map((c) => c.textContent)).toEqual([
      'aws --version',
      'aws login',
      'aws configure set region us-west-2',
      'aws sts get-caller-identity --query Account --output text',
    ]);
    expect(setup.textContent).toMatch(/run as you \(your own sign-in\), not as AWS City’s role/);
    expect(within(setup).getByRole('button', { name: 'Install the AWS CLI ↗' })).toBeTruthy();
    // The profile typed once (the switch card shares it) makes the export ready to paste.
    fireEvent.change(within(setup).getByLabelText('Using a named profile? (optional)'), { target: { value: 'city-047' } });
    expect(useCity.getState().prefs.awsProfile).toBe('city-047');
    expect(within(setup).getByText('export AWS_PROFILE=city-047')).toBeTruthy();
    fireEvent.change(within(setup).getByLabelText('Using a named profile? (optional)'), { target: { value: '' } });
    expect(within(setup).queryByText(/export AWS_PROFILE/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Open CloudShell/ })).toBeNull();
    // And back.
    fireEvent.click(within(choice).getByRole('button', { name: '☁️ CloudShell' }));
    expect(useCity.getState().prefs.workshopShell).toBeUndefined();
  });

  it('S3 in Oregon with no names typed: a name box, Copy waits for it, and the command keeps LocationConstraint', () => {
    useCity.setState({ backendKind: 'server', account: { linked: true, region: 'us-west-2' } });
    act(() => useCity.getState().openWorkshop('s3-first-bucket'));
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
    const copy = screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    expect(screen.getByText(/in the boxes above, then copy it/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /Your bucket name/ }), { target: { value: 'aws-city-047463438585-ws-1' } });
    expect(document.querySelector('.workshop-cmd')?.textContent).toBe('aws s3api create-bucket --bucket aws-city-047463438585-ws-1 --region us-west-2 --create-bucket-configuration LocationConstraint=us-west-2');
    expect(copy.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Check my account' }));
    expect(verify).toHaveBeenCalledWith('s3-first-bucket', 'create', { bucket: 'aws-city-047463438585-ws-1' });
  });

  // Found reviewing our code against #105 (23 Nov 2026): before the account said its Region, Copy waited for a <region>
  // that had no box to type it in.
  it('before the account says its Region, the Region gets a box too, and Copy waits for it', () => {
    useCity.setState({ backendKind: 'server', account: { linked: false } });
    act(() => useCity.getState().openWorkshop('s3-first-bucket'));
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
    const copy = screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole('textbox', { name: /Your bucket name/ }), { target: { value: 'aws-city-047463438585-ws-1' } });
    expect(copy.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Your Region code' }), { target: { value: 'us-west-2' } });
    expect(document.querySelector('.workshop-cmd')?.textContent).toBe('aws s3api create-bucket --bucket aws-city-047463438585-ws-1 --region us-west-2 --create-bucket-configuration LocationConstraint=us-west-2');
    expect(copy.disabled).toBe(false);
  });

  // Seen 23 Nov 2026 in CloudShell: "Upload a file" failed (no sample.txt there), and "testdemo" was already taken.
  it('for real, Upload a file makes the file first, in the same line', () => {
    useCity.setState({ backendKind: 'server', account: { linked: true, region: 'us-west-2' } });
    useCity.getState().rememberWorkshop('s3-first-bucket', { names: { bucket: 'city-workshop-1a2b3c4d' } });
    act(() => useCity.getState().openWorkshop('s3-first-bucket'));
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
    fireEvent.click(screen.getByRole('button', { name: /Upload a file/ }));
    expect(document.querySelector('.workshop-cmd')?.textContent).toBe(
      'echo "Hello from AWS City" > sample.txt && aws s3api put-object --bucket city-workshop-1a2b3c4d --key sample.txt --body sample.txt',
    );
    expect(screen.getByText(/It makes the small file first/)).toBeTruthy();
  });

  it('for real, the bucket box suggests a free name and says what S3 would refuse before it’s copied', () => {
    useCity.setState({ backendKind: 'server', account: { linked: true, region: 'us-west-2' } });
    act(() => useCity.getState().openWorkshop('s3-first-bucket'));
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
    const box = screen.getByRole('textbox', { name: /Your bucket name/ }) as HTMLInputElement;
    const copy = screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement;
    fireEvent.change(box, { target: { value: 'Test_Demo' } });
    expect(screen.getByRole('alert').textContent).toMatch(/lowercase letters, numbers, dots and hyphens only/);
    expect(copy.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Suggest a free name/ }));
    expect(box.value).toMatch(/^city-workshop-[0-9a-f]{8}$/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(copy.disabled).toBe(false);
  });

  // Seen 24 Nov 2026: after 🎲 the other steps still showed the old bucket until Check was pressed.
  it('a new bucket name reaches every step at once, typed or suggested', () => {
    useCity.setState({ backendKind: 'server', account: { linked: true, region: 'us-west-2' } });
    useCity.getState().rememberWorkshop('s3-first-bucket', { names: { bucket: 'old-bucket-111' } });
    act(() => useCity.getState().openWorkshop('s3-first-bucket'));
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
    fireEvent.click(screen.getByRole('button', { name: /Suggest a free name/ }));
    const suggested = (screen.getByRole('textbox', { name: /Your bucket name/ }) as HTMLInputElement).value;
    expect(useCity.getState().prefs.workshopMemory?.['s3-first-bucket']?.names.bucket).toBe(suggested);
    // Another step (Turn on versioning) shows the new name, not the old one.
    fireEvent.click(screen.getByRole('button', { name: 'Turn on versioning' }));
    expect(document.querySelector('.workshop-cmd')?.textContent).toContain(`--bucket ${suggested} `);
    expect(document.querySelector('.workshop-cmd')?.textContent).not.toContain('old-bucket-111');
    // Typed by hand: the same.
    fireEvent.change(screen.getByRole('textbox', { name: /Your bucket name/ }), { target: { value: 'typed-by-hand-222' } });
    expect(useCity.getState().prefs.workshopMemory?.['s3-first-bucket']?.names.bucket).toBe('typed-by-hand-222');
  });

  it('the account number the check should print stands out', () => {
    useCity.setState({ backendKind: 'server', account: { linked: true, region: 'us-west-2', accountId: '047463438585' } });
    act(() => useCity.getState().openWorkshop('s3-first-bucket'));
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
    expect(document.querySelector('.account-number')?.textContent).toBe('047463438585');
  });
});

// Seen 24 Nov 2026 in a terminal: the version id was typed as 1, 3 and 0 (InvalidArgument), the download "went nowhere",
// the bucket then wouldn't delete (BucketNotEmpty), and the failed clean-up check was small grey text.
describe('for real, the S3 commands just work', () => {
  const S3 = 's3-first-bucket';
  const BUCKET = 'city-workshop-1a2b3c4d';
  const LOOKUP = `aws s3api delete-object --bucket ${BUCKET} --key sample.txt --version-id "$(aws s3api head-object --bucket ${BUCKET} --key sample.txt --query VersionId --output text)"`;
  const forReal = () => {
    useCity.setState({ backendKind: 'server', account: { linked: true, region: 'us-west-2' }, chats: {} });
    useCity.getState().setPref('workshopShell', undefined);
    useCity.getState().rememberWorkshop(S3, { names: { bucket: BUCKET } });
    act(() => useCity.getState().openWorkshop(S3));
    render(<Workshop />);
    fireEvent.click(screen.getByRole('button', { name: /For real \(CloudShell or your terminal\)/ }));
  };
  const paste = (text: string) => {
    const box = document.querySelector('.workshop-error') as HTMLDetailsElement;
    fireEvent.change(within(box).getByRole('textbox', { name: 'The error you got' }), { target: { value: text } });
    fireEvent.click(within(box).getByRole('button', { name: 'Help me fix it' }));
    return box;
  };

  it('Delete the file’s version looks its id up (no box to type it in); practice still asks for it', () => {
    forReal();
    fireEvent.click(screen.getByRole('button', { name: /^Delete the file's version/ }));
    expect(document.querySelector('.workshop-cmd')?.textContent).toBe(LOOKUP);
    expect(screen.queryByRole('textbox', { name: /Your version/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/the \$\(…\) part looks the version id up for you/)).toBeTruthy();
    // The practice terminal keeps the command that teaches the version id.
    fireEvent.click(screen.getByRole('button', { name: /Practice terminal/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delete the file's version/ }));
    expect(document.querySelector('.workshop-cmd')?.textContent).toMatch(/--version-id <version>$/);
  });

  it('Download it again prints the file it saved', () => {
    forReal();
    fireEvent.click(screen.getByRole('button', { name: /^Download it again/ }));
    expect(document.querySelector('.workshop-cmd')?.textContent).toBe(`aws s3api get-object --bucket ${BUCKET} --key sample.txt downloaded-sample.txt && cat downloaded-sample.txt`);
  });

  it('BucketNotEmpty and a wrong version id come with a command to copy, the bucket filled in, with no agent call', () => {
    forReal();
    const calls = asked.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /^Delete the bucket/ }));
    fireEvent.click(screen.getByText('I got an error'));
    let box = paste('An error occurred (BucketNotEmpty) when calling the DeleteBucket operation: The bucket you tried to delete is not empty. You must delete all versions in the bucket.');
    expect(box.textContent).toMatch(/Something is still inside/);
    expect(box.querySelector('.workshop-cmd')?.textContent).toBe(`${LOOKUP} && aws s3api delete-bucket --bucket ${BUCKET}`);
    expect(within(box).getByRole('button', { name: 'Copy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Delete the file's version/ }));
    fireEvent.click(screen.getByText('I got an error'));
    box = paste('aws: [ERROR]: An error occurred (InvalidArgument) when calling the DeleteObject operation: Invalid version id specified');
    expect(box.textContent).toMatch(/S3 version ids are long strings like KcvdShWg…, not 1 or 0/);
    expect(box.querySelector('.workshop-cmd')?.textContent).toBe(LOOKUP);
    expect(asked.mock.calls.length).toBe(calls);
  });

  it('a clean-up check that finds the bucket still there is a warning, without the "which account" line', () => {
    forReal();
    useCity.setState({ account: { linked: true, accountId: '047463438585', region: 'us-west-2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Delete the bucket/ }));
    act(() => useCity.getState().applyServerEvent({ type: 'workshop.verified', workshopId: S3, stepId: 'cleanup', ok: false, detail: `S3 bucket ${BUCKET} is still there. Delete it, then check again.` }));
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toBe(`⚠️ S3 bucket ${BUCKET} is still there. Delete it, then check again.`);
    expect(warning.className).toBe('field-error');
    expect(screen.queryByText(/The city looked in account/)).toBeNull();
    // A check that wants the thing there still says where it looked.
    fireEvent.click(screen.getByRole('button', { name: /^Create the bucket/ }));
    act(() => useCity.getState().applyServerEvent({ type: 'workshop.verified', workshopId: S3, stepId: 'create', ok: false, detail: `No S3 bucket called ${BUCKET}.` }));
    expect(screen.getByText(/The city looked in account/)).toBeTruthy();
  });
});

// Seen 22 Nov 2026: "Help me fix it" said the answer would come up in the Feed, and the player couldn't find it.
describe('I got an error', () => {
  it('an unknown error is asked of the building’s agent, and the answer shows here under the step', () => {
    open();
    render(<Workshop />);
    fireEvent.click(screen.getByText('I got an error'));
    fireEvent.change(screen.getByRole('textbox', { name: 'The error you got' }), { target: { value: 'aws: error: argument operation: Invalid choice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Help me fix it' }));
    expect(asked).toHaveBeenCalled();
    const districtId = asked.mock.calls[0]![0];
    expect(document.querySelector('.workshop-answer')?.textContent).toMatch(/is reading your error/);
    act(() => useCity.getState().applyServerEvent({ type: 'chat.answer', requestId: 'err-1', districtId, agentId: 'dynamodb', delta: 'The command name is misspelled: use create-table.', done: true }));
    expect(document.querySelector('.workshop-answer')?.textContent).toMatch(/misspelled: use create-table/);
  });

  it('a command in the agent’s answer gets its own Copy button', () => {
    useCity.setState({ chats: {} }); // the test above answered request err-1 already
    open();
    render(<Workshop />);
    fireEvent.click(screen.getByText('I got an error'));
    fireEvent.change(screen.getByRole('textbox', { name: 'The error you got' }), { target: { value: 'aws: error: something odd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Help me fix it' }));
    expect(document.querySelector('.workshop-thinking')?.textContent).toMatch(/is reading your error/);
    const districtId = asked.mock.calls.at(-1)![0];
    act(() => useCity.getState().applyServerEvent({ type: 'chat.answer', requestId: 'err-1', districtId, agentId: 'dynamodb', delta: 'Run `aws dynamodb list-tables --region us-west-2` to see your tables.', done: true }));
    expect(screen.getByText(/Copy a command below/)).toBeTruthy();
    const chip = document.querySelector('.workshop-answer .code-row .workshop-cmd');
    expect(chip?.textContent).toBe('aws dynamodb list-tables --region us-west-2');
    expect(document.querySelector('.workshop-answer .code-row button')?.textContent).toBe('Copy');
  });

  // Seen 24 Nov 2026: after a look at Deploy the answer was gone ("Why is it gone?").
  it('the question and its answer are still there after leaving the workshop and coming back', () => {
    useCity.setState({ chats: {}, backendKind: 'mock' });
    act(() => useCity.getState().openWorkshop('s3-first-bucket'));
    render(<Workshop />);
    fireEvent.click(screen.getByText('I got an error'));
    fireEvent.change(screen.getByRole('textbox', { name: 'The error you got' }), { target: { value: 'aws: error: a brand new problem' } });
    fireEvent.click(screen.getByRole('button', { name: 'Help me fix it' }));
    const districtId = asked.mock.calls.at(-1)![0];
    act(() => useCity.getState().applyServerEvent({ type: 'chat.answer', requestId: 'err-1', districtId, agentId: 's3', delta: 'Check the bucket name.', done: true }));
    cleanup();
    render(<Workshop />);
    expect((document.querySelector('.workshop-error') as HTMLDetailsElement).open).toBe(true);
    expect((screen.getByRole('textbox', { name: 'The error you got' }) as HTMLTextAreaElement).value).toBe('aws: error: a brand new problem');
    expect(document.querySelector('.workshop-answer')?.textContent).toMatch(/Check the bucket name/);
  });
});

describe('a finished workshop', () => {
  it('shows one "Workshop complete" card and closes the workshop panel', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flyTo = vi.fn();
    const off = bus.on('flyTo', flyTo);
    open();
    render(
      <>
        <Workshop />
        <WorkshopDone />
      </>,
    );
    act(() => {
      for (const id of ['whoami', 'create', 'wait', 'put', 'get', 'cleanup']) useCity.getState().workshopStep(ID, id, 'practice');
    });
    expect(useCity.getState().progress.workshops?.[ID]?.done).toBeTruthy();
    act(() => vi.advanceTimersByTime(DONE_CARD_MS));
    expect(screen.getByRole('dialog', { name: 'Workshop complete!' })).toBeTruthy();
    expect(useCity.getState().workshopOpen).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: /See .* in the city/ }));
    expect(flyTo).toHaveBeenCalledWith({ id: 'dynamodb' });
    expect(screen.queryByRole('dialog', { name: 'Workshop complete!' })).toBeNull();
    off();
  });
});
