import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { renderLaunchFilm, renderProductTour } from '../server/product-tour-website.mjs';

test('both homepage films use the same native player and separate media tracks', () => {
  for (const [render, name] of [
    [renderLaunchFilm, 'drykraft-launch'],
    [renderProductTour, 'drykraft-product-tour'],
  ]) {
    const html = render();
    assert.match(html, /<video class="site-video-player" controls playsinline preload="none"/);
    assert.ok(html.includes('<source src="/videos/' + name + '.mp4"'));
    assert.ok(html.includes('<track kind="captions" src="/videos/' + name + '.vtt"'));
    assert.ok(html.includes('<track kind="chapters" src="/videos/' + name + '-chapters.vtt"'));
    assert.ok(existsSync(new URL('../public/videos/' + name + '-chapters.vtt', import.meta.url)));
  }
});
