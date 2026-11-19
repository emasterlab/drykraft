const tourOnYouTube = 'https://youtu.be/JR_Pr-BZ1jc';
const subscribeOnYouTube = 'https://www.youtube.com/@DryKraft?sub_confirmation=1';

function renderVideoPlayer({ video, poster, captions, chapters, label }) {
  return `
    <video class="site-video-player" controls playsinline preload="none" width="1920" height="1080"
      poster="${poster}" aria-label="${label}">
      <source src="${video}" type="video/mp4">
      <track kind="captions" src="${captions}" srclang="en" label="English">
      <track kind="chapters" src="${chapters}" srclang="en" label="Chapters">
      <p><a href="${video}">Open the video directly</a>.</p>
    </video>
    <p class="site-video-access"><a href="${captions}">English captions</a> · <a href="${video}">Open video directly</a></p>`;
}

export function renderLaunchFilm() {
  return `
    <section class="section launch-section" id="launch-film" aria-labelledby="launch-heading">
      <div class="section-intro">
        <div>
          <h2 id="launch-heading">Meet DryKraft.<br>In 31 seconds.</h2>
          <p>One customer workspace, from the first contact to the next follow-up. Watch the launch.</p>
        </div>
        <a class="text-link" href="/product">Explore the platform</a>
      </div>
      ${renderVideoPlayer({
        video: '/videos/drykraft-launch.mp4',
        poster: '/videos/drykraft-launch-poster.jpg',
        captions: '/videos/drykraft-launch.vtt',
        chapters: '/videos/drykraft-launch-chapters.vtt',
        label: 'DryKraft short launch film',
      })}
      <details class="launch-caption">
        <summary>Read the video summary</summary>
        <p>The film shows how DryKraft brings customer records, sales pipelines, invoices, expenses, outreach, workflows and dashboards into one workspace. Screens and totals are illustrative.</p>
      </details>
    </section>`;
}

export function renderProductTour() {
  return `
    <section class="section full-tour" id="product-tour" aria-labelledby="product-tour-heading">
      <div class="section-intro">
        <div>
          <h2 id="product-tour-heading">See the full customer journey.</h2>
          <p>Follow a lead through sales, calendar booking, outreach, invoicing and automation. The 4-minute, 20-second tour also shows email warmup and how the transactional outbox works.</p>
        </div>
        <a class="text-link" href="/docs">Browse product guides</a>
      </div>
      <iframe class="site-video-player" width="1920" height="1080"
        src="https://www.youtube-nocookie.com/embed/JR_Pr-BZ1jc"
        title="DryKraft product tour on YouTube" loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"
        allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>
      <p class="tour-feedback">What should we demo next? Leave a comment on YouTube and subscribe for new DryKraft walkthroughs.</p>
      <div class="tour-youtube-actions">
        <a class="button secondary small" href="${tourOnYouTube}">Leave a comment on YouTube</a>
        <a class="button primary small" href="${subscribeOnYouTube}">Subscribe on YouTube</a>
      </div>
      <p class="site-video-access"><a href="/videos/drykraft-product-tour.mp4">Open the MP4 directly</a> · <a href="/videos/drykraft-product-tour.vtt">English captions</a></p>
    </section>`;
}
