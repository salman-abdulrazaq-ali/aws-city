// @vitest-environment jsdom
// Okafor's playtest: coaching lines read as help, and a new step's terminal keeps the keys out of the city.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const { PracticeTerminal } = await import('@/ui/PracticeTerminal');

afterEach(cleanup);

const step = { cli: 'aws s3api create-bucket --bucket <bucket> --region <region>', output: '{}' };

describe('the practice terminal', () => {
  it('shows a "Practice terminal:" coaching line as help, and the CLI’s own error as an error', () => {
    const { container } = render(<PracticeTerminal step={{ cli: 'aws s3api put-object --bucket <bucket> --key a.txt --body a.txt', output: '' }} onPass={() => {}} label="t" />);
    const send = (line: string) => {
      fireEvent.change(container.querySelector('textarea')!, { target: { value: line } });
      fireEvent.submit(container.querySelector('form')!);
    };
    send('aws s3api put-object --bucket b1 --key a.txt');
    expect(container.querySelector('.terminal-line.help')?.textContent).toMatch(/^Practice terminal:/);
    send('aws s3api put-objekt --bucket b1 --key a.txt --body a.txt');
    expect(container.querySelector('.terminal-line.err')?.textContent).toContain("Found invalid choice 'put-objekt'");
  });

  it('takes the focus a passed step dropped (none on the page), so typing never reaches the city', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const { container } = render(<PracticeTerminal step={step} onPass={() => {}} label="t" />);
    expect(document.activeElement).toBe(container.querySelector('textarea'));
  });

  it('leaves the focus where the player put it', () => {
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    render(<PracticeTerminal step={step} onPass={() => {}} label="t" />);
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});
