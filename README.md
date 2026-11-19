# DryKraft

DryKraft is a self-hostable workspace for customer relationships, sales,
finance, outreach, scheduling, and automation. Create a lead, follow the
connected deal, schedule the next conversation, and turn the opportunity into
an invoice without re-entering the customer’s details.

[Website](https://drykraft.com) · [Product tour](https://drykraft.com/#product-tour) ·
[Product docs](https://drykraft.com/docs) · [API reference](https://drykraft.com/docs/api)

## What’s included

| Area | Capabilities |
| --- | --- |
| CRM and sales | People, companies, leads, tasks, related records, CSV import, smart lists, custom objects and fields, sales pipelines, and dashboards |
| Finance | Invoices and PDFs, purchase orders, received payment records, expenses and approvals, reusable templates, and multiple currencies |
| Outreach | Email, SMS, AI voice, and WhatsApp campaigns and sequences, consent and suppression, delivery activity, reply handling, and email warmup limits |
| Calendar | Month and agenda views, availability and booking links, Google Calendar and Outlook connections |
| Automation | Versioned visual workflows, triggers and actions, retries and execution history, and a transactional outbox |
| Administration and APIs | Workspace roles, teams and locations, MFA, scoped integration keys, signed webhooks, platform administration, and reseller tools |

Email warmup ramps a mailbox’s sending allowance for reviewed outreach.
Finance records payments already received and keeps amounts in their original
currency. External delivery, calendar sync, and hosted billing need the
appropriate provider accounts and configuration.

## Run locally

Install **Node.js 22.12 or later**, npm, PostgreSQL and Redis. Start the database
and Redis first. Use a local PostgreSQL role that can create a database and
roles for initial setup.

```sh
git clone https://github.com/emasterlab/drykraft.git
cd drykraft
npm ci
npm run setup
npm run dev
```

Open [localhost:5173](http://localhost:5173). Create an account and workspace,
or choose **Explore the sample workspace** to browse fictional records when
local demo access is enabled.

Setup generates a private `.env`, initializes PostgreSQL and applies the
migrations. If the default local administrator connection does not match your
setup, export `LOCAL_DATABASE_ADMIN_URL` for the setup command. See
[.env.example](.env.example) for optional settings. Keep development and test
services separate from production, and add provider credentials only to a
private environment or secret store.

## Development

| Command or path | Purpose |
| --- | --- |
| `npm run dev` | Run the Vite client, API and workflow worker |
| `npm run build` | Type-check and build the app and static website into `dist/` |
| `npm start` | Serve the built site and API |
| `npm run worker` | Run background workflow processing |
| `npm run db:migrate` | Inspect pending migrations, then pass `-- --apply` to apply them |
| `npm test` | Run the repository tests with disposable local services |
| `src/`, `server/`, `public/` | React client, Node.js API/workers, and public assets |
| `server/schema.sql`, `server/migrations/` | PostgreSQL schema and ordered migrations |

DryKraft uses React, Vite, Node.js, Express, PostgreSQL, and Redis. The API
serves the workspace app and the generated website. PostgreSQL stores
workspace records and their events. Workers process queued work separately.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for local development, issue reports,
and pull requests. Report security issues privately to support@drykraft.com.

## License

DryKraft is **source-available for personal, noncommercial use** under the
[DryKraft Personal and Noncommercial Use License](LICENSE). For commercial
licensing, contact support@drykraft.com. Third-party dependencies and fonts
retain their own licenses.
