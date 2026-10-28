import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { Store } from '../server/store.ts';
import * as maintenance from '../server/maintenance.ts';
function fixture(t: {
    after: (fn: () => void) => void;
}) {
    const directory = mkdtempSync(join(tmpdir(), 'beans-maintenance-'));
    const stores: Store[] = [];
    t.after(() => {
        for (const store of stores) {
            try {
                store.close();
            }
            catch { /* Already closed for a restore check. */ }
        }
        assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
        rmSync(directory, { recursive: true });
    });
    return { directory, async open(name = 'counter.sqlite', clock?: () => Date) { const store = await Store.open(join(directory, name), clock); stores.push(store); return store; } };
}
const draft = () => ({ id: randomUUID(), firstName: 'Alex', lines: [{ menuId: 'latte', milk: 'Oat', temperature: 'Iced', quantity: 2 }] });
test('maintenance snapshot captures live WAL, history, menu, accepted prices and private tracking', async (t) => {
    const f = fixture(t);
    const store = await f.open();
    const order = await store.create(draft());
    await store.transition(order.id, 'queued', 'making');
    await store.saveMenu('latte', { priceCents: 700, available: false });
    const backup = join(f.directory, 'backup.sqlite');
    const summary = await maintenance.backupDatabase(join(f.directory, 'counter.sqlite'), backup);
    assert.equal(summary.orders, 1);
    assert.equal(summary.nextTicket, 2);
    const restored = await Store.open(backup);
    try {
        assert.equal((await restored.get(order.id))?.totalCents, 2000);
        assert.equal((await restored.get(order.id))?.status, 'making');
        assert.equal((await restored.guest(order.guestToken))?.firstName, 'Alex');
        assert.equal((await restored.history(order.id)).length, 1);
        assert.equal((await restored.menu()).find(item => item.id === 'latte')?.available, false);
        assert.equal((await restored.menu()).find(item => item.id === 'latte')?.priceCents, 700);
    }
    finally {
        restored.close();
    }
    assert.equal((await store.get(order.id))?.firstName, 'Alex');
});
test('restore reserves issued ticket numbers beyond an older backup without changing that backup', async (t) => {
    const f = fixture(t);
    const source = await f.open();
    await source.create(draft());
    const backup = join(f.directory, 'backup.sqlite');
    await maintenance.backupDatabase(join(f.directory, 'counter.sqlite'), backup);
    const original = readFileSync(backup);
    const target = join(f.directory, 'recovered.sqlite');
    const summary = await maintenance.restoreDatabase(backup, target, 100);
    assert.equal(summary.nextTicket, 101);
    assert.deepEqual(readFileSync(backup), original);
    const recovered = await Store.open(target);
    try {
        assert.equal((await recovered.create(draft())).number, 101);
    }
    finally {
        recovered.close();
    }
    await assert.rejects(maintenance.restoreDatabase(backup, join(f.directory, 'bad.sqlite'), 0), /highest|issued|ticket/i);
    await assert.rejects(maintenance.restoreDatabase(backup, join(f.directory, 'bad.sqlite'), NaN), /issued|integer/i);
    assert.equal(existsSync(join(f.directory, 'bad.sqlite')), false);
});
test('maintenance refuses to overwrite existing destinations and stale SQLite sidecars', async (t) => {
    const f = fixture(t);
    await (await f.open()).create(draft());
    const source = join(f.directory, 'counter.sqlite');
    const target = join(f.directory, 'existing.sqlite');
    writeFileSync(target, 'keep this file');
    await assert.rejects(maintenance.backupDatabase(source, target), /exist|overwrite/i);
    assert.equal(readFileSync(target, 'utf8'), 'keep this file');
    await assert.rejects(maintenance.backupDatabase(source, source), /exist|overwrite|same/i);
    for (const suffix of ['-wal', '-shm', '-journal']) {
        const candidate = join(f.directory, `sidecar${suffix}.sqlite`);
        writeFileSync(candidate + suffix, 'keep sidecar');
        await assert.rejects(maintenance.backupDatabase(source, candidate), /sidecar|exist/i);
        assert.equal(existsSync(candidate), false);
        assert.equal(readFileSync(candidate + suffix, 'utf8'), 'keep sidecar');
    }
});
test('maintenance rejects missing, corrupt, unrelated and foreign-key-broken inputs', async (t) => {
    const f = fixture(t);
    const destination = join(f.directory, 'rejected.sqlite');
    const missing = join(f.directory, 'missing.sqlite');
    await assert.rejects(maintenance.backupDatabase(missing, destination));
    assert.equal(existsSync(missing), false);
    const corrupt = join(f.directory, 'corrupt.sqlite');
    writeFileSync(corrupt, 'not a database');
    await assert.rejects(maintenance.backupDatabase(corrupt, destination));
    const unrelated = join(f.directory, 'unrelated.sqlite');
    const db = new DatabaseSync(unrelated);
    db.exec('CREATE TABLE something_else (id INTEGER)');
    db.close();
    await assert.rejects(maintenance.backupDatabase(unrelated, destination), /schema|table|orders/i);
    const store = await f.open();
    await store.db.executeMultiple("PRAGMA foreign_keys=OFF; INSERT INTO order_items (order_id,menu_id,name,price,qty,milk,temperature) VALUES ('missing','latte','Latte',500,1,'Dairy','Hot')");
    await assert.rejects(maintenance.backupDatabase(join(f.directory, 'counter.sqlite'), destination), /foreign.key/i);
    assert.equal(existsSync(destination), false);
});
async function retentionFixture(t: {
    after: (fn: () => void) => void;
}) {
    const f = fixture(t);
    let now = new Date('2026-11-26T15:59:59Z');
    const store = await f.open('counter.sqlite', () => now);
    const completed = await store.create({ ...draft(), firstName: 'EraseThisGuest' });
    await store.correct(completed.id, { firstName: 'EraseThisGuestCorrected', lines: completed.lines.map(line => ({ ...line, expectedUnitCents: line.unitCents })), revision: 0, reason: 'EraseThisGuest spelling corrected' });
    await store.transition(completed.id, 'queued', 'making');
    await store.transition(completed.id, 'making', 'ready');
    await store.transition(completed.id, 'ready', 'collected');
    const cancelled = await store.create({ ...draft(), firstName: 'EraseCancelledGuest' });
    await store.cancel(cancelled.id, { revision: 0, reason: 'EraseCancelledGuest changed plans' });
    const active = await store.create({ ...draft(), firstName: 'KeepActiveGuest' });
    const recentlyClosed = await store.create({ ...draft(), firstName: 'KeepRecentlyClosedGuest' });
    now = new Date('2026-11-26T16:00:00Z');
    const boundary = await store.create({ ...draft(), firstName: 'KeepBoundaryGuest' });
    await store.cancel(boundary.id, { revision: 0, reason: 'At cutoff' });
    await store.cancel(recentlyClosed.id, { revision: 0, reason: 'Closed after cutoff' });
    return { ...f, store, completed, cancelled, active, recentlyClosed, boundary };
}
test('privacy preview is read-only and uses the Singapore cutoff for closed tickets', async (t) => {
    const f = await retentionFixture(t);
    const path = join(f.directory, 'counter.sqlite');
    const bytes = readFileSync(path);
    const before = await f.store.orders();
    const preview = maintenance.anonymizeOrders(path, '2026-11-27');
    assert.deepEqual(preview, { applied: false, matchingOrders: 2, ticketNumbers: [1, 2] });
    assert.deepEqual(await f.store.orders(), before);
    assert.deepEqual(readFileSync(path), bytes);
    assert.ok(!JSON.stringify(preview).includes('EraseThisGuest'));
    await assert.rejects(async () => maintenance.anonymizeOrders(path, '2026-02-31'), /date|cutoff/i);
});
test('privacy apply revokes old links and scrubs names/history while preserving totals and active tickets', async (t) => {
    const f = await retentionFixture(t);
    const path = join(f.directory, 'counter.sqlite');
    const reports = await Promise.all(['2026-11-26', '2026-11-27'].map(async (day) => await f.store.report(day)));
    f.store.close();
    assert.deepEqual(maintenance.anonymizeOrders(path, '2026-11-27', true), { applied: true, matchingOrders: 2, ticketNumbers: [1, 2] });
    const reopened = await Store.open(path);
    try {
        for (const order of [f.completed, f.cancelled]) {
            assert.equal((await reopened.get(order.id))?.firstName, 'Guest');
            assert.equal(await reopened.guest(order.guestToken), undefined);
            assert.equal(await reopened.guest((await reopened.get(order.id))!.guestToken), undefined);
            assert.deepEqual(await reopened.history(order.id), []);
            assert.equal((await reopened.get(order.id))?.totalCents, order.totalCents);
        }
        for (const order of [f.active, f.boundary, f.recentlyClosed])
            assert.equal((await reopened.get(order.id))?.firstName, order.firstName);
        assert.deepEqual(await Promise.all(['2026-11-26', '2026-11-27'].map(async (day) => await reopened.report(day))), reports);
        assert.deepEqual(maintenance.anonymizeOrders(path, '2026-11-27'), { applied: false, matchingOrders: 0, ticketNumbers: [] });
    }
    finally {
        reopened.close();
    }
    assert.ok(!readFileSync(path).includes(Buffer.from('EraseThisGuest')));
    assert.ok(!readFileSync(path).includes(Buffer.from('EraseCancelledGuest')));
});
test('maintenance CLI backs up and restores explicitly and refuses unsafe or misspelled arguments', async (t) => {
    const f = fixture(t);
    await (await f.open()).create(draft());
    const source = join(f.directory, 'counter.sqlite');
    const backup = join(f.directory, 'backup.sqlite');
    const target = join(f.directory, 'restored.sqlite');
    const command = (...args: string[]) => spawnSync(process.execPath, ['scripts/database.ts', ...args], { cwd: process.cwd(), encoding: 'utf8' });
    const saved = command('backup', '--source', source, '--to', backup);
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(JSON.parse(saved.stdout).orders, 1);
    const missing = command('restore', '--from', backup, '--to', target);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /last-issued|highest/i);
    assert.equal(existsSync(target), false);
    const restored = command('restore', '--from', backup, '--to', target, '--last-issued', '90');
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).nextTicket, 91);
    const checked = command('check', '--source', target);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).nextTicket, 91);
    assert.equal(command('check', '--source', source, '--apply').status, 1);
    assert.equal(command('restore', '--from', backup, '--to', target, '--last-issued', '1e3').status, 1);
    assert.equal(command('backup', '--soruce', source, '--to', target).status, 1);
    assert.equal(command('privacy', '--source', source).status, 1);
});
test('an explicit empty CLI path cannot fall back to the configured counter database', async (t) => {
    const f = await retentionFixture(t);
    const source = join(f.directory, 'counter.sqlite');
    f.store.close();
    const command = (...args: string[]) => spawnSync(process.execPath, ['scripts/database.ts', ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DB_PATH: source } });
    const result = command('privacy', '--source', '', '--before', '2026-11-27', '--apply');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /empty|blank/i);
    assert.equal(command('privacy', '--source', '   ', '--before', '2026-11-27', '--apply').status, 1);
    assert.equal(command('backup', '--source', source, '--to', '').status, 1);
    const unchanged = await Store.open(source);
    try {
        assert.equal((await unchanged.get(f.completed.id))?.firstName, 'EraseThisGuestCorrected');
    }
    finally {
        unchanged.close();
    }
});
