# Christmas Together architecture

A browser-based order and pickup system for beans&beats at Christmas Together. It provides order entry, a barista queue, guest tracking, a public ready board, menu controls and daily reports. Payments remain on the organiser's POS. See [README](README.md) for the project brief and setup.

## Runtime and storage

For the submission, browsers connect over HTTPS to one Render service. Express serves both the built React app and the API; the server connects to Turso hosted SQLite through the libSQL HTTP client. Keeping the frontend and API on one origin avoids separate CORS configuration.

| Layer | Implementation |
| --- | --- |
| Browser | React 19, TypeScript, Vite, Tailwind CSS 4 and shadcn/ui. |
| API | Node.js 24+ and Express 5, with Zod input validation; the server owns ticket numbers, prices, permissions and state transitions. |
| Database | Turso for hosted deployment; Node's built-in SQLite with WAL for local development. Both use the same async Store and schema. |
| Offline storage | Dexie/IndexedDB holds staff snapshots and pending writes; a service worker caches the built app shell, fonts and illustrations. |

With both Turso variables omitted, local development uses `data/beans.sqlite` or `DB_PATH`. Partial Turso configuration fails startup. Render requires remote credentials, preventing an accidental fallback to its temporary filesystem.

The main implementation boundaries are [server/app.ts](server/app.ts) for HTTP/authentication, [server/store.ts](server/store.ts) for transactional business rules, [server/database.ts](server/database.ts) for database selection, and [src/lib/offline.ts](src/lib/offline.ts) for durable browser work.

## Orders and reports

The server assigns an increasing ticket number and private guest token when it accepts an order. UUID retry keys prevent duplicate tickets after a lost response. Menu availability, prices and expected revisions are checked inside the transaction that writes the order and its history.

Tickets move **Waiting → Making → Ready → Collected**, oldest first in the queue. Collected and cancelled tickets remain in Recent. Leads can correct or cancel confirmed orders with a reason; changes retain an audit history. Kept drink lines retain their accepted prices, replacements use current prices, drink changes requeue the ticket, and name-only edits keep its status. An online Undo can reverse the latest confirmed advance within ten seconds.

The database stores menu entries, orders, drink-line snapshots and change history. Reports use the server's acceptance date in Singapore and integer-cent accepted prices. On-screen totals exclude cancelled orders; CSV includes their status and original value for reconciliation. These are recorded order values, not proof of payment or POS sales.

## Offline and sync

Staff must sign in and load the built app and menu online first. Saved orders and ordinary status changes enter a durable IndexedDB outbox. Work replays sequentially after reconnection, on staff actions, during the 15-second sync cycle or through manual sync. Only acknowledged work is removed after its server response is saved locally; rejected work stays visible for review. Revision checks prevent stale changes from silently overwriting another device.

**New disconnected orders receive their number and guest QR after server confirmation.** Existing tickets can advance on the same device while disconnected, but other staff, guests and the board see those changes after sync. The service worker never caches API responses. Fresh login, lead edits, report refresh and CSV exports require a connection; already-loaded report totals remain visible. Unsaved drafts survive navigation but can be lost on reload; clearing browser storage loses pending work.

Guest pages and the ready board poll every three seconds. Guest alerts are the current page and optional sound while the page is open and the phone awake. Background push, Telegram and WhatsApp are deferred.

## Access and personal data

Barista and lead APIs use signed, HTTP-only session cookies, secure in production, with eight-hour expiry. Lead permissions protect menu, reports and corrections. Production requires strong passwords and a session secret behind an HTTPS proxy. The login rate limiter is in memory, so the current deployment uses one server process.

Orders collect a first name and drink details, without phone numbers or payment data. A random bearer link exposes only its own guest order; the public board shows ready names and numbers. Staff devices, exports, backups and history also contain personal data.

Retention is manual. Preview-first cleanup anonymizes closed older orders, rotates their tokens, blocks guest lookup and removes identifying history while retaining report data. Provider copies, devices and exports need separate retention handling. Organiser-approved notices, retention and overseas hosting remain unresolved; PDPA compliance has not been assessed.

## Agreed visual design

Use the Shared Table direction: cream/blush surfaces, bottle-green text, vermilion accents, Alte Haas Grotesk, rounded shadcn/ui controls and the female barista gouache illustrations. Keep explicit status labels, keyboard access, visible focus and accessible live announcements.

Staff use a responsive sidebar with Order, Queue, Display and Recent; Menu and Reports are lead-only. Display opens the public board separately. Queue and management views use compact full-width tables. Guest pages lead with the state headline and matching illustration, followed by one centered “Order 006” line, drinks and pickup guidance. Guest self-ordering is outside scope.

## Deployment and remaining checks

Turso connectivity, schema initialization and the six default menu entries are verified. Render configuration and the public deployment are pending. [DEPLOYMENT.md](DEPLOYMENT.md) covers hosting, backups, restore and privacy cleanup; keep the same database and increasing ticket sequence across all four event days.

The free submission setup has cold starts and still needs a public end-to-end check, recovery rehearsal, capacity testing and actual tablet/phone/Wi-Fi rehearsal. A local persistent server remains an alternative, but no local-network deployment or hosted guest mirror has been verified. See [verification.md](verification.md) for recorded checks and remaining limits.
