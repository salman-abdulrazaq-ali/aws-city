// Okafor's playtest, at 400 px and at night: these are layout rules jsdom can't measure, so the rules themselves are
// checked in the stylesheets and the scene.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
/** The declarations of one rule (its exact selector), joined. */
const rule = (css: string, selector: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => sel.split(',').map((x) => x.trim()).includes(selector)).map(([, , body]) => body).join(';');

describe('nothing pushes the side panel wider than itself', () => {
  const workshops = read('src/app/styles/23-workshops.css');
  const chat = read('src/app/styles/08-chat.css');

  it('the template YAML scrolls inside its box and never widens the card', () => {
    expect(rule(workshops, '.template-yaml')).toMatch(/overflow:\s*auto/);
    expect(rule(workshops, '.template-yaml')).toMatch(/contain:\s*inline-size/);
  });

  it('a North Hall talk’s answers and sources wrap', () => {
    expect(rule(workshops, '.north-hall .btn')).toMatch(/white-space:\s*normal/);
    expect(rule(workshops, '.north-hall')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('an HQ chat reply wraps a long ARN or command', () => {
    expect(rule(chat, '.bubble')).toMatch(/min-width:\s*0/);
    expect(rule(chat, '.bubble')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('the courier tip bubble at night', () => {
  it('sits over the night overlay and the window lights, so no light draws over its words', () => {
    const scene = read('src/game/scenes/CityScene.ts');
    const depth = Number(/const INFO_BUBBLE_DEPTH = ([\d_]+);/.exec(scene)![1].replace(/_/g, ''));
    expect(scene).toContain('new SpeechBubble(this, 260).setDepth(INFO_BUBBLE_DEPTH)');
    expect(depth).toBeGreaterThan(70_002);
  });
});
