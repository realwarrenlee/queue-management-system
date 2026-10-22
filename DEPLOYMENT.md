# Render + Turso deployment

Turso is connected through the ignored local `.env`; the app tables and six default menu entries are initialized and verified. **Next: push the repository and create the Render service.** Render does not receive your local `.env`, so enter the credentials in its environment settings.

Render serves the frontend and API at one HTTPS address. Turso keeps the database across server restarts and deployments. No separate frontend API URL or CORS configuration is needed.

## Database configuration

The existing submission database is ready. For another environment, create a separate database in [Turso](https://app.turso.tech/), obtain its URL and database token, and keep them in private environment settings:

```dotenv
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-private-database-token
```

Keep tokens out of Git, README and browser variables. Startup creates tables and six default menu entries in an empty database, beginning ticket numbering at 1, and preserves existing records on later starts. Local data is never uploaded automatically. Use synthetic orders for the submission.

Omit both Turso variables for local development with `data/beans.sqlite` or `DB_PATH`. Partial configuration fails startup; Render requires both variables.

## Create the Render service

1. Push the project, including `package-lock.json` and [render.yaml](render.yaml), to GitHub.
2. In [Render](https://dashboard.render.com/), create a Blueprint, connect the repository and review the Free web service.
3. Supply the private environment variables below.
4. Deploy. The Blueprint selects Node 24 and `NODE_ENV=production`, builds with `npm ci --include=dev && npm run build`, starts with `npm start`, and checks `/api/health`. Render supplies the port and HTTPS proxy.
5. At the public URL, test both logins and all six modules, direct page links, a phone QR scan, guest sound and offline reconnection. Restart the service and confirm the ticket still exists and numbering continues.
6. Add the live URL and submission test logins at the top of [README](README.md), alongside the demo video and technical PDF links when ready.

| Variable | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | Existing database URL from Turso |
| `TURSO_AUTH_TOKEN` | Private database token |
| `SESSION_SECRET` | Stable random secret, at least 32 characters |
| `BARISTA_PASSWORD` | Submission barista password, at least 12 characters |
| `LEAD_PASSWORD` | Different lead password, at least 12 characters |

Generate the session secret privately:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep one server process/instance because login rate limiting is in memory. Render Free sleeps after 15 idle minutes and takes about a minute to wake. Its filesystem is temporary: keep orders in Turso and backups on a trusted computer. Event availability and capacity still need rehearsal and agreement.

## Check and back up

On a trusted computer with the Turso variables in private `.env`:

```powershell
npm run db:check -- --remote
npm run db:backup -- --remote --to backups/submission.sqlite
```

Check, backup and privacy commands select Turso automatically when configured; `--remote` makes the choice explicit. Backup reads a consistent snapshot of all application tables and ticket sequences into a validated standalone SQLite file. It refuses an existing destination or sidecar. Backups contain names, guest tokens and history: protect them and keep a separate copy.

Use `--source` to select a local file even when Turso is configured:

```powershell
npm run db:check -- --source data/beans.sqlite
npm run db:backup -- --source data/beans.sqlite --to backups/local.sqlite
```

## Import or restore

Stop the app and pause staff writes. Reconcile every device's pending work and record the highest ticket ever issued. Create a **new empty Turso database** and set the trusted computer's credentials to that destination. Do not start the app against it before restoring, because startup seeds the menu.

```powershell
npm run db:restore -- --remote --from backups/submission.sqlite --last-issued 147
npm run db:check -- --remote
```

Restore is atomic, preserves IDs and guest tokens, and makes the next ticket at least 148 in this example. It refuses populated or unrelated destinations and never modifies the snapshot. To import local data, make a local backup first and use it as `--from`; open an older schema with the updated local app before taking that backup. Local restore uses `--to <new-local-file>` instead of `--remote`.

After checking the restored database, point Render at it and restart. Verify guest links and device reconciliation before staff resume. Keep the original database for rollback until recovery is accepted. For a fresh demo, use a new database. **Across event days, retain the same database and ticket sequence**; follow the closing/reopening steps in [README](README.md#resetting-between-event-days).

## Privacy cleanup

With an organiser-approved cutoff, preview closed older orders:

```powershell
npm run privacy:cleanup -- --remote --before 2026-11-27
```

Pause writes, reconcile devices and add `--apply` to perform cleanup. The cutoff is midnight in Singapore. Only collected/cancelled orders last updated before it are affected: names become Guest, tokens rotate, guest lookup is disabled and identifying history is removed. Drink lines and report totals remain.

Remote cleanup is logical anonymization; Turso manages compaction, replicas and provider backups. Agree retention and overseas hosting with the organiser, and separately clean staff devices, CSVs and snapshots. Local cleanup retains its secure-delete/compaction behavior.

## Verification status

Local automated checks cover the async Store, API permissions, offline replay, transaction conflicts, rollback, schema upgrades and remote-compatible maintenance using disposable SQLite databases. The real Turso connection, schema and default menu are verified. Public Render deployment, hosted order/recovery tests and device/capacity rehearsal remain pending. See [verification.md](verification.md) for evidence.

Platform references: [Render Free limits](https://render.com/docs/free), [Blueprint configuration](https://render.com/docs/blueprint-spec), [Turso pricing](https://turso.tech/pricing), [libSQL client](https://github.com/tursodatabase/libsql-client-ts).
