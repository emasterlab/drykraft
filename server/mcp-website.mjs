const endpoint='https://app.drykraft.com/api/mcp';

export function renderMcpPage(){
  return `<div class="project-page mcp-page">
    <section class="project-hero section" aria-labelledby="mcp-heading">
      <div class="project-intro">
        <h1 id="mcp-heading">Your workspace, inside your AI assistant.</h1>
        <p>Bring DryKraft into Claude or Codex. Find customer records, review invoices, and follow your sales pipeline from the conversation you’re already in.</p>
        <div class="mcp-url"><code id="mcp-endpoint">${endpoint}</code><button class="button" type="button" data-copy-mcp="mcp-endpoint">Copy URL</button></div>
        <div class="project-actions"><a class="button primary" href="#mcp-setup">Connect your assistant</a><a class="text-link" href="#mcp-capabilities">Explore capabilities</a></div>
      </div>
      <div class="project-terminal">
        <h2>Try it after connecting</h2>
        <p>“Find the Northstar deal and summarize its recent activity.”</p>
        <p>“Show me which invoices are overdue this month.”</p>
        <p>“What appointments are on my calendar this week?”</p>
      </div>
    </section>
    <section class="project-paths section" id="mcp-setup" aria-labelledby="mcp-setup-heading">
      <h2 id="mcp-setup-heading">Choose your AI client</h2>
      <p>DryKraft hosts the connection. Add it once, sign in and choose the workspace you want to share.</p>
      <div class="mcp-clients">
        <details open><summary>Claude</summary>
          <ol><li>Open <strong>Settings → Connectors → Add custom connector</strong>.</li><li>Paste the DryKraft MCP URL above and choose <strong>Connect</strong>.</li><li>Sign in to DryKraft and approve workspace access.</li></ol>
        </details>
        <details><summary>Claude Code</summary>
          <p>Add the hosted server, then open <code>/mcp</code> in Claude Code to authenticate DryKraft.</p>
          <div class="mcp-snippet"><pre><code id="mcp-claude-code">claude mcp add --transport http drykraft ${endpoint}</code></pre><button class="button" type="button" data-copy-mcp="mcp-claude-code">Copy command</button></div>
        </details>
        <details><summary>Codex</summary>
          <p>Add the hosted server and sign in when the browser opens.</p>
          <div class="mcp-snippet"><pre><code id="mcp-codex">codex mcp add drykraft --url ${endpoint}
codex mcp login drykraft</code></pre><button class="button" type="button" data-copy-mcp="mcp-codex">Copy commands</button></div>
        </details>
      </div>
      <p class="mcp-copy-status" data-mcp-copy-status role="status"></p>
    </section>
    <section class="project-release section" id="mcp-capabilities">
      <h2>What you can do from chat</h2>
      <dl class="mcp-capabilities">
        <div><dt>CRM and sales</dt><dd>Find people, companies and deals. Inspect related activity and pipeline stages.</dd></div>
        <div><dt>Finance</dt><dd>Review invoices, expenses and purchase orders. Inspect balances and payment status.</dd></div>
        <div><dt>Outreach and automation</dt><dd>Review campaigns, email warmup and workflow executions.</dd></div>
        <div><dt>Calendar and reporting</dt><dd>Check appointments, review dashboard metrics and query workspace reports.</dd></div>
      </dl>
      <details class="mcp-faq"><summary>What can my AI assistant access?</summary><p>Each connection belongs to one workspace. Read-only is selected by default. If your role allows edits, you can grant write access and confirm changes in your assistant.</p></details>
      <details class="mcp-faq"><summary>How do I disconnect?</summary><p>In DryKraft, open <strong>Settings → Account security → MCP access</strong> and choose <strong>Revoke access</strong>. Signing out of the approving browser session also ends the connection.</p></details>
    </section>
  </div>`;
}
