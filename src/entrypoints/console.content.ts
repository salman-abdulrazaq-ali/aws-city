// Console Copilot: runs inside AWS console pages. The work happens in src/console/agent.ts (shared with the practice
// console, src/entrypoints/practice/, which imports it directly: extension pages can't take content scripts). It only
// acts while the player has started a Copilot task from the city, and only on console pages.
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { startCopilotAgent } from '@/console/agent';
import { consoleAccount } from '@/console/consoleAccount';
import { isConsoleUrl } from '@/console/safety';

export type { CopilotMessage, StepResult } from '@/console/agent';

export default defineContentScript({
  matches: ['https://*.console.aws.amazon.com/*', 'https://console.aws.amazon.com/*'],
  runAt: 'document_idle',
  main() {
    if (!isConsoleUrl(location.href)) return;
    // Which account this console is signed into, so the city can warn when it isn't the linked one (consoleAccount.ts).
    // Only the id goes to the extension's own pages; it's never sent to the server.
    const tell = () => void browser.runtime.sendMessage({ type: 'console.account', account: consoleAccount(location.host, document.cookie) ?? null }).catch(() => {});
    tell();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tell();
    });
    startCopilotAgent();
  },
});
