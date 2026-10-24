import { randomUUID } from 'node:crypto';

export const dealStages = [
  { id: 'new', name: 'Новый', color: '#6366f1' },
  { id: 'contacted', name: 'Связались', color: '#3b82f6' },
  { id: 'negotiation', name: 'Переговоры', color: '#f59e0b' },
  { id: 'proposal', name: 'Предложение', color: '#8b5cf6' },
  { id: 'won', name: 'Выигран', color: '#10b981' },
  { id: 'lost', name: 'Проигран', color: '#ef4444' },
];
export const dealStageIds = dealStages.map((s) => s.id);
export const activeDealStages = ['new', 'contacted', 'negotiation', 'proposal'];

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
function text(value, label, max, required = false) {
  if (value === undefined || value === null) value = '';
  if (
    typeof value !== 'string' ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x08\x0b-\x1f\x7f]/.test(value) ||
    (required && !value.trim())
  )
    fail(400, `Проверьте поле «${label}»`);
  return value.trim();
}

export function createDeals(db, audit, notify) {
  db.exec(`CREATE TABLE IF NOT EXISTS deals(
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    client_id TEXT REFERENCES clients(id),
    vehicle_id TEXT REFERENCES vehicles(id),
    manager_id TEXT REFERENCES managers(id),
    stage TEXT NOT NULL DEFAULT 'new',
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'RUB',
    source TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    expected_close TEXT,
    closed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deals_stage ON deals(stage);
  CREATE INDEX IF NOT EXISTS deals_client ON deals(client_id);
  CREATE INDEX IF NOT EXISTS deals_manager ON deals(manager_id);
  CREATE TABLE IF NOT EXISTS deal_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id TEXT NOT NULL REFERENCES deals(id),
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    actor TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deal_events_deal ON deal_events(deal_id,id);`);

  const one = (sql, ...args) => db.prepare(sql).get(...args),
    all = (sql, ...args) => db.prepare(sql).all(...args),
    run = (sql, ...args) => db.prepare(sql).run(...args);

  function logChange(dealId, field, oldVal, newVal, actor) {
    if (String(oldVal || '') === String(newVal || '')) return;
    run(
      'INSERT INTO deal_events(deal_id,field,old_value,new_value,actor,created_at) VALUES(?,?,?,?,?,?)',
      dealId,
      field,
      String(oldVal || ''),
      String(newVal || ''),
      actor,
      Date.now(),
    );
  }

  function list(filters = {}) {
    let sql =
      'SELECT d.*, c.name AS client_name, c.email AS client_email, m.name AS manager_name FROM deals d LEFT JOIN clients c ON c.id=d.client_id LEFT JOIN managers m ON m.id=d.manager_id';
    const conditions = [];
    const params = [];
    if (filters.stage) {
      conditions.push('d.stage=?');
      params.push(filters.stage);
    }
    if (filters.manager_id) {
      conditions.push('d.manager_id=?');
      params.push(filters.manager_id);
    }
    if (filters.client_id) {
      conditions.push('d.client_id=?');
      params.push(filters.client_id);
    }
    if (filters.search) {
      conditions.push("(d.title LIKE ? OR c.name LIKE ? OR c.email LIKE ? OR d.description LIKE ?)");
      const term = '%' + filters.search + '%';
      params.push(term, term, term, term);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY d.updated_at DESC';
    return all(sql, ...params);
  }

  function kanban() {
    const deals = all(
      'SELECT d.*, c.name AS client_name, c.email AS client_email, m.name AS manager_name FROM deals d LEFT JOIN clients c ON c.id=d.client_id LEFT JOIN managers m ON m.id=d.manager_id ORDER BY d.priority DESC, d.updated_at DESC',
    );
    const board = {};
    for (const stage of dealStageIds) board[stage] = [];
    for (const deal of deals) {
      if (board[deal.stage]) board[deal.stage].push(deal);
    }
    return board;
  }

  function create(b, actor) {
    const id = randomUUID();
    const title = text(b.title, 'Название сделки', 200, true);
    const stage = dealStageIds.includes(b.stage) ? b.stage : 'new';
    const amount = typeof b.amount === 'number' && b.amount >= 0 ? b.amount : 0;
    const source = text(b.source || '', 'Источник', 100);
    const description = text(b.description || '', 'Описание', 2000);
    const priority = [0, 1, 2].includes(b.priority) ? b.priority : 0;
    const expectedClose = b.expected_close || null;
    const now = Date.now();
    run(
      `INSERT INTO deals(id,title,client_id,vehicle_id,manager_id,stage,amount,currency,source,description,priority,expected_close,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      title,
      b.client_id || null,
      b.vehicle_id || null,
      b.manager_id || null,
      stage,
      amount,
      b.currency || 'RUB',
      source,
      description,
      priority,
      expectedClose,
      now,
      now,
    );
    audit(actor, 'Создана сделка', title);
    notify('deal_created', { id, title, stage, amount, actor });
    return { id };
  }

  function update(id, b, actor) {
    const deal = one('SELECT * FROM deals WHERE id=?', id);
    if (!deal) fail(404, 'Сделка не найдена');
    const updates = {};
    if (b.title !== undefined) updates.title = text(b.title, 'Название', 200, true);
    if (b.stage !== undefined) {
      if (!dealStageIds.includes(b.stage)) fail(400, 'Некорректная стадия');
      updates.stage = b.stage;
      if (['won', 'lost'].includes(b.stage) && !deal.closed_at) updates.closed_at = Date.now();
      if (activeDealStages.includes(b.stage) && deal.closed_at) updates.closed_at = null;
    }
    if (b.amount !== undefined) updates.amount = typeof b.amount === 'number' && b.amount >= 0 ? b.amount : deal.amount;
    if (b.client_id !== undefined) updates.client_id = b.client_id || null;
    if (b.vehicle_id !== undefined) updates.vehicle_id = b.vehicle_id || null;
    if (b.manager_id !== undefined) updates.manager_id = b.manager_id || null;
    if (b.source !== undefined) updates.source = text(b.source, 'Источник', 100);
    if (b.description !== undefined) updates.description = text(b.description, 'Описание', 2000);
    if (b.priority !== undefined) updates.priority = [0, 1, 2].includes(b.priority) ? b.priority : deal.priority;
    if (b.expected_close !== undefined) updates.expected_close = b.expected_close || null;

    if (!Object.keys(updates).length) return { ok: true };

    updates.updated_at = Date.now();
    const sets = Object.keys(updates).map((k) => `${k}=?`).join(',');
    const vals = Object.values(updates);
    run(`UPDATE deals SET ${sets} WHERE id=?`, ...vals, id);

    for (const [field, newVal] of Object.entries(updates)) {
      if (field === 'updated_at') continue;
      logChange(id, field, deal[field], newVal, actor);
    }

    const oldStage = deal.stage;
    const newStage = updates.stage || oldStage;
    if (oldStage !== newStage) {
      audit(actor, 'Сделка: ' + dealStages.find((s) => s.id === newStage)?.name, updates.title || deal.title);
      notify('deal_stage_changed', { id, title: deal.title, old_stage: oldStage, new_stage: newStage, actor });
    }
    return { ok: true };
  }

  function get(id) {
    const deal = one(
      'SELECT d.*, c.name AS client_name, c.email AS client_email, m.name AS manager_name FROM deals d LEFT JOIN clients c ON c.id=d.client_id LEFT JOIN managers m ON m.id=d.manager_id WHERE d.id=?',
      id,
    );
    if (!deal) fail(404, 'Сделка не найдена');
    deal.history = all(
      'SELECT * FROM deal_events WHERE deal_id=? ORDER BY id',
      id,
    );
    return deal;
  }

  function remove(id) {
    const deal = one('SELECT * FROM deals WHERE id=?', id);
    if (!deal) fail(404, 'Сделка не найдена');
    run('DELETE FROM deal_events WHERE deal_id=?', id);
    run('DELETE FROM deals WHERE id=?', id);
    audit('admin', 'Удалена сделка', deal.title);
    return { ok: true };
  }

  function stats() {
    const byStage = all('SELECT stage, COUNT(*) AS count, SUM(amount) AS total FROM deals GROUP BY stage');
    const byMonth = all(
      "SELECT strftime('%Y-%m', created_at/1000, 'unixepoch') AS month, COUNT(*) AS count, SUM(amount) AS total FROM deals GROUP BY month ORDER BY month DESC LIMIT 12",
    );
    const funnel = dealStages.map((s) => {
      const row = byStage.find((r) => r.stage === s.id);
      return { stage: s.id, name: s.name, color: s.color, count: row?.count || 0, total: row?.total || 0 };
    });
    const wonTotal = byStage.find((r) => r.stage === 'won')?.total || 0;
    const lostTotal = byStage.find((r) => r.stage === 'lost')?.total || 0;
    const activeCount = all(
      "SELECT COUNT(*) AS n FROM deals WHERE stage IN ('new','contacted','negotiation','proposal')",
    )[0].n;
    return { funnel, byMonth, wonTotal, lostTotal, activeCount };
  }

  return { list, kanban, create, update, get, remove, stats };
}
