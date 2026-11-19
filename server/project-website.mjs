export function renderProjectWebsite() {
  return `
    <div class="project-page">
      <section class="project-hero section" aria-labelledby="project-heading">
        <div class="project-intro">
          <h1 id="project-heading">DryKraft, with the source in your hands.</h1>
          <p>DryKraft brings CRM, sales, finance, outreach, and automation into one workspace. Read the source or run it on your own infrastructure for personal, noncommercial use.</p>
          <div class="project-actions">
            <a class="button primary" href="https://github.com/emasterlab/drykraft">View source on GitHub</a>
            <a class="text-link" href="#local-setup">See local setup</a>
          </div>
        </div>
        <div class="project-terminal" id="local-setup" aria-labelledby="setup-heading">
          <h2 id="setup-heading">Run DryKraft locally</h2>
          <p>Install Node.js 22 or later and start PostgreSQL and Redis. Then run the following:</p>
          <pre><code>git clone https://github.com/emasterlab/drykraft.git
cd drykraft
npm ci
npm run setup
npm run dev</code></pre>
          <p>Open <code>http://localhost:5173</code> to set up your workspace.</p>
        </div>
      </section>
      <section class="project-paths section" aria-labelledby="explore-heading">
        <h2 id="explore-heading">Explore the project</h2>
        <div class="project-path-list">
          <a href="/docs">
            <strong>Product documentation</strong>
            <span>Learn how workspaces, records, and workflows fit together.</span>
          </a>
          <a href="/docs/api">
            <strong>API reference</strong>
            <span>Find endpoints, request examples, and how to authenticate.</span>
          </a>
          <a href="https://github.com/emasterlab/drykraft/blob/main/CONTRIBUTING.md">
            <strong>Get involved</strong>
            <span>Find out how to propose a change or report a problem.</span>
          </a>
        </div>
      </section>
      <section class="project-release section" aria-labelledby="release-heading">
        <h2 id="release-heading">Personal and noncommercial use</h2>
        <p>DryKraft is source-available under a personal and noncommercial use license. For commercial use, contact <a href="mailto:support@drykraft.com">support@drykraft.com</a>. <a href="https://github.com/emasterlab/drykraft/blob/main/LICENSE">Read the license</a>.</p>
      </section>
    </div>`;
}
