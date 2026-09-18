import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, scryptSync } from 'node:crypto';
import { createApp } from '../server.mjs';
import { moscowDate } from '../public/service-catalog.js';
import { appointmentCard } from '../public/appointments-ui.js';

test('Service requests: ownership, lifecycle, validation, retries, persistence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-bookings-')),
    salt = '24'.repeat(16),
    password = 'local-admin-test-password';
  const config = {
    dataDir: dir,
    publicUrl: 'http://127.0.0.1:3080',
    passwordHash: salt + ':' + scryptSync(password, salt, 64).toString('hex'),
  };
  let app, base;
  const cookies = {};
  async function start() {
    app = await createApp(config);
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + app.address().port;
  }
  async function call(role, path, body, origin = config.publicUrl) {
    const r = await fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        ...(cookies[role] ? { Cookie: cookies[role] } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.headers.get('set-cookie')) cookies[role] = r.headers.get('set-cookie').split(';')[0];
    return { status: r.status, body: await r.json() };
  }
  const vin = 'L6T79D2D0PP123456',
    otherVin = 'L6T79D2D0PP123457',
    tomorrow = moscowDate(Date.now() + 86400000);
  const request = (patch) => ({
    request_key: randomUUID(),
    vehicle_id: car,
    service: 'diagnostics',
    phone: '+7 (999) 000-00-00',
    preferred_date: tomorrow,
    preferred_time: '12:30',
    mileage: '23000',
    description: 'Ошибка на экране\nПри холодном запуске',
    ...patch,
  });
  const find = async (role, id) =>
    (await call(role, '/client/state')).body.appointments.find((a) => a.id === id);
  let car, otherCar, clientB, booking;
  try {
    await start();
    await call('admin', '/login', { password });
    for (const role of ['a', 'b'])
      assert.equal(
        (
          await call(role, '/client/register', {
            name: role,
            email: role + '@test.invalid',
            password: 'client-test-password',
          })
        ).status,
        200,
      );
    car = (await call('a', '/client/vehicles', { vin, brand: 'Lynk & Co', model: '900' })).body.id;
    otherCar = (await call('b', '/client/vehicles', { vin: otherVin })).body.id;
    clientB = (await call('b', '/client/state')).body.client.id;
    await t.test(
      'authenticated pages and module assets work, isolated roles and CSRF apply',
      async () => {
        for (const path of [
          '/client',
          '/admin',
          '/service-catalog.js',
          '/appointments-ui.js',
          '/appointments.css',
        ])
          assert.equal((await fetch(base + path)).status, 200);
        assert.equal((await call('none', '/client/appointments', request())).status, 401);
        assert.equal((await call('admin', '/client/appointments', request())).status, 401);
        assert.equal(
          (await call('a', '/client/appointments', request(), 'https://evil.invalid')).status,
          403,
        );
        assert.equal(
          (await call('a', '/client/appointments', request({ vehicle_id: otherCar }))).status,
          404,
        );
      },
    );
    await t.test(
      'rejects invalid dates, time, service, phone, mileage and oversized notes',
      async () => {
        for (const patch of [
          { preferred_date: '2026-02-30' },
          { preferred_date: '2020-01-01' },
          { preferred_date: moscowDate(Date.now() + 182 * 86400000) },
          { preferred_time: '24:30' },
          { preferred_time: {} },
          { service: 'unknown' },
          { phone: '123' },
          { phone: 'x'.repeat(15) },
          { mileage: -1 },
          { mileage: 1.5 },
          { mileage: 2000001 },
          { mileage: false },
          { description: 'x'.repeat(2001) },
          { request_key: 'x' },
        ]) {
          assert.equal(
            (await call('a', '/client/appointments', request(patch))).status,
            400,
            JSON.stringify(patch),
          );
        }
        assert.equal((await call('a', '/client/state')).body.appointments.length, 0);
      },
    );
    await t.test(
      'creates once on concurrent retry, ignores forged status, prevents active duplicates',
      async () => {
        const body = request({ status: 'confirmed', address: 'forged', client_id: clientB });
        const results = await Promise.all([
          call('a', '/client/appointments', body),
          call('a', '/client/appointments', body),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
        assert.equal(results[0].body.id, results[1].body.id);
        booking = results[0].body.id;
        const a = await find('a', booking);
        assert.equal(a.status, 'new');
        assert.equal(a.address, '');
        assert.equal(a.scheduled_at, null);
        assert.equal(a.mileage, 23000);
        assert.equal(a.history.length, 1);
        assert.ok(!('request_key' in a));
        assert.equal((await call('a', '/client/appointments', request())).status, 409);
        assert.equal((await call('b', '/client/state')).body.appointments.length, 0);
        assert.equal(
          (await call('b', `/client/appointments/${booking}/cancel`, { version: 1 })).status,
          404,
        );
        assert.equal(
          (await call('a', `/appointments/${booking}/update`, { version: 1, status: 'confirmed' }))
            .status,
          401,
        );
        const admin = (await call('admin', '/state')).body.appointments[0];
        assert.equal(admin.client_email, 'a@test.invalid');
        assert.equal(admin.phone, body.phone);
      },
    );
    await t.test(
      'confirmation requires address and future date; concurrent edits fail safely',
      async () => {
        const path = `/appointments/${booking}/update`,
          body = {
            version: 1,
            status: 'confirmed',
            scheduled_date: tomorrow,
            scheduled_time: '14:00',
            address: 'Москва, тестовый адрес',
            staff_note: 'Позвоните перед визитом',
          };
        assert.equal((await call('admin', path, body, 'https://evil.invalid')).status, 403);
        assert.equal((await call('admin', path, { ...body, address: '' })).status, 400);
        assert.equal(
          (await call('admin', path, { ...body, scheduled_date: '2020-01-01' })).status,
          400,
        );
        assert.equal((await call('admin', path, { ...body, status: 'completed' })).status, 409);
        const results = await Promise.all([
          call('admin', path, body),
          call('admin', path, { ...body, address: 'Другой адрес' }),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        const a = await find('a', booking);
        assert.equal(a.status, 'confirmed');
        assert.equal(a.version, 2);
        assert.equal(a.scheduled_at, Date.parse(tomorrow + 'T14:00:00+03:00'));
        assert.equal(a.history.length, 2);
        assert.equal(
          (await call('a', `/client/appointments/${booking}/cancel`, { version: 1 })).status,
          409,
        );
      },
    );
    await t.test(
      'rescheduling, in-progress and completion preserve a visible history',
      async () => {
        const path = `/appointments/${booking}/update`;
        assert.equal(
          (
            await call('admin', path, {
              version: 2,
              status: 'confirmed',
              scheduled_date: tomorrow,
              scheduled_time: '15:00',
              address: 'Новый согласованный адрес',
              staff_note: 'Перенесли по просьбе клиента',
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await call('admin', path, {
              version: 3,
              status: 'in_progress',
              staff_note: 'Проверяем ошибки',
            })
          ).status,
          200,
        );
        assert.equal(
          (await call('a', `/client/appointments/${booking}/cancel`, { version: 4 })).status,
          409,
        );
        assert.equal(
          (await call('admin', path, { version: 4, status: 'completed', staff_note: '' })).status,
          400,
        );
        assert.equal(
          (
            await call('admin', path, {
              version: 4,
              status: 'completed',
              staff_note: 'Диагностика выполнена. Причина установлена.',
            })
          ).status,
          200,
        );
        const a = await find('a', booking);
        assert.equal(a.status, 'completed');
        assert.equal(a.history.length, 5);
        assert.equal(a.address, 'Новый согласованный адрес');
        assert.equal((await call('admin', path, { version: 5, status: 'new' })).status, 409);
      },
    );
    await t.test(
      'client can cancel an unstarted request and rebook; foreign origin rejected',
      async () => {
        const created = await call(
          'a',
          '/client/appointments',
          request({ service: 'maintenance', mileage: '' }),
        );
        assert.equal(created.status, 201);
        const id = created.body.id;
        assert.equal((await find('a', id)).mileage, null);
        assert.equal(
          (
            await call(
              'a',
              `/client/appointments/${id}/cancel`,
              { version: 1 },
              'https://evil.invalid',
            )
          ).status,
          403,
        );
        assert.equal(
          (await call('a', `/client/appointments/${id}/cancel`, { version: 1 })).status,
          200,
        );
        assert.equal((await find('a', id)).status, 'cancelled');
        assert.equal(
          (await call('a', '/client/appointments', request({ service: 'maintenance' }))).status,
          201,
        );
      },
    );
    await t.test(
      'ownership transfer cancels active requests without disclosing old history to new owner',
      async () => {
        assert.equal(
          (await call('admin', `/vehicles/${car}/client`, { client_id: clientB, confirm_vin: vin }))
            .status,
          200,
        );
        const before = (await call('a', '/client/state')).body;
        assert.equal(before.vehicles.length, 0);
        assert.equal(
          before.appointments.filter((a) => ['new', 'confirmed', 'in_progress'].includes(a.status))
            .length,
          0,
        );
        assert.equal((await call('b', '/client/state')).body.appointments.length, 0);
        assert.equal((await call('a', '/client/appointments', request())).status, 404);
        assert.equal((await call('b', '/client/appointments', request())).status, 201);
      },
    );
    await t.test(
      'records, sessions and history persist across restart and HTML is escaped',
      async () => {
        const before = (await call('a', '/client/state')).body.appointments;
        await new Promise((r) => app.close(r));
        await start();
        assert.deepEqual((await call('a', '/client/state')).body.appointments, before);
        const markup = appointmentCard({
          ...before[0],
          description: '<img src=x onerror=alert(1)>',
          staff_note: '<script>bad()</script>',
          address: '<b>address</b>',
        });
        assert.ok(!markup.includes('<script>'));
        assert.ok(!markup.includes('<img'));
        assert.ok(markup.includes('&lt;script&gt;'));
        assert.ok(
          (await call('admin', '/state')).body.events.some(
            (e) => e.action === 'Заявка отменена при смене клиента',
          ),
        );
      },
    );
    await t.test('limits active requests and sustained create/cancel spam', async () => {
      const services = ['maintenance', 'diagnostics', 'bytedepp', 'consultation'];
      for (const service of services)
        assert.equal(
          (await call('b', '/client/appointments', request({ vehicle_id: otherCar, service })))
            .status,
          201,
        );
      assert.equal(
        (await call('b', '/client/appointments', request({ service: 'consultation' }))).status,
        409,
      );
      for (const a of (await call('b', '/client/state')).body.appointments)
        await call('b', `/client/appointments/${a.id}/cancel`, { version: a.version });
      for (let i = 0; i < 5; i++) {
        const created = await call('b', '/client/appointments', request());
        assert.equal(created.status, 201);
        await call('b', `/client/appointments/${created.body.id}/cancel`, { version: 1 });
      }
      assert.equal((await call('b', '/client/appointments', request())).status, 429);
    });
  } finally {
    if (app?.listening) await new Promise((r) => app.close(r));
    assert.ok(dir.startsWith(join(tmpdir(), 'panel-bookings-')), 'Unsafe cleanup');
    await rm(dir, { recursive: true, force: true });
  }
});
