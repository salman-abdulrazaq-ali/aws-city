import { browser } from 'wxt/browser';

/**
 * True when a runtime message came from a content script on a web page (it has a tab and the page's URL), not from this
 * extension's background or its own pages. A compromised console page can make its content script send anything, so
 * messages only the extension sends (page focus, Copilot steps) ignore it.
 */
export const fromWebPage = (sender: { tab?: unknown; url?: string } | undefined, extensionRoot = browser.runtime.getURL('/')) =>
  !!sender?.tab && !(sender.url ?? '').startsWith(extensionRoot);
