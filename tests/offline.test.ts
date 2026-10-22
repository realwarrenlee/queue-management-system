import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StaffDB, flushPending, projectOrders, enqueueStatus, cacheSnapshot } from '../src/lib/offline.ts';
import { AppError } from '../shared/domain.ts';
import type { Order } from '../shared/domain.ts';
import { Store } from '../server/store.ts';
const command = () => ({ kind: 'create' as const, label: 'Alex · Latte', createdAt: new Date().toISOString(), body: { id: randomUUID(), firstName: 'Alex', lines: [{ menuId: 'latte', milk: 'Dairy' as const, temperature: 'Hot' as const, quantity: 1 }] } });
test('pending work survives reopening and retries safely after a lost response', async () => {
    const name = randomUUID();
    let db = new StaffDB(name);
    const pending = command();
    await db.pending.add(pending);
    db.close();
    db = new StaffDB(name);
    const received = new Set<string>();
    await flushPending(db, async (row) => { received.add(row.body.id); throw new TypeError('Connection lost'); });
    assert.equal(await db.pending.count(), 1);
    await flushPending(db, async (row) => { received.add(row.body.id); });
    assert.equal(received.size, 1);
    assert.equal(await db.pending.count(), 0);
    await db.delete();
});
test('a write added during flush is retained and concurrent flushes send each write once', async () => {
    const db = new StaffDB(randomUUID());
    await db.pending.add(command());
    const sent: string[] = [];
    const send = async (row: any) => {
        sent.push(row.body.id);
        if (sent.length === 1)
            await db.pending.add(command());
    };
    await Promise.all([flushPending(db, send), flushPending(db, send)]);
    assert.equal(sent.length, 2);
    assert.equal(new Set(sent).size, 2);
    assert.equal(await db.pending.count(), 0);
    await db.delete();
});
test('permanent rejection is retained for review and does not block later orders', async () => {
    const db = new StaffDB(randomUUID());
    const first = command();
    await db.pending.bulkAdd([first, command()]);
    await flushPending(db, async (row) => { if (row.body.id === first.body.id)
        throw new AppError('Latte is sold out', 409); });
    const rows = await db.pending.toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body.id, first.body.id);
    assert.match(rows[0].error!, /sold out/);
    await db.delete();
});
test('expired sessions and rate limits keep pending work available for retry', async () => {
    for (const status of [401, 429, 503]) {
        const db = new StaffDB(randomUUID());
        await db.pending.add(command());
        await flushPending(db, async () => { throw new AppError('Try later', status); });
        assert.equal(await db.pending.count(), 1);
        assert.equal((await db.pending.toArray())[0].error, undefined);
        await db.delete();
    }
});
test('confirmed orders can progress through all local statuses while offline without moving backwards', () => {
    const order = { id: randomUUID(), status: 'queued', revision: 0 } as Order;
    const changes = [
        { kind: 'status' as const, body: { id: order.id, expected: 'queued' as const, next: 'making' as const, revision: 0 }, label: '', createdAt: '' },
        { kind: 'status' as const, body: { id: order.id, expected: 'making' as const, next: 'ready' as const, revision: 1 }, label: '', createdAt: '' },
        { kind: 'status' as const, body: { id: order.id, expected: 'ready' as const, next: 'collected' as const, revision: 2 }, label: '', createdAt: '' },
    ];
    assert.equal(projectOrders([order], changes.slice(0, 1))[0].status, 'making');
    assert.equal(projectOrders([order], changes.slice(0, 2))[0].status, 'ready');
    assert.equal(projectOrders([order], changes)[0].status, 'collected');
    assert.equal(projectOrders([{ ...order, status: 'ready' }], changes.slice(0, 1))[0].status, 'ready');
    assert.equal(projectOrders([order], [{ ...changes[0], error: 'Conflict' }])[0].status, 'queued');
});
test('an acknowledged order stays available locally even if the later snapshot refresh fails', async () => {
    const db = new StaffDB(randomUUID());
    const pending = command();
    const accepted = { ...pending.body, number: 42, status: 'queued', guestToken: 'private-token', totalCents: 500, createdAt: '', updatedAt: '', eventDay: '2026-11-26' } as Order;
    await db.cache.put({ key: 'snapshot', value: { orders: [], menu: [], serverTime: '' } });
    await db.pending.add(pending);
    await flushPending(db, async () => accepted);
    assert.equal(await db.pending.count(), 0);
    assert.equal((await await db.cache.get('snapshot'))!.value.orders[0]?.number, 42);
    await db.delete();
});
test('offline transitions suppress double taps and replay every step in order', async () => {
    const db = new StaffDB(randomUUID());
    const store = await Store.open(':memory:');
    const order = await store.create(command().body);
    await db.cache.put({ key: 'snapshot', value: { orders: [order], menu: [], serverTime: '' } });
    await Promise.all([enqueueStatus(db, order), enqueueStatus(db, order)]);
    assert.equal(await db.pending.count(), 1);
    for (let step = 0; step < 2; step++)
        await enqueueStatus(db, projectOrders([order], await db.pending.toArray())[0]);
    assert.equal(await db.pending.count(), 3);
    await flushPending(db, async (row) => row.kind === 'status' ? await store.transition(row.body.id, row.body.expected, row.body.next, 'barista', row.body.revision) : await store.create(row.body));
    assert.equal((await store.get(order.id))!.status, 'collected');
    assert.equal((await await db.cache.get('snapshot'))!.value.orders[0].status, 'collected');
    assert.equal(await db.pending.count(), 0);
    store.close();
    await db.delete();
});
test('collected and cancelled orders never enqueue another forward status', async () => {
    const db = new StaffDB(randomUUID());
    const orders = ['collected', 'cancelled'].map(status => ({ id: randomUUID(), status } as Order));
    await db.cache.put({ key: 'snapshot', value: { orders, menu: [], serverTime: '' } });
    for (const order of orders)
        await enqueueStatus(db, order);
    assert.equal(await db.pending.count(), 0);
    await db.delete();
});
test('a delayed snapshot cannot overwrite a newer correction or undo acknowledgement', async () => {
    const db = new StaffDB(randomUUID());
    const store = await Store.open(':memory:');
    const order = await store.create(command().body);
    const snapshot = { orders: [order], menu: [], serverTime: '' };
    await cacheSnapshot(db, snapshot);
    const making = await store.transition(order.id, 'queued', 'making');
    await cacheSnapshot(db, { ...snapshot, orders: [making] });
    await cacheSnapshot(db, snapshot);
    assert.equal((await await db.cache.get('snapshot'))!.value.orders[0].status, 'making');
    const restored = await store.undo(order.id, making.revision, 'barista');
    await cacheSnapshot(db, { ...snapshot, orders: [restored] });
    await cacheSnapshot(db, { ...snapshot, orders: [making] });
    assert.equal((await await db.cache.get('snapshot'))!.value.orders[0].status, 'queued');
    store.close();
    await db.delete();
});
test('a delayed outbox acknowledgement cannot replace a newer accepted correction', async () => {
    const db = new StaffDB(randomUUID());
    const store = await Store.open(':memory:');
    const order = await store.create(command().body);
    const snapshot = { orders: [order], menu: [], serverTime: '' };
    await cacheSnapshot(db, snapshot);
    await enqueueStatus(db, order);
    await flushPending(db, async () => {
        const making = await store.transition(order.id, 'queued', 'making');
        const corrected = await store.correct(order.id, { firstName: 'Alexa', revision: making.revision, reason: 'Correct name', lines: making.lines.map(line => ({ ...line, expectedUnitCents: line.unitCents })) });
        await cacheSnapshot(db, { ...snapshot, orders: [corrected] });
        return making;
    });
    assert.equal((await await db.cache.get('snapshot'))!.value.orders[0].firstName, 'Alexa');
    assert.equal(await db.pending.count(), 0);
    store.close();
    await db.delete();
});
test('old offline status sequences are retained for review instead of advancing replacement drinks', async () => {
    const db = new StaffDB(randomUUID());
    const store = await Store.open(':memory:');
    const order = await store.create(command().body);
    await cacheSnapshot(db, { orders: [order], menu: [], serverTime: '' });
    for (let step = 0; step < 3; step++)
        await enqueueStatus(db, projectOrders([order], await db.pending.toArray())[0]);
    await store.correct(order.id, { revision: order.revision, reason: 'Replace drink', firstName: 'Alex', lines: [{ menuId: 'mocha', milk: 'Oat', temperature: 'Iced', quantity: 1, expectedUnitCents: 700 }] });
    await flushPending(db, async (row) => row.kind === 'status' ? await store.transition(row.body.id, row.body.expected, row.body.next, 'barista', row.body.revision) : await store.create(row.body));
    assert.equal((await store.get(order.id))!.status, 'queued');
    assert.equal((await store.get(order.id))!.lines[0].name, 'Mocha');
    assert.equal(await db.pending.count(), 3);
    assert.ok((await db.pending.toArray()).every(row => row.error));
    store.close();
    await db.delete();
});
