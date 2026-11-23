export function renderMcpPage(){
  return `<div class="project-page">
    <section class="project-hero section" aria-labelledby="mcp-heading">
      <div class="project-intro">
        <h1 id="mcp-heading">Work in DryKraft from your coding agent.</h1>
        <p>Connect Claude Code or Codex to look up customer records, review invoices, check email warmup, and manage workflows using your workspace permissions.</p>
        <div class="project-actions"><a class="button primary" href="#mcp-setup">Set up MCP</a><a class="text-link" href="/docs/api">Browse the API</a></div>
      </div>
      <div class="project-terminal">
        <h2>Try these requests</h2>
        <p>“Show me the next five calendar appointments.”</p>
        <p>“Find the Northstar deal and its recent activity.”</p>
        <p>“Check the daily allowance for our email warmup.”</p>
      </div>
    </section>
    <section class="project-paths section" id="mcp-setup" aria-labelledby="mcp-setup-heading">
      <h2 id="mcp-setup-heading">Connect your workspace</h2>
      <ol class="mcp-steps">
        <li>Open <strong>Settings → Account security → MCP access</strong> in DryKraft. Create a read-only token to get started. Choose read and write when you want the agent to make changes.</li>
        <li>Clone the repository and install with Node.js 22.12 or later.
          <pre><code>git clone https://github.com/emasterlab/drykraft.git
cd drykraft
npm ci</code></pre>
        </li>
        <li>Save these values in a private file outside the repository, such as <code>~/.config/drykraft/mcp.env</code>. Use your workspace origin for self-hosted instances. Paste the generated token after the equals sign and restrict the file to your account.
          <pre><code>DRYKRAFT_MCP_URL=https://app.drykraft.com
DRYKRAFT_MCP_TOKEN=</code></pre>
        </li>
        <li>Run the command for your client from the checkout, then restart the client or start a new session.
          <h3>Claude Code</h3>
          <pre><code>claude mcp add --transport stdio --scope user drykraft \\
  --env DRYKRAFT_MCP_ENV_FILE="$HOME/.config/drykraft/mcp.env" \\
  -- node "$PWD/scripts/mcp.mjs"</code></pre>
          <h3>Codex</h3>
          <pre><code>codex mcp add drykraft \\
  --env DRYKRAFT_MCP_ENV_FILE="$HOME/.config/drykraft/mcp.env" \\
  -- node "$PWD/scripts/mcp.mjs"</code></pre>
        </li>
      </ol>
    </section>
    <section class="project-release section">
      <h2>What your agent can do</h2>
      <p>Search the tool catalog for CRM and sales, finance and purchase orders, dashboards, calendars, automations, outreach, email warmup, templates, and workspace settings. Start by asking it to identify the connected workspace. Ask for details before making a change.</p>
      <p>Provider sign-in, credential management, billing checkout, account security and platform administration remain in the browser. The token expires within eight hours and is revoked when its browser session ends. To disconnect sooner, choose <strong>Revoke access</strong> in Account security.</p>
    </section>
  </div>`;
}
