import { randomUUID, randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
function text(value, label, max, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    fail(400, `Проверьте поле «${label}»`);
  return value.trim();
}

export function createManagers(db, audit, cookieUtil) {
  db.exec(`CREATE TABLE IF NOT EXISTS managers(
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS manager_sessions(
    hash TEXT PRIMARY KEY,
    manager_id TEXT NOT NULL REFERENCES managers(id),
    expires INTEGER NOT NULL
  );`);

  const one = (sql, ...args) => db.prepare(sql).get(...args),
    all = (sql, ...args) => db.prepare(sql).all(...args),
    run = (sql, ...args) => db.prepare(sql).run(...args);

  function list() {
    return all('SELECT id, email, name, permissions, active, created_at FROM managers ORDER BY created_at DESC');
  }

  async function create(b) {
    const id = randomUUID();
    const email = text(b.email, 'Email', 254, true).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Проверьте email');
    const name = text(b.name, 'Имя', 100, true);
    const password = text(b.password, 'Пароль', 256, true);
    if (password.length < 8) fail(400, 'Пароль не менее 8 символов');
    if (one('SELECT id FROM managers WHERE email=?', email))
      fail(409, 'Менеджер с таким email уже существует');
    const salt = randomBytes(16).toString('hex');
    const hash = salt + ':' + (await scrypt(password, salt, 64)).toString('hex');
    const permissions = JSON.stringify(b.permissions || { deals: true, appointments: true, clients: false });
    run(
      'INSERT INTO managers(id,email,name,password_hash,permissions,created_at) VALUES(?,?,?,?,?,?)',
      id, email, name, hash, permissions, Date.now(),
    );
    audit('admin', 'Создан менеджер', email);
    return { id };
  }

  async function login(b, ip, limit, res) {
    limit('manager-auth:' + ip, 15, 15 * 60000);
    const email = text(b.email, 'Email', 254, true).toLowerCase();
    const password = text(b.password, 'Пароль', 256, true);
    const manager = one('SELECT * FROM managers WHERE email=? AND active=1', email);
    if (!manager) fail(401, 'Неверный email или пароль');
    const [salt, hex] = manager.password_hash.split(':');
    const actual = await scrypt(password, salt, 64);
    if (!timingSafeEqual(actual, Buffer.from(hex, 'hex'))) fail(401, 'Неверный email или пароль');
    const value = token();
    run('DELETE FROM manager_sessions WHERE expires<?', Date.now());
    run('INSERT INTO manager_sessions VALUES(?,?,?)', sha(value), manager.id, Date.now() + 12 * 3600000);
    res.setHeader('Set-Cookie', cookieUtil('fleet_manager_session', value, 12 * 3600));
    audit('manager', 'Вход менеджера', email);
    return { ok: true };
  }

  function auth(req) {
    const raw = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('fleet_manager_session='))
      ?.slice('fleet_manager_session='.length);
    if (!raw) fail(401, 'Войдите как менеджер');
    const session = one(
      'SELECT managers.id, managers.email, managers.name, managers.permissions FROM managers JOIN manager_sessions ON manager_sessions.manager_id=managers.id WHERE manager_sessions.hash=? AND manager_sessions.expires>? AND managers.active=1',
      sha(raw), Date.now(),
    );
    if (!session) fail(401, 'Сессия истекла');
    session.role = 'manager';
    session.session = raw;
    return session;
  }

  function logout(req) {
    const raw = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('fleet_manager_session='))
      ?.slice('fleet_manager_session='.length);
    if (raw) run('DELETE FROM manager_sessions WHERE hash=?', sha(raw));
  }

  async function update(id, b) {
    const m = one('SELECT * FROM managers WHERE id=?', id);
    if (!m) fail(404, 'Менеджер не найден');
    if (b.name !== undefined) run('UPDATE managers SET name=? WHERE id=?', text(b.name, 'Имя', 100, true), id);
    if (b.active !== undefined) run('UPDATE managers SET active=? WHERE id=?', b.active ? 1 : 0, id);
    if (b.permissions !== undefined)
      run('UPDATE managers SET permissions=? WHERE id=?', JSON.stringify(b.permissions), id);
    if (b.password) {
      if (b.password.length < 8) fail(400, 'Пароль не менее 8 символов');
      const salt = randomBytes(16).toString('hex');
      const hash = salt + ':' + (await scrypt(b.password, salt, 64)).toString('hex');
      run('UPDATE managers SET password_hash=? WHERE id=?', hash, id);
      run('DELETE FROM manager_sessions WHERE manager_id=?', id);
    }
    audit('admin', 'Менеджер обновлён', m.email);
    return { ok: true };
  }

  return { list, create, login, auth, logout, update };
}
