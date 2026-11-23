// @vitest-environment jsdom
// Marcus's playtest: a removal's preview says what a practice removal does, never "free, nothing is created".
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { CostNote } = await import('@/ui/DeployPanel');

afterEach(cleanup);

describe('a preview’s cost line in the demo', () => {
  it('a removal says what practice removes, with "Practice:" once', () => {
    useCity.setState({ backendKind: 'mock' });
    const { container } = render(<CostNote note="Practice: nothing real is removed. In your own account this stops its charges, permanently." />);
    const text = container.textContent ?? '';
    expect(text).toContain('nothing real is removed');
    expect(text).not.toContain('nothing is created');
    expect(text.match(/Practice:/g)).toHaveLength(1);
  });

  it('a build still reads as free practice, with the real estimate for learners', () => {
    useCity.setState({ backendKind: 'mock' });
    const { container } = render(<CostNote note="About $0.50 a month" />);
    expect(container.textContent).toContain('Practice: free, nothing is created.');
  });
});
