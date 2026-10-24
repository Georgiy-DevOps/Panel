import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readByteDepp } from './bytedepp.mjs';
import { createAppointments } from './appointments.mjs';
import { createDeals, dealStages, dealStageIds } from './deals.mjs';
import { createManagers } from './managers.mjs';
import { createDashboard } from './dashboard.mjs';
import { createNotifier } from './telegram.mjs';

const scrypt = promisify(scryptCallback),
  here = dirname(fileURLToPath(import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const now = () => Date.now();
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const field = (value, name, max = 100) => {
  // Reject control characters in user-supplied fields.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value))
    fail(400, `Проверьте поле «${name}»`);
  return value.trim();
};
const validateVin = (value) =>
  /^[A-HJ-NPR-Z0-9]{17}$/.test(value || '')
    ? value
    : fail(400, 'VIN должен содержать 17 латинских букв и цифр, без I, O, Q');
async function json(req) {
  if (!req.headers['content-type']?.startsWith('application/json'))
    fail(415, 'Ожидается application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) fail(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    fail(400, 'Некорректный JSON');
  }
}

export async function createApp(config = {}) {
  const dataDir = resolve(config.dataDir || process.env.DATA_DIR || join(here, 'data'));
  const publicUrl = new URL(config.publicUrl || process.env.PUBLIC_URL || 'http://127.0.0.1:3080');
  if (
    publicUrl.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)
  )
    throw new Error('Для удалённого доступа требуется HTTPS');
  const passwordHash = config.passwordHash || process.env.ADMIN_PASSWORD_HASH;
  if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(passwordHash || ''))
    throw new Error('Сначала выполните npm run setup');
  const [salt, expectedHex] = passwordHash.split(':');
  const trustProxy = config.trustProxy ?? process.env.TRUST_PROXY === '1';
  const bytePath = config.bytePath || process.env.BYTEDEPP_DB;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'fleet.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS client_sessions(hash TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vehicles(id TEXT PRIMARY KEY,vin TEXT NOT NULL UNIQUE,brand TEXT NOT NULL,model TEXT NOT NULL,hardware TEXT NOT NULL DEFAULT '',region TEXT NOT NULL DEFAULT '',software TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL);
  `);
  const run = (sql, ...args) => db.prepare(sql).run(...args),
    one = (sql, ...args) => db.prepare(sql).get(...args),
    all = (sql, ...args) => db.prepare(sql).all(...args);
  for (const [name, type] of [
    ['client_id', 'TEXT REFERENCES clients(id)'],
    ['byte_device_id', 'TEXT'],
    ['linked_at', 'INTEGER'],
  ])
    if (!all('PRAGMA table_info(vehicles)').some((c) => c.name === name))
      db.exec(`ALTER TABLE vehicles ADD COLUMN ${name} ${type}`);
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS one_bytedepp_device ON vehicles(byte_device_id) WHERE byte_device_id IS NOT NULL',
  );
  const audit = (actor, action, target) =>
    run(
      'INSERT INTO events(actor,action,target,created_at) VALUES(?,?,?,?)',
      actor,
      action,
      target,
      now(),
    );
  const notifier = createNotifier();
  const appointments = createAppointments(db, audit);
  const deals = createDeals(db, audit, (event, data) => notifier.send(event, data));
  const dashboard = createDashboard(db);
  function selectedClient(value) {
    if (value === undefined || value === null || value === '') return null;
    const account = one('SELECT id,email FROM clients WHERE id=?', field(value, 'Клиент', 36));
    if (!account) fail(400, 'Клиент не найден. Обновите список клиентов.');
    return account;
  }
  function addVehicle(b, clientId) {
    const id = randomUUID(),
      vin = validateVin(field(b.vin, 'VIN', 32).toUpperCase());
    if (one('SELECT id FROM vehicles WHERE vin=?', vin))
      fail(
        409,
        'Этот VIN уже зарегистрирован. Обратитесь к администратору или найдите автомобиль в панели.',
      );
    const brand = b.brand || 'Не указана';
    if (!['Zeekr', 'Lynk & Co', 'Не указана'].includes(brand)) fail(400, 'Выберите марку');
    run(
      'INSERT INTO vehicles(id,vin,brand,model,hardware,region,software,client_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      vin,
      brand,
      b.model ? field(b.model, 'Модель') : 'Модель не указана',
      '',
      b.region ? field(b.region, 'Регион') : '',
      null,
      clientId,
      now(),
    );
    return { id, vin };
  }
  const limits = new Map();
  function limit(key, max, span) {
    const time = now();
    let item = limits.get(key);
    if (!item || item.until < time) {
      item = { count: 0, until: time + span };
      limits.set(key, item);
    }
    if (++item.count > max) fail(429, 'Слишком много попыток. Повторите позже.');
    if (limits.size > 10000) for (const [k, v] of limits) if (v.until < time) limits.delete(k);
  }
  const remoteIp = (req) =>
    trustProxy && /^[a-fA-F0-9:.]{3,45}$/.test(req.headers['x-real-ip'] || '')
      ? req.headers['x-real-ip']
      : req.socket.remoteAddress;
  const origin = (req) => {
    if (req.headers.origin !== publicUrl.origin) fail(403, 'Недопустимый источник запроса');
  };
  const cookieValue = (req, name) =>
    req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + '='))
      ?.slice(name.length + 1);
  const cookie = (name, value, age) =>
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${publicUrl.protocol === 'https:' ? '; Secure' : ''}`;
  const managers = createManagers(db, audit, cookie);
  function admin(req) {
    const raw = cookieValue(req, 'fleet_session');
    if (!raw || !one('SELECT hash FROM sessions WHERE hash=? AND expires>?', sha(raw), now()))
      fail(401, 'Войдите как администратор');
    return raw;
  }
  function client(req) {
    const raw = cookieValue(req, 'fleet_client_session');
    const c =
      raw &&
      one(
        'SELECT clients.id,clients.email,clients.name FROM clients JOIN client_sessions ON client_sessions.client_id=clients.id WHERE client_sessions.hash=? AND client_sessions.expires>?',
        sha(raw),
        now(),
      );
    if (!c) fail(401, 'Войдите в личный кабинет');
    return { ...c, session: raw };
  }
  function cars(rows, byte, forAdmin = false) {
    return rows.map((v) => {
      const device = v.byte_device_id && byte.devices.find((d) => d.device_id === v.byte_device_id);
      const mismatch = !!(device?.vin && device.vin !== v.vin);
      const report = device && !mismatch && device.vin === v.vin ? device : null;
      const out = {
        id: v.id,
        vin: v.vin,
        brand: v.brand,
        model: v.model,
        software: report?.vehicle_software_version || null,
        reported_vin: report?.vin || null,
        vin_reported_at: report?.vin_reported_at || null,
        software_reported_at: report?.vehicle_software_reported_at || null,
        region: v.region,
        created_at: v.created_at,
        linked_at: v.linked_at,
        link_status: !v.byte_device_id
          ? 'pending'
          : !byte.connected
            ? 'unavailable'
            : !device
              ? 'missing'
              : mismatch
                ? 'mismatch'
                : 'linked',
        bytedepp:
          device && !mismatch
            ? { language: device.language, store: device.store, updated_at: device.updated_at }
            : null,
      };
      if (forAdmin)
        Object.assign(out, {
          client_id: v.client_id,
          client_email: v.client_email,
          client_name: v.client_name,
          byte_device_id: v.byte_device_id,
          matching_devices: byte.devices.filter((d) => d.vin === v.vin).map((d) => d.device_id),
        });
      return out;
    });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (publicUrl.protocol === 'https:')
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url, 'http://localhost').pathname,
        method = req.method;
      if (path === '/health' && method === 'GET') return send(200, { ok: true });
      const assets = {
        '/': ['client.html', 'text/html'],
        '/client': ['client.html', 'text/html'],
        '/admin': ['index.html', 'text/html'],
        '/client.js': ['client.js', 'text/javascript'],
        '/client.css': ['client.css', 'text/css'],
        '/app.js': ['app.js', 'text/javascript'],
        '/style.css': ['style.css', 'text/css'],
        '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
      };
      for (const file of ['service-catalog.js', 'appointments-ui.js', 'deals-ui.js', 'dashboard-ui.js', 'theme-init.js'])
        assets['/' + file] = [file, 'text/javascript'];
      assets['/appointments.css'] = ['appointments.css', 'text/css'];
      assets['/deals.css'] = ['deals.css', 'text/css'];
      assets['/dashboard.css'] = ['dashboard.css', 'text/css'];
      assets['/manager'] = ['manager.html', 'text/html'];
      assets['/manager.js'] = ['manager.js', 'text/javascript'];
      assets['/manager.css'] = ['manager.css', 'text/css'];
      if (assets[path] && method === 'GET') {
        const [file, type] = assets[path];
        res.setHeader('Content-Type', type + '; charset=utf-8');
        return res.end(await readFile(join(here, 'public', file)));
      }
      if (path === '/api/login' && method === 'POST') {
        origin(req);
        limit('admin:' + remoteIp(req), 15, 15 * 60000);
        const b = await json(req);
        const password = field(b.password, 'Пароль', 512);
        const actual = await scrypt(password, salt, 64);
        if (!timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'))) fail(401, 'Неверный пароль');
        limits.delete('admin:' + remoteIp(req));
        const value = token();
        run('DELETE FROM sessions WHERE expires<?', now());
        run('INSERT INTO sessions VALUES(?,?)', sha(value), now() + 8 * 3600000);
        res.setHeader('Set-Cookie', cookie('fleet_session', value, 8 * 3600));
        audit('admin', 'Вход администратора', 'admin');
        return send(200, { ok: true });
      }
      if (path.startsWith('/api/client/')) {
        if (!['GET', 'HEAD'].includes(method)) origin(req);
        if (['/api/client/login', '/api/client/register'].includes(path) && method === 'POST') {
          const ip = remoteIp(req);
          limit('client-auth:' + ip, 15, 15 * 60000);
          const b = await json(req);
          const email = field(b.email, 'Email', 254).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Проверьте email');
          const password = field(b.password, 'Пароль', 256);
          let account;
          if (path.endsWith('/register')) {
            if (password.length < 12) fail(400, 'Пароль должен содержать не менее 12 символов');
            limit('register:' + ip, 5, 3600000);
            const name = field(b.name, 'Имя');
            if (one('SELECT id FROM clients WHERE email=?', email))
              fail(409, 'Этот email уже зарегистрирован. Войдите в кабинет.');
            const userSalt = randomBytes(16).toString('hex');
            const hash = userSalt + ':' + (await scrypt(password, userSalt, 64)).toString('hex');
            if (one('SELECT id FROM clients WHERE email=?', email))
              fail(409, 'Этот email уже зарегистрирован');
            const id = randomUUID();
            run('INSERT INTO clients VALUES(?,?,?,?,?)', id, email, name, hash, now());
            account = { id, email, name };
            audit('client', 'Создан личный кабинет', email);
          } else {
            account = one('SELECT * FROM clients WHERE email=?', email);
            const [userSalt, hex] = account
              ? account.password_hash.split(':')
              : [salt, expectedHex];
            const actual = await scrypt(password, userSalt, 64);
            if (!account || !timingSafeEqual(actual, Buffer.from(hex, 'hex')))
              fail(401, 'Неверный email или пароль');
          }
          limits.delete('client-auth:' + ip);
          const value = token();
          run('DELETE FROM client_sessions WHERE expires<?', now());
          run(
            'INSERT INTO client_sessions VALUES(?,?,?)',
            sha(value),
            account.id,
            now() + 7 * 86400000,
          );
          res.setHeader('Set-Cookie', cookie('fleet_client_session', value, 7 * 86400));
          return send(200, { ok: true });
        }
        const user = client(req);
        if (path === '/api/client/logout' && method === 'POST') {
          run('DELETE FROM client_sessions WHERE hash=?', sha(user.session));
          res.setHeader('Set-Cookie', cookie('fleet_client_session', '', 0));
          return send(200, { ok: true });
        }
        if (path === '/api/client/state' && method === 'GET') {
          const byte = readByteDepp(bytePath);
          return send(200, {
            client: { id: user.id, name: user.name, email: user.email },
            vehicles: cars(
              all('SELECT * FROM vehicles WHERE client_id=? ORDER BY created_at DESC', user.id),
              byte,
            ),
            appointments: appointments.list(user.id),
            integration_available: byte.connected,
          });
        }
        if (path === '/api/client/appointments' && method === 'POST') {
          const result = appointments.create(user, await json(req));
          return send(result.replayed ? 200 : 201, result);
        }
        const cancellation = path.match(/^\/api\/client\/appointments\/([0-9a-f-]{36})\/cancel$/);
        if (cancellation && method === 'POST')
          return send(200, appointments.cancel(user, cancellation[1], await json(req)));
        if (path === '/api/client/vehicles' && method === 'POST') {
          const b = await json(req);
          if (one('SELECT COUNT(*) AS n FROM vehicles WHERE client_id=?', user.id).n >= 20)
            fail(400, 'Для добавления более 20 автомобилей обратитесь к администратору');
          const { id, vin } = addVehicle(b, user.id);
          audit('client', 'Клиент зарегистрировал VIN', user.email + ' · ' + vin);
          return send(201, { id });
        }
        fail(404, 'Метод не найден');
      }
      if (!path.startsWith('/api/')) fail(404, 'Страница не найдена');
      const session = admin(req);
      if (!['GET', 'HEAD'].includes(method)) origin(req);
      if (path === '/api/logout' && method === 'POST') {
        run('DELETE FROM sessions WHERE hash=?', sha(session));
        res.setHeader('Set-Cookie', cookie('fleet_session', '', 0));
        return send(200, { ok: true });
      }
      if (path === '/api/vehicles' && method === 'POST') {
        const b = await json(req),
          account = selectedClient(b.client_id),
          { id, vin } = addVehicle(b, account?.id ?? null);
        audit(
          'admin',
          'Администратор добавил автомобиль',
          vin + ' · ' + (account?.email || 'Без клиента'),
        );
        return send(201, { id });
      }
      if (path === '/api/state' && method === 'GET') {
        const byte = readByteDepp(bytePath);
        return send(200, {
          vehicles: cars(
            all(
              'SELECT vehicles.*,clients.email AS client_email,clients.name AS client_name FROM vehicles LEFT JOIN clients ON clients.id=vehicles.client_id ORDER BY vehicles.created_at DESC',
            ),
            byte,
            true,
          ),
          clients: all('SELECT id,email,name,created_at FROM clients ORDER BY created_at DESC'),
          appointments: appointments.list(),
          events: all('SELECT * FROM events ORDER BY id DESC LIMIT 100'),
          bytedepp: byte,
          managers: managers.list(),
          dealCount: one("SELECT count(*) AS c FROM deals WHERE stage NOT IN ('won','lost')")?.c || 0,
          server: { time: now(), public_url: publicUrl.origin },
        });
      }
      const appointmentUpdate = path.match(/^\/api\/appointments\/([0-9a-f-]{36})\/update$/);
      if (appointmentUpdate && method === 'POST')
        return send(200, appointments.update(appointmentUpdate[1], await json(req)));
      const deletion = path.match(/^\/api\/vehicles\/([0-9a-f-]{36})\/delete$/);
      if (deletion && method === 'POST') {
        const b = await json(req);
        db.exec('BEGIN IMMEDIATE');
        try {
          const v = one('SELECT * FROM vehicles WHERE id=?', deletion[1]);
          if (!v) fail(404, 'Автомобиль не найден');
          if (b.confirm_vin !== v.vin) fail(400, 'Подтвердите VIN');
          if (one('SELECT id FROM appointments WHERE vehicle_id=? LIMIT 1', v.id))
            fail(
              409,
              'У автомобиля есть сервисные заявки. Удаление недоступно, чтобы сохранить историю обслуживания.',
            );
          run('DELETE FROM vehicles WHERE id=?', v.id);
          audit('admin', 'Автомобиль удалён', v.vin);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        return send(200, { ok: true });
      }
      const assignment = path.match(/^\/api\/vehicles\/([0-9a-f-]{36})\/client$/);
      if (assignment && method === 'POST') {
        const b = await json(req),
          v = one('SELECT * FROM vehicles WHERE id=?', assignment[1]);
        if (!v) fail(404, 'Автомобиль не найден');
        if (b.confirm_vin !== v.vin) fail(400, 'Подтвердите VIN');
        const account = selectedClient(b.client_id),
          clientId = account?.id ?? null;
        if (clientId === v.client_id) return send(200, { ok: true });
        if (clientId && v.byte_device_id && b.owner_verified !== true)
          fail(400, 'Подтвердите принадлежность автомобиля выбранному клиенту');
        const previous = v.client_id
          ? one('SELECT email FROM clients WHERE id=?', v.client_id)?.email
          : null;
        db.exec('BEGIN IMMEDIATE');
        try {
          appointments.transfer(v.id);
          run('UPDATE vehicles SET client_id=? WHERE id=?', clientId, v.id);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        audit(
          'admin',
          clientId ? 'Автомобиль назначен клиенту' : 'Клиент автомобиля снят',
          v.vin + ' · ' + (previous || 'Без клиента') + ' → ' + (account?.email || 'Без клиента'),
        );
        return send(200, { ok: true });
      }
      const link = path.match(/^\/api\/vehicles\/([0-9a-f-]{36})\/link$/);
      if (link && method === 'POST') {
        const b = await json(req),
          v = one('SELECT * FROM vehicles WHERE id=?', link[1]);
        if (!v) fail(404, 'Автомобиль не найден');
        if (b.confirm_vin !== v.vin || b.owner_verified !== true)
          fail(400, 'Подтвердите VIN и принадлежность устройства автомобилю');
        const id = field(b.device_id, 'Устройство ByteDepp', 256),
          byte = readByteDepp(bytePath);
        if (!byte.connected) fail(503, 'ByteDepp недоступен');
        const device = byte.devices.find((d) => d.device_id === id);
        if (!device) fail(404, 'Устройство не найдено в ByteDepp');
        if (device.vin && device.vin !== v.vin)
          fail(409, 'VIN устройства ByteDepp не совпадает с VIN автомобиля');
        const other = one('SELECT id FROM vehicles WHERE byte_device_id=? AND id<>?', id, v.id);
        if (other) fail(409, 'Устройство уже связано с другим автомобилем');
        run('UPDATE vehicles SET byte_device_id=?,linked_at=? WHERE id=?', id, now(), v.id);
        audit('admin', 'Подтверждена связь с ByteDepp', v.vin + ' · ' + id);
        return send(200, { ok: true });
      }
      const unlink = path.match(/^\/api\/vehicles\/([0-9a-f-]{36})\/unlink$/);
      if (unlink && method === 'POST') {
        const b = await json(req),
          v = one('SELECT * FROM vehicles WHERE id=?', unlink[1]);
        if (!v) fail(404, 'Автомобиль не найден');
        if (b.confirm_vin !== v.vin) fail(400, 'Подтвердите VIN');
        run('UPDATE vehicles SET byte_device_id=NULL,linked_at=NULL WHERE id=?', v.id);
        audit('admin', 'Связь с ByteDepp снята', v.vin);
        return send(200, { ok: true });
      }
      // --- Manager auth ---
      if (path === '/api/manager/login' && method === 'POST') {
        origin(req);
        const result = await managers.login(await json(req), remoteIp(req), limit, res);
        return send(200, result);
      }
      // --- Manager portal ---
      if (path.startsWith('/api/manager/')) {
        if (!['GET', 'HEAD'].includes(method)) origin(req);
        const mgr = managers.auth(req);
        if (path === '/api/manager/logout' && method === 'POST') {
          managers.logout(req);
          res.setHeader('Set-Cookie', cookie('fleet_manager_session', '', 0));
          return send(200, { ok: true });
        }
        if (path === '/api/manager/state' && method === 'GET') {
          const perms = JSON.parse(mgr.permissions || '{}');
          return send(200, {
            manager: { id: mgr.id, name: mgr.name, email: mgr.email, permissions: perms },
            deals: perms.deals ? deals.list({ manager_id: mgr.id }) : [],
            appointments: perms.appointments ? appointments.list() : [],
            dealStages,
          });
        }
        if (path === '/api/manager/deals' && method === 'GET') {
          return send(200, deals.list({ manager_id: mgr.id }));
        }
        if (path === '/api/manager/deals' && method === 'POST') {
          const b = await json(req);
          b.manager_id = mgr.id;
          return send(201, deals.create(b, 'manager:' + mgr.email));
        }
        const mgrDealUpdate = path.match(/^\/api\/manager\/deals\/([0-9a-f-]{36})$/);
        if (mgrDealUpdate && method === 'POST') {
          return send(200, deals.update(mgrDealUpdate[1], await json(req), 'manager:' + mgr.email));
        }
        fail(404, 'Метод не найден');
      }
      // --- Deals (admin) ---
      if (path === '/api/deals' && method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        return send(200, deals.list({
          stage: url.searchParams.get('stage') || undefined,
          manager_id: url.searchParams.get('manager_id') || undefined,
          client_id: url.searchParams.get('client_id') || undefined,
          search: url.searchParams.get('q') || undefined,
        }));
      }
      if (path === '/api/deals/kanban' && method === 'GET')
        return send(200, { board: deals.kanban(), stages: dealStages });
      if (path === '/api/deals/stats' && method === 'GET')
        return send(200, deals.stats());
      if (path === '/api/deals' && method === 'POST')
        return send(201, deals.create(await json(req), 'admin'));
      const dealGet = path.match(/^\/api\/deals\/([0-9a-f-]{36})$/);
      if (dealGet && method === 'GET') return send(200, deals.get(dealGet[1]));
      if (dealGet && method === 'POST') return send(200, deals.update(dealGet[1], await json(req), 'admin'));
      const dealDelete = path.match(/^\/api\/deals\/([0-9a-f-]{36})\/delete$/);
      if (dealDelete && method === 'POST') return send(200, deals.remove(dealDelete[1]));
      // --- Managers (admin) ---
      if (path === '/api/managers' && method === 'GET') return send(200, managers.list());
      if (path === '/api/managers' && method === 'POST') return send(201, await managers.create(await json(req)));
      const managerUpdate = path.match(/^\/api\/managers\/([0-9a-f-]{36})$/);
      if (managerUpdate && method === 'POST') return send(200, await managers.update(managerUpdate[1], await json(req)));
      // --- Dashboard (admin) ---
      if (path === '/api/dashboard' && method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const period = url.searchParams.get('period') || 'all';
        return send(200, dashboard.stats(period));
      }
      // --- Search (admin) ---
      if (path === '/api/search' && method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const q = url.searchParams.get('q') || '';
        if (!q || q.length < 2) return send(200, { clients: [], vehicles: [], deals: [] });
        const term = '%' + q + '%';
        return send(200, {
          clients: all('SELECT id,email,name,created_at FROM clients WHERE name LIKE ? OR email LIKE ? LIMIT 20', term, term),
          vehicles: all('SELECT id,vin,brand,model,created_at FROM vehicles WHERE vin LIKE ? OR brand LIKE ? OR model LIKE ? LIMIT 20', term, term, term),
          deals: all('SELECT id,title,stage,amount,updated_at FROM deals WHERE title LIKE ? OR description LIKE ? LIMIT 20', term, term),
        });
      }
      // --- Telegram config (admin) ---
      if (path === '/api/telegram/status' && method === 'GET')
        return send(200, { enabled: notifier.enabled });
      fail(404, 'Метод не найден');
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        if (!res.destroyed) res.destroy();
        return;
      }
      if (!error.status) console.error('Request failed:', error.code || error.name, error.message);
      send(error.status || 500, {
        error: error.status ? error.message : 'Ошибка сервера. Повторите запрос.',
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', () => db.close());
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp(),
    port = Number(process.env.PORT || 3080);
  server.listen(port, process.env.HOST || '127.0.0.1', () =>
    console.log('Fleet panel listening on port ' + port),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => server.close(() => process.exit(0)));
}
