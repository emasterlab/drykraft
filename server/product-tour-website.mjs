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
      <video controls playsinline preload="none" width="1920" height="1080"
        poster="/videos/drykraft-product-tour.jpg" aria-label="DryKraft full product tour">
        <source src="/videos/drykraft-product-tour.mp4" type="video/mp4">
        <track kind="captions" src="/videos/drykraft-product-tour.vtt" srclang="en" label="English">
        <track kind="chapters" src="/videos/drykraft-product-tour-chapters.vtt" srclang="en" label="Product chapters">
        <p><a href="/videos/drykraft-product-tour.mp4">Open the full product tour</a>.</p>
      </video>
      <p class="full-tour-access"><a href="/videos/drykraft-product-tour.vtt">English captions</a> · <a href="/videos/drykraft-product-tour.mp4">Open video directly</a></p>
    </section>`;
}
