import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { createApp } from '../server/app.ts';
test('staff API requires a session, enforces lead access and keeps guest data scoped', async () => {
    const store = await Store.open(':memory:');
    const server = createApp(store, { secret: 'test-secret-'.repeat(4), baristaPassword: 'test-barista', leadPassword: 'test-lead', production: false }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as {
        port: number;
    };
    const base = `http://127.0.0.1:${address.port}`;
    let cookie = '';
    const request = (path: string, method = 'GET', body?: unknown, origin = base) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    try {
        assert.equal((await request('/api/snapshot')).status, 401);
        assert.equal((await request('/api/login', 'POST', { role: 'lead', password: 'wrong' })).status, 401);
        const login = await request('/api/login', 'POST', { role: 'barista', password: 'test-barista' });
        assert.equal(login.status, 200);
        cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        assert.equal((await request('/api/snapshot')).status, 200);
        assert.equal((await request('/api/menu/latte', 'PATCH', { available: false })).status, 403);
        assert.equal((await request('/api/reports/2026-11-26')).status, 403);
        assert.equal((await request('/api/orders', 'POST', { id: randomUUID(), firstName: 'Alex', lines: [] })).status, 400);
        assert.equal((await request('/api/logout', 'POST', {}, 'https://elsewhere.invalid')).status, 403);
        const created = await request('/api/orders', 'POST', { id: randomUUID(), firstName: 'Alex', lines: [{ menuId: 'latte', milk: 'Dairy', temperature: 'Hot', quantity: 1 }] });
        assert.equal(created.status, 201);
        const order = await created.json();
        cookie = '';
        assert.equal((await request('/api/snapshot')).status, 401);
        const guest = await (await request(`/api/guest/${order.guestToken}`)).json();
        assert.equal(guest.firstName, 'Alex');
        assert.equal(guest.id, undefined);
        assert.equal(guest.guestToken, undefined);
        assert.equal((await request('/api/guest/guess')).status, 404);
        assert.deepEqual(await (await request('/api/board')).json(), []);
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        store.close();
    }
});
test('recovery endpoints enforce lead access, revisions and audit reasons', async () => {
    const store = await Store.open(':memory:');
    const server = createApp(store, { secret: 'recovery-test-'.repeat(4), baristaPassword: 'test-barista', leadPassword: 'test-lead', production: false }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as {
        port: number;
    }).port}`;
    let cookie = '';
    const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const login = async (role: string) => { const response = await request('/api/login', 'POST', { role, password: `test-${role}` }); cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); };
    try {
        await login('barista');
        const order = await store.create({ id: randomUUID(), firstName: 'Alex', lines: [{ menuId: 'latte', milk: 'Dairy', temperature: 'Hot', quantity: 1 }] });
        const path = `/api/orders/${order.id}`;
        assert.equal((await request(`${path}/status`, 'POST', { expected: 'queued', next: 'making' })).status, 409);
        const making = await (await request(`${path}/status`, 'POST', { expected: 'queued', next: 'making', revision: order.revision })).json();
        assert.equal((await request(`${path}/status`, 'POST', { expected: 'queued', next: 'making', revision: order.revision })).status, 200);
        assert.equal((await request(`${path}/undo`, 'POST', { revision: making.revision })).status, 200);
        assert.equal((await request(`${path}/status`, 'POST', { expected: 'queued', next: 'making', revision: order.revision })).status, 409);
        assert.equal((await request(`${path}/cancel`, 'POST', { revision: 2, reason: 'Duplicate' })).status, 403);
        assert.equal((await request(path, 'PATCH', { revision: 2, reason: 'Name', firstName: 'Alexa', lines: order.lines })).status, 403);
        assert.equal((await request(`${path}/history`)).status, 403);
        await login('lead');
        assert.equal((await request(`${path}/cancel`, 'POST', { revision: 2, reason: ' ' })).status, 400);
        assert.equal((await request(path, 'PATCH', { revision: 2, reason: 'Name corrected', firstName: 'Alexa', lines: order.lines.map(line => ({ ...line, expectedUnitCents: line.unitCents })) })).status, 200);
        assert.equal((await request(`${path}/cancel`, 'POST', { revision: 2, reason: 'Duplicate' })).status, 409);
        assert.equal((await request(`${path}/cancel`, 'POST', { revision: 3, reason: 'Duplicate' })).status, 200);
        assert.equal((await (await request(`${path}/history`)).json())[0].reason, 'Duplicate');
        cookie = '';
        assert.equal((await request(`${path}/history`)).status, 401);
        const guest = await (await request(`/api/guest/${order.guestToken}`)).json();
        assert.equal(guest.status, 'cancelled');
        assert.equal(guest.revision, undefined);
        assert.equal(guest.history, undefined);
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        store.close();
    }
});
