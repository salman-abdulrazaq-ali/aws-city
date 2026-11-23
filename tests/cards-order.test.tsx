// @vitest-environment jsdom
// Priya's playtest: a new player's S3 deck starts with the basics, and "Tell me more" starts folded on every card.
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { dueDeck } = await import('@/state/srs');
const { cardsFor } = await import('@/world/content');
const { Flashcards } = await import('@/ui/Flashcards');

afterEach(cleanup);

describe('a new player’s S3 deck', () => {
  it('teaches buckets, objects, storage classes and Lifecycle before S3 Tables and S3 Vectors', () => {
    const p = useCity.getState().progress;
    const order = dueDeck({ ...p, cards: {} }, ['s3'], 99).map((c) => c.q);
    const at = (text: string) => order.findIndex((q) => q.includes(text));
    for (const basic of ['What is Amazon S3?', 'storage classes', 'Lifecycle'])
      for (const later of ['S3 Tables?', 'S3 Vectors for?']) expect(at(basic), `${basic} before ${later}`).toBeLessThan(at(later));
    // Lifecycle is a storage basic (it moves objects between classes): a Practitioner card, not Expert.
    expect(cardsFor('s3').find((c) => c.q.includes('Lifecycle'))!.tier).toBe(2);
  });
});

describe('"Tell me more"', () => {
  it('starts folded on the next card, whatever the last one was left at', () => {
    const p = useCity.getState().progress;
    act(() => useCity.setState({ progress: { ...p, landmarks: { s3: { discovered: true, xp: 0 } }, cards: {}, quests: {} }, selected: 's3', view: { name: 'city' } }));
    const { container } = render(<Flashcards />);
    const more = () => container.querySelector<HTMLDetailsElement>('details.tell-more')!;
    const question = () => container.querySelector('.flash-face.front .flash-text')!.textContent;
    fireEvent.keyDown(window, { key: 'f' });
    more().open = true;
    const first = question();
    fireEvent.keyDown(window, { key: '3' });
    expect(question()).not.toBe(first);
    fireEvent.keyDown(window, { key: 'f' });
    expect(more().open).toBe(false);
  });
});

describe('the glossary', () => {
  it('names no one Region’s AZ as its example: a popover over another Region’s city would contradict it (Hiroshi)', async () => {
    const { default: glossary } = await import('../shared/glossary.json', { with: { type: 'json' } });
    const az = glossary.terms.find((t: { term: string }) => t.term === 'Availability Zone')!;
    expect(az.short).not.toMatch(/\b[a-z]{2}(-gov)?-[a-z]+-\d[a-z]\b/);
  });
});

describe('the demo’s keyword routing (Marcus)', () => {
  it('"Deploy a static website for me" goes to S3, never EBS: a keyword counts only at the start of a word', async () => {
    const { matchText } = await import('@/world/taxonomy');
    expect(matchText('Deploy a static website for me')).toBe('s3');
    expect(matchText('Attach an EBS volume')).toBe('ebs');
    expect(matchText('Snapshot my disk')).toBe('ebs');
  });
});
