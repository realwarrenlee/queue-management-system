import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.ts';
const input = () => ({ id: randomUUID(), firstName: 'Alex', lines: [{ menuId: 'latte', milk: 'Oat', temperature: 'Iced', quantity: 2 }] });
test('create retries return one numbered order and preserve the accepted price', async () => {
    const store = await Store.open(':memory:');
    const draft = input();
    const order = await store.create(draft);
    assert.equal(order.number, 1);
    assert.equal(order.totalCents, 2000);
    await store.saveMenu('latte', { name: 'Latte', priceCents: 700, available: true });
    assert.deepEqual(await store.create(draft), order);
    assert.equal((await store.orders()).length, 1);
    assert.equal((await store.create(input())).totalCents, 1800);
    store.close();
});
test('reject invalid names, quantities, menu items and sold-out drinks', async () => {
    const store = await Store.open(':memory:');
    for (const draft of [
        { ...input(), firstName: ' ' },
        { ...input(), lines: [{ menuId: 'latte', milk: 'Oat', temperature: 'Iced', quantity: -1 }] },
        { ...input(), lines: [{ menuId: 'missing', milk: 'Oat', temperature: 'Iced', quantity: 1 }] },
        { ...input(), lines: [{ menuId: 'latte', milk: 'Invalid', temperature: 'Iced', quantity: 1 }] },
    ])
        await assert.rejects(async () => await store.create(draft));
    await store.saveMenu('latte', { name: 'Latte', priceCents: 500, available: false });
    await assert.rejects(async () => await store.create(input()), /sold out/i);
    assert.equal((await store.orders()).length, 0);
    store.close();
});
test('status changes are forward-only, concurrent retries are safe and the board is private', async () => {
    const store = await Store.open(':memory:');
    const order = await store.create(input());
    await assert.rejects(async () => await store.transition(order.id, 'queued', 'ready'), /transition/i);
    await store.transition(order.id, 'queued', 'making');
    await store.transition(order.id, 'queued', 'making');
    await store.transition(order.id, 'making', 'ready');
    await assert.rejects(async () => await store.transition(order.id, 'queued', 'making'), /changed/i);
    assert.equal(JSON.stringify(await store.board()), JSON.stringify([{ number: 1, firstName: 'Alex' }]));
    const guest = (await store.guest(order.guestToken))!;
    assert.equal(guest.status, 'ready');
    assert.ok(!('id' in guest));
    assert.ok(!('guestToken' in guest));
    assert.equal(await store.guest(randomUUID()), undefined);
    await store.transition(order.id, 'ready', 'collected');
    assert.deepEqual(await store.board(), []);
    store.close();
});
test('SQLite survives restart and keeps numbering increasing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'beans-test-'));
    try {
        const path = join(directory, 'orders.sqlite');
        let store = await Store.open(path);
        const order = await store.create(input());
        store.close();
        store = await Store.open(path);
        assert.equal((await store.guest(order.guestToken))?.firstName, 'Alex');
        assert.equal((await store.create(input())).number, 2);
        store.close();
    }
    finally {
        rmSync(directory, { recursive: true });
    }
});
test('reports use Singapore dates, accepted prices and CSV-safe first names', async () => {
    let now = new Date('2026-11-26T15:59:59Z');
    const store = await Store.open(':memory:', () => now);
    await store.create({ ...input(), firstName: '=Alex' });
    now = new Date('2026-11-26T16:00:00Z');
    await store.create(input());
    const report = await store.report('2026-11-26');
    assert.equal(report.cups, 2);
    assert.equal(report.totalCents, 2000);
    assert.equal((await store.report('2026-11-27')).cups, 2);
    assert.match(await store.csv('2026-11-26'), /'\=Alex/);
    await assert.rejects(async () => await store.report('2026-02-31'), /date/i);
    store.close();
});
test('independent menu edits preserve sold-out status and current prices', async () => {
    const store = await Store.open(':memory:');
    await store.saveMenu('latte', { available: false });
    await store.saveMenu('latte', { name: 'House latte', priceCents: 700 });
    assert.equal((await store.menu()).find(item => item.id === 'latte')!.available, false);
    await store.saveMenu('latte', { available: true });
    assert.equal((await store.menu()).find(item => item.id === 'latte')!.priceCents, 700);
    await assert.rejects(async () => await store.create({ ...input(), lines: [{ menuId: 'latte', milk: 'Dairy', temperature: 'Hot', quantity: 1, expectedUnitCents: 500 }] }), /price changed/);
    assert.equal((await store.orders()).length, 0);
    store.close();
});
test('undo restores only the latest status change within ten seconds', async () => {
    let now = new Date('2026-10-20T02:00:00Z');
    const store = await Store.open(':memory:', () => now);
    const order = await store.create(input());
    const making = await store.transition(order.id, 'queued', 'making');
    assert.equal(making.revision, 1);
    assert.equal(making.undoUntil, '2026-10-20T02:00:10.000Z');
    now = new Date('2026-10-20T02:00:09.999Z');
    const restored = await store.undo(order.id, making.revision, 'barista');
    assert.equal(restored.status, 'queued');
    assert.equal(restored.revision, 2);
    await assert.rejects(async () => await store.undo(order.id, making.revision, 'barista'), /changed/i);
    await assert.rejects(async () => await store.undo(order.id, restored.revision, 'barista'), /undo/i);
    const again = await store.transition(order.id, 'queued', 'making');
    now = new Date(Date.parse(again.updatedAt) + 10000);
    await assert.rejects(async () => await store.undo(order.id, again.revision, 'barista'), /expired/i);
    assert.equal((await store.history(order.id)).length, 3);
    store.close();
});
test('corrections preserve unchanged accepted prices, validate added drinks and reject stale edits', async () => {
    const store = await Store.open(':memory:');
    const order = await store.create(input());
    await store.saveMenu('latte', { priceCents: 900, available: false });
    const correction = { revision: order.revision, reason: 'Guest corrected their name', firstName: 'Alexa', lines: order.lines.map(line => ({ ...line, expectedUnitCents: line.unitCents })) };
    const corrected = await store.correct(order.id, correction);
    assert.equal(corrected.firstName, 'Alexa');
    assert.equal(corrected.totalCents, 2000);
    assert.equal(corrected.number, order.number);
    assert.equal(corrected.guestToken, order.guestToken);
    await assert.rejects(async () => await store.correct(order.id, correction), /changed/i);
    await assert.rejects(async () => await store.correct(order.id, { ...correction, revision: corrected.revision, reason: ' ' }));
    await assert.rejects(async () => await store.correct(order.id, { ...correction, revision: corrected.revision, lines: [{ menuId: 'flat-white', milk: 'Dairy', temperature: 'Hot', quantity: 1, expectedUnitCents: 1 }] }), /price changed/i);
    assert.equal((await store.get(order.id))!.firstName, 'Alexa');
    assert.equal((await store.get(order.id))!.totalCents, 2000);
    const replaced = await store.correct(order.id, { ...correction, revision: corrected.revision, reason: 'Guest asked for flat white instead', lines: [{ menuId: 'flat-white', milk: 'Dairy', temperature: 'Hot', quantity: 1, expectedUnitCents: 800 }] });
    assert.equal(replaced.totalCents, 800);
    assert.equal((await store.history(order.id))[0].previous.totalCents, 2000);
    assert.equal((await store.history(order.id))[0].role, 'lead');
    store.close();
});
test('cancellation retains the ticket and audit trail, excludes value from reports and keeps cancelled rows in CSV', async () => {
    const store = await Store.open(':memory:', () => new Date('2026-10-20T02:00:00Z'));
    const order = await store.create(input());
    await store.transition(order.id, 'queued', 'making');
    const ready = await store.transition(order.id, 'making', 'ready');
    await assert.rejects(async () => await store.cancel(order.id, { revision: order.revision, reason: 'Duplicate' }), /changed/i);
    const cancelled = await store.cancel(order.id, { revision: ready.revision, reason: 'Duplicate order' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.totalCents, 2000);
    assert.equal((await store.guest(order.guestToken))!.status, 'cancelled');
    assert.deepEqual(await store.board(), []);
    assert.equal((await store.report('2026-10-20')).totalCents, 0);
    assert.equal((await store.report('2026-10-20')).orders, 0);
    assert.match(await store.csv('2026-10-20'), /cancelled/);
    assert.equal((await store.history(order.id))[0].reason, 'Duplicate order');
    await assert.rejects(async () => await store.transition(order.id, 'cancelled', 'collected'), /transition/i);
    await assert.rejects(async () => await store.correct(order.id, { revision: cancelled.revision, reason: 'Edit', ...input() }), /cancelled/i);
    store.close();
});
test('guest waiting guidance counts only earlier unfinished orders without exposing other guests', async () => {
    const store = await Store.open(':memory:');
    const first = await store.create(input());
    const second = await store.create(input());
    const third = await store.create(input());
    await store.transition(first.id, 'queued', 'making');
    assert.equal((await store.guest(third.guestToken))!.ordersAhead, 2);
    await store.cancel(second.id, { revision: second.revision, reason: 'Duplicate order' });
    assert.equal((await store.guest(third.guestToken))!.ordersAhead, 1);
    await store.transition(first.id, 'making', 'ready');
    assert.equal((await store.guest(third.guestToken))!.ordersAhead, 0);
    assert.ok(!JSON.stringify(await store.guest(third.guestToken)).includes(first.guestToken));
    store.close();
});
test('upgrading a pre-recovery database preserves existing tickets and accepted prices', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'beans-upgrade-'));
    try {
        const path = join(directory, 'orders.sqlite');
        const legacy = new DatabaseSync(path);
        legacy.exec(`CREATE TABLE orders (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, first_name TEXT NOT NULL, guest_token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, event_day TEXT NOT NULL);
      CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id), menu_id TEXT NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL, milk TEXT NOT NULL, temperature TEXT NOT NULL);
      INSERT INTO orders VALUES (7,'legacy-id','Alex','legacy-token','ready','2026-10-20T02:00:00Z','2026-10-20T02:00:00Z','2026-10-20');
      INSERT INTO order_items VALUES (1,'legacy-id','latte','Original latte',450,1,'Dairy','Hot');`);
        legacy.close();
        const store = await Store.open(path);
        assert.equal((await store.get('legacy-id'))!.number, 7);
        assert.equal((await store.get('legacy-id'))!.revision, 0);
        assert.equal((await store.get('legacy-id'))!.totalCents, 450);
        assert.equal((await store.guest('legacy-token'))!.status, 'ready');
        assert.equal((await store.create(input())).number, 8);
        const collected = await store.transition('legacy-id', 'ready', 'collected');
        assert.equal((await store.undo('legacy-id', collected.revision, 'barista')).status, 'ready');
        store.close();
    }
    finally {
        rmSync(directory, { recursive: true });
    }
});
test('correcting drinks returns a ready ticket to waiting while name-only corrections keep its status', async () => {
    const store = await Store.open(':memory:');
    const order = await store.create(input());
    await store.transition(order.id, 'queued', 'making');
    const ready = await store.transition(order.id, 'making', 'ready');
    const renamed = await store.correct(order.id, { revision: ready.revision, reason: 'Name corrected', firstName: 'Alexa', lines: ready.lines.map(line => ({ ...line, expectedUnitCents: line.unitCents })) });
    assert.equal(renamed.status, 'ready');
    const replaced = await store.correct(order.id, { revision: renamed.revision, reason: 'Replace the wrong drink', firstName: 'Alexa', lines: [{ menuId: 'flat-white', milk: 'Dairy', temperature: 'Hot', quantity: 1, expectedUnitCents: 800 }] });
    assert.equal(replaced.status, 'queued');
    assert.deepEqual(await store.board(), []);
    assert.equal((await store.guest(order.guestToken))!.status, 'queued');
    store.close();
});
test('status revisions reject stale advances after correction and Undo but accept a matching lost response retry', async () => {
    const store = await Store.open(':memory:');
    const order = await store.create(input());
    const making = await store.transition(order.id, 'queued', 'making', 'barista', order.revision);
    assert.equal((await store.transition(order.id, 'queued', 'making', 'barista', order.revision)).revision, making.revision);
    const restored = await store.undo(order.id, making.revision, 'barista');
    await assert.rejects(async () => await store.transition(order.id, 'queued', 'making', 'barista', order.revision), /changed/i);
    const corrected = await store.correct(order.id, { revision: restored.revision, reason: 'Replace drink', firstName: 'Alex', lines: [{ menuId: 'flat-white', milk: 'Dairy', temperature: 'Hot', quantity: 1, expectedUnitCents: 800 }] });
    await store.transition(order.id, 'queued', 'making', 'barista', corrected.revision);
    await assert.rejects(async () => await store.transition(order.id, 'queued', 'making', 'barista', order.revision), /changed/i);
    await assert.rejects(async () => await store.transition(order.id, 'making', 'ready', 'barista', making.revision), /changed/i);
    store.close();
});
