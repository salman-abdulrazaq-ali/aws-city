import Phaser from 'phaser';
import { createCharacterAnims, preloadIndexes, queueAssets } from '../assets';
import { crisp, PIXEL_FONT, TEXT_FONT } from '../SpeechBubble';
import { COLOR, CSS, FONT_SIZE, TIP_STYLE } from '../theme';
import { quietCity } from '@/state/firstSteps';
import { useCity } from '@/state/store';

const TIPS = [
  'Tip: every AWS console page you open builds a landmark.',
  'Tip: press E next to an agent to talk.',
  'Tip: flashcards come back right before you’d forget them.',
  'Tip: agents never change your AWS account without your OK.',
];

/** Loads indexes, then every atlas/sheet/sound they list, then the pixel font, then starts the city. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  preload() {
    preloadIndexes(this);
  }

  create() {
    const { width, height } = this.scale;
    // A pixel progress bar: 16 blocks that light up as the city's assets arrive.
    const BLOCKS = 16;
    const bw = 10;
    const x0 = width / 2 - (BLOCKS * (bw + 2)) / 2;
    this.add.rectangle(width / 2, height / 2, BLOCKS * (bw + 2) + 8, 20, COLOR.bgDeep).setStrokeStyle(2, COLOR.line);
    const blocks = Array.from({ length: BLOCKS }, (_, i) => this.add.rectangle(x0 + i * (bw + 2) + 1, height / 2, bw, 12, COLOR.panelHi).setOrigin(0, 0.5));
    crisp(this.add.text(width / 2, height / 2 - 28, 'Building AWS City…', { fontFamily: TEXT_FONT, fontSize: FONT_SIZE.lg, fontStyle: '800', color: CSS.accent })).setOrigin(0.5);
    // A new player (a first run's map, or the first steps) gets no keyboard tip: "press E" was never explained there.
    const { prefs, progress } = useCity.getState();
    const tips = !prefs.region || quietCity(progress, prefs) ? TIPS.filter((t) => !t.includes('press E ')) : TIPS;
    const tip = tips[Math.floor(Math.random() * tips.length)];
    crisp(this.add.text(width / 2, height / 2 + 28, tip, { ...TIP_STYLE, fontFamily: TEXT_FONT, align: 'center', wordWrap: { width: Math.min(320, width - 56) } })).setOrigin(0.5, 0);
    this.load.on('progress', (v: number) => blocks.forEach((b, i) => b.setFillStyle(i < Math.round(v * BLOCKS) ? COLOR.accent : COLOR.panelHi)));
    queueAssets(this);
    this.load.once('complete', async () => {
      createCharacterAnims(this);
      await Promise.race([Promise.all([document.fonts.load(`800 13px ${TEXT_FONT}`), document.fonts.load(`12px ${PIXEL_FONT}`)]), new Promise((r) => setTimeout(r, 1500))]);
      // The game may have been destroyed during the font wait (React StrictMode mounts twice): then there's no city to start.
      this.scene?.start('city');
    });
    this.load.start();
  }
}
