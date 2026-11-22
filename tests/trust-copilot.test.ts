// The Console Copilot's typed goal leaves the page redacted, as the privacy policy says (Dana's playtest, 22 Nov 2026:
// an email, an account id and a key showed verbatim on the task card and went out in console.start).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ConnectionStatus, SaveState } from '@/backend/AgentBackend';
import type { ClientCommand, ServerEvent } from '@/backend/contract';

/** Just enough backend for the runtime: it records what is sent. */
class FakeBackend {
  readonly kind = 'server' as const;
  readonly deployMode = 'guarded' as const;
  sent: ClientCommand[] = [];
  connect() {}
  disconnect() {}
  onEvent(_cb: (e: ServerEvent) => void) {
    return () => undefined;
  }
  onStatus(_cb: (s: ConnectionStatus) => void) {
    return () => undefined;
  }
  onSave(_cb: (s: SaveState) => void) {
    return () => undefined;
  }
  send(cmd: ClientCommand) {
    this.sent.push(cmd);
  }
  async uploadScreenshot() {
    return 'shot-1';
  }
  async getProgress() {
    return null;
  }
  putProgress() {}
  playerId() {
    return undefined;
  }
  async signOut() {}
}

let fake: FakeBackend;
vi.mock('@/backend', () => ({ createBackend: () => fake }));

describe('the Copilot goal is redacted before it leaves the page', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    fake = new FakeBackend();
  });
  afterEach(() => vi.restoreAllMocks());

  it('console.start carries the redacted goal, and the task card shows what was sent', async () => {
    vi.resetModules();
    const rt = await import('@/app/runtime');
    const { useCity } = await import('@/state/store');
    rt.startRuntime('panel');
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ snapshot: { url: 'https://us-east-1.console.aws.amazon.com/s3/home', title: 'S3', items: [] } } as never);
    useCity.setState({ focus: { tabId: 7, url: 'https://us-east-1.console.aws.amazon.com/s3/home', title: 'S3', kind: 'console', serviceId: 's3' } });

    const taskId = await rt.startConsoleCopilot('  Make a bucket for alice@example.com in 1234-5678-9012 using akiaiosfodnn7example  ');
    const start = fake.sent.find((c): c is Extract<ClientCommand, { action: 'console.start' }> => c.action === 'console.start');
    expect(start?.goal).toBe('Make a bucket for [email] in [account] using [key]');
    expect(JSON.stringify(fake.sent)).not.toMatch(/alice@example\.com|1234-5678-9012|akiaiosfodnn7example/);
    expect(useCity.getState().tasks[taskId!]!.prompt).toBe('🖥️ Make a bucket for [email] in [account] using [key]');
    rt.stopConsoleCopilot();
  });
});
