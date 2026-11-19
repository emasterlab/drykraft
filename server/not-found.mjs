export function renderNotFound({ workspaceHost = false } = {}) {
  const homeLabel = workspaceHost ? 'Back to workspace' : 'Back to homepage';
  const secondaryLink = workspaceHost
    ? '<a class="not-found-secondary" href="/login">Sign in</a>'
    : '<a class="not-found-secondary" href="/docs">Browse documentation</a>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#ffffff">
  <title>Page not found - DryKraft</title>
  <link rel="icon" href="/icon-ui.png">
  <link rel="stylesheet" href="/404.css">
</head>
<body class="not-found-page">
  <header class="not-found-header">
    <a href="/" aria-label="DryKraft home"><img src="/logo-ui.png" width="144" height="56" alt="DryKraft"></a>
  </header>
  <main class="not-found-main">
    <div class="not-found-copy">
      <h1>Page not found.</h1>
      <p>The link may be out of date, or the page may have moved. You can head back or try one of the links below.</p>
      <div class="not-found-actions">
        <a class="not-found-primary" href="/">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6-6 6 6 6M4 12h16"/></svg>
          ${homeLabel}
        </a>
        ${secondaryLink}
      </div>
    </div>
    <div class="not-found-art" aria-hidden="true">
      <span class="not-found-orbit"></span>
      <span class="not-found-route"></span>
      <div class="not-found-code">4<span class="not-found-zero"></span>4</div>
    </div>
  </main>
  <footer class="not-found-footer">
    <span>404 · Page unavailable</span>
    <a href="mailto:support@drykraft.com">Contact support</a>
  </footer>
</body>
</html>`;
}
