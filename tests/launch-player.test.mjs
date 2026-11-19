import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { renderLaunchFilm, renderProductTour } from '../server/product-tour-website.mjs';

test('the short launch film keeps its native player, captions and chapters', () => {
  const html = renderLaunchFilm();
  assert.match(html, /<video class="site-video-player" controls playsinline preload="none"/);
  assert.ok(html.includes('<source src="/videos/drykraft-launch.mp4"'));
  assert.ok(html.includes('<track kind="captions" src="/videos/drykraft-launch.vtt"'));
  assert.ok(html.includes('<track kind="chapters" src="/videos/drykraft-launch-chapters.vtt"'));
  assert.ok(existsSync(new URL('../public/videos/drykraft-launch-chapters.vtt', import.meta.url)));
});

test('the full tour embeds YouTube and offers comment, subscription and direct playback links', () => {
  const html = renderProductTour();
  assert.match(html, /<iframe class="site-video-player"/);
  assert.ok(html.includes('src="https://www.youtube-nocookie.com/embed/JR_Pr-BZ1jc"'));
  assert.ok(html.includes('referrerpolicy="strict-origin-when-cross-origin"'));
  assert.ok(html.includes('href="https://youtu.be/JR_Pr-BZ1jc">Leave a comment on YouTube'));
  assert.ok(html.includes('href="https://www.youtube.com/@DryKraft?sub_confirmation=1">Subscribe on YouTube'));
  assert.ok(html.includes('href="/videos/drykraft-product-tour.mp4"'));
});
