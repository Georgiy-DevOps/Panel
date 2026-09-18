import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { moscowDate } from '../public/service-catalog.js';

test('Vehicle deletion requires admin and VIN, preserves ByteDepp and service history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-delete-'));
  const source = new DatabaseSync(join(dir, 'byte.sqlite'));
  source.exec(
    'CREATE TABLE devices(device_id TEXT PRIMARY KEY,vin TEXT,language_active INTEGER,store_active INTEGER,language_expires_at INTEGER,store_expires_at INTEGER,created_at INTEGER,updated_at INTEGER)',
  );
  const vin = 'L6T79D2D0PP123456',
    password = 'test-admin-password',
    salt = '42'.repeat(16);
  source
    .prepare('INSERT INTO devices(device_id,vin,language_active,store_active) VALUES(?,?,1,1)')
    .run('test-device', vin);
  const original = source.prepare('SELECT * FROM devices').all();
  const origin = 'http://127.0.0.1:3080';
  const app = await createApp({
    dataDir: join(dir, 'panel'),
    bytePath: join(dir, 'byte.sqlite'),
    publicUrl: origin,
    passwordHash: salt + ':' + scryptSync(password, salt, 64).toString('hex'),
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port,
    cookies = {};
  async function call(role, path, body, requestOrigin = origin) {
    const r = await fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: requestOrigin,
        ...(cookies[role] ? { Cookie: cookies[role] } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.headers.get('set-cookie')) cookies[role] = r.headers.get('set-cookie').split(';')[0];
    return { status: r.status, body: await r.json() };
  }
  try {
    await call('admin', '/login', { password });
    await call('client', '/client/register', {
      name: 'Owner',
      email: 'owner@example.invalid',
      password: 'test-client-password',
    });
    const car = (await call('client', '/client/vehicles', { vin })).body.id;
    assert.equal(
      (
        await call('admin', `/vehicles/${car}/link`, {
          device_id: 'test-device',
          confirm_vin: vin,
          owner_verified: true,
        })
      ).status,
      200,
    );
    const route = `/vehicles/${car}/delete`;
    assert.equal((await call('none', route, { confirm_vin: vin })).status, 401);
    assert.equal((await call('client', route, { confirm_vin: vin })).status, 401);
    assert.equal(
      (await call('admin', route, { confirm_vin: vin }, 'https://evil.invalid')).status,
      403,
    );
    assert.equal((await call('admin', route, { confirm_vin: 'WRONG' })).status, 400);
    assert.equal((await call('client', '/client/state')).body.vehicles.length, 1);
    assert.equal((await call('admin', route, { confirm_vin: vin })).status, 200);
    assert.equal((await call('client', '/client/state')).body.vehicles.length, 0);
    const state = (await call('admin', '/state')).body;
    assert.equal(state.vehicles.length, 0);
    assert.ok(JSON.stringify(state.events).includes('Автомобиль удалён'));
    assert.deepEqual(source.prepare('SELECT * FROM devices').all(), original);
    assert.equal((await call('admin', route, { confirm_vin: vin })).status, 404);
    const replacement = await call('client', '/client/vehicles', { vin });
    assert.equal(replacement.status, 201);
    assert.notEqual(replacement.body.id, car);
    const id = replacement.body.id;
    const booking = await call('client', '/client/appointments', {
      vehicle_id: id,
      request_key: randomUUID(),
      service: 'diagnostics',
      phone: '+7 999 000-00-00',
      preferred_date: moscowDate(Date.now() + 86400000),
      preferred_time: '12:00',
    });
    assert.equal(booking.status, 201);
    assert.equal((await call('admin', `/vehicles/${id}/delete`, { confirm_vin: vin })).status, 409);
    const request = (await call('client', '/client/state')).body.appointments[0];
    assert.equal(
      (
        await call('client', `/client/appointments/${request.id}/cancel`, {
          version: request.version,
        })
      ).status,
      200,
    );
    assert.equal((await call('admin', `/vehicles/${id}/delete`, { confirm_vin: vin })).status, 409);
    assert.equal((await call('client', '/client/state')).body.appointments.length, 1);
  } finally {
    await new Promise((r) => app.close(r));
    source.close();
    await rm(dir, { recursive: true, force: true });
  }
});
