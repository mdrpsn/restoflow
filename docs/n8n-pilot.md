# Main branch n8n inventory pilot

Restoflow owns sales, recipes, stock balances, and the append-only movement ledger. n8n
only polls the transactional outbox, creates idempotent replenishment proposals through
Restoflow's API, and sends Telegram messages. A Telegram or n8n outage cannot block POS
checkout or mutate stock independently.

## Business-data prerequisites

1. Select the 20 highest-value/highest-volume pilot products. Enter their recipes in
   **Catalog → Products** and verify every ingredient unit and cost.
2. At Main, perform a physical opening count for every ingredient used by those recipes.
3. In **Inventory**, set a low-stock threshold and optional par level. A par level enables
   an automated draft line; a blank par level means alert only.
4. Run known-quantity test sales and a void. Confirm the movement ledger exactly matches
   recipe quantities before accepting live transactions.

Products without recipes remain sellable. Each such sale creates a missing-recipe event,
and the daily report shows mapped revenue and quantity coverage so partial pilot data is
never presented as complete inventory accuracy.

## Integration API

All routes under `/api/integrations/n8n` require
`Authorization: Bearer $N8N_INTEGRATION_TOKEN`. The server scopes every query to
`N8N_ORGANIZATION_ID`; callers cannot choose an organization. Mutating routes also
require `Idempotency-Key`.

- `GET /events?limit=50`
- `POST /events/{id}/ack`
- `POST /replenishment-drafts/reconcile` with `{ "branchCode": "MAIN" }`
- `GET /daily-summary?branch=MAIN&date=YYYY-MM-DD`
- `GET /health`

Quantities are decimal strings and money is integer centavos. Reconciliation creates or
refreshes one automation `DRAFT` per branch. A manager follows the Telegram link, edits
quantities if needed, and submits it. Only then does it enter the existing warehouse
approval → transfer → ship → receive lifecycle.

## Local verification and workflow import

After `npx prisma migrate deploy`, set `N8N_INTEGRATION_TOKEN` and get the seeded
organization ID with:

```powershell
docker exec restoflow-db-1 psql -U restoflow -d restoflow -tAc 'SELECT id FROM "Organization" WHERE name = ''We Got Cha! Demo'' LIMIT 1;'
```

Set that value as `N8N_ORGANIZATION_ID` for Restoflow. Configure the environment variables
listed in `deploy/.env.example` for n8n, import all files under `n8n/workflows`, and test
each workflow manually. Imports are intentionally inactive so real Telegram messages are
not sent during installation. Configure **Restoflow - Automation Monitor** as the error
workflow for the other three, then activate the monitor, event alerts, replenishment, and
daily digest in that order.

## VPS deployment

Copy `deploy/.env.example` to `deploy/.env`, replace every placeholder, point the domain's
DNS at the VPS, then run:

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.vps.yml up -d --build
docker compose --env-file deploy/.env -f deploy/docker-compose.vps.yml exec n8n \
  n8n import:workflow --separate --input=/files/workflows
```

Only Caddy exposes ports 80/443. PostgreSQL has no host port. n8n binds to VPS loopback;
open its editor through an SSH tunnel (`ssh -L 5678:127.0.0.1:5678 user@vps`) rather than
publishing it on the internet.

Run `npm run db:backup` nightly on the VPS with `DB_CONTAINER=restoflow-db`, retain at
least 14 daily copies, and copy backups to encrypted off-site storage. Perform a test
restore before the live pilot; a backup that has never been restored is not accepted.

## Pilot acceptance

Run Main for 14 days. Do not retire Messenger reporting until Restoflow has captured every
transaction, mapped recipes cover at least 95% of sales value, deductions match scripted
sales, no duplicate drafts/events occur, and three consecutive daily reports match manual
reconciliation. Waste remains in the daily digest during calibration; set immediate waste
thresholds only after the pilot provides a defensible baseline.
