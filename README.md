# beans&beats at Christmas Together

A browser-based coffee order and pickup system for beans&beats at Christmas Together on **26–29 November 2026, Marina Bay Sands, Singapore**. The event expects 40,000+ visitors; booth profits support Singapore Red Cross Young Hearts.

Requirements: tablet/phone browsers, offline saving and later sync, first names with PDPA handling, and payments through the organiser's separate POS. The brief allows optional mobile contact; this build collects no phone numbers.

All six modules work locally. Turso connectivity and database initialization are verified; public Render deployment and real-device rehearsal are still pending.

| Module | Current experience |
| --- | --- |
| Order | Baristas enter drinks, milk, hot/iced, quantity and first name; server confirmation supplies a number and private guest QR. |
| Queue | Oldest first: Waiting → Making → Ready → Collected; recent tickets remain available. |
| Guest status | QR opens live status, drinks and optional page sound when ready. |
| Ready board | Public screen shows ready first names and numbers until collection. |
| Menu | Booth leads edit names/prices and sold-out availability. |
| Daily reports | Booth leads view Singapore-day cups/value and export CSV for POS comparison. |

## Setup

Install Node **24+** and npm (checked locally with Node 24.22.1 and 26.2). From the project folder:

```powershell
npm ci
npm run build
npm start
```

Open [the local app](http://127.0.0.1:3001). Development defaults are **Barista** (`barista-demo`) and **Booth lead** (`lead-demo`), unless overridden in your environment. Localhost QR links work only on this computer.

Commands load the private `.env` automatically. With both `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` set, the app uses Turso even when running locally. Omit both to use local SQLite at `data/beans.sqlite`, or set `DB_PATH` to another local file. Use synthetic orders for development and submission.

Development: stop `npm start`, then run `npm run dev` (UI 5173, API 3001). Tests: `npm test`. Offline shell caching requires the built app served by `npm start`.

## Deployment

The submission target is **Render Free + Turso Free**, within their usage limits. Render serves the React build and Express API at one HTTPS address; Turso keeps the database across server restarts and deployments. The Turso connection, schema and six default menu entries are verified. Render environment settings and the live deployment are still pending.

1. Push the repository to GitHub. The existing Turso submission database is ready; keep its orders synthetic.
2. Create a Render Blueprint from [render.yaml](render.yaml).
3. Enter private `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET` (32+ characters), and distinct `BARISTA_PASSWORD` / `LEAD_PASSWORD` values (12+ characters) in Render. The local `.env` is not uploaded. The Blueprint selects Node 24 and production mode; startup requires both Turso settings and rejects default demo credentials.
4. Deploy, then verify login, order → QR → Ready → Collected, menu, reports and offline recovery at the public URL. Restart the service to check persistence and continued numbering. Add the URL and two submission test logins at the top of this README.

See [DEPLOYMENT.md](DEPLOYMENT.md) for setup, backups, restore/import and privacy cleanup, and [ARCHITECTURE.md](ARCHITECTURE.md) for the current design. Render Free sleeps after idle periods; document its cold start for judges and agree event hosting during hardening. A persistent Node server with local SQLite remains an alternative.

## Offline operation and alerts

- Sign in online and cache the built app/menu first. Saved orders and status changes survive reloads and sync after reconnection; rejected work remains visible.
- **New disconnected orders get their number and QR after server confirmation.** Existing tickets can advance locally; other devices, guests and the board see changes after sync. This limitation is accepted.
- Unsaved drafts survive staff navigation but can be lost on reload. Do not clear browser data with pending work.
- Guest alerts use the **current page plus optional sound**. Keep the page open and phone awake. Telegram and WhatsApp are roadmap items; neither is implemented.

Devices need a working network path to the Render service for shared updates. Fresh login, lead edits, report refresh and CSV exports require connectivity. Physical booth networking and device behavior still need rehearsal.

## Resetting between event days

**Keep the same database and increasing ticket sequence for all four days. There is no destructive day reset.**

1. **Close:** connect every staff device and resolve pending/rejected work. Export Reports CSV for that Singapore date.
2. **Reconcile:** compare with the organiser's POS. Reports show recorded value, not paid sales. Exclude cancelled CSV rows when matching totals; payments/refunds stay on the POS.
3. **Back up:** run these commands on a trusted computer configured for the active database. They select Turso when its credentials are set; otherwise they use local `DB_PATH` or `data/beans.sqlite`. Protect a backup copy off the server disk.

   ```powershell
   npm run db:check
   npm run db:backup
   ```

4. **Reopen:** check the clock, new Singapore report date, device sync, prices and stock. Test an order through QR, sound and collection. Select the new date in Reports; retain previous orders.

Backups default to `backups/` and contain personal data. Restore needs writes stopped, device reconciliation and the highest issued ticket; remote restore requires `--remote` and an empty destination database. Agree retention before real use; cleanup is manual and PDPA compliance is unassessed.

## Timeline and submission

| Milestone | Date |
| --- | --- |
| Stage 1 build | 14 October–8 November 2026 |
| Submission and pitches | 8 November, submit before pitches start |
| Winner hardening | 9–13 November |
| Barista dry run | Week of 16 November |
| Live booth, team on call | 26–29 November |

Submit the repository link at [MyProjet](https://myprojet.co/home). Required artifacts:

- Live link to all six modules with barista and booth-lead test logins.
- Repository with this README covering setup, deployment and between-day operation.
- Three-minute demo: order → guest alert → ready board, including Wi-Fi loss and recovery.
- One-page technical PDF: stack/architecture, offline sync, personal data and PDPA handling, known limits.

Add the live/demo/PDF links at the top when available. Menu, POS mapping, physical rehearsal and production recovery still need sign-off.
