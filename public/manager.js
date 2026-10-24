const stageColors = {
  new: '#6366f1', contacted: '#3b82f6', negotiation: '#f59e0b',
  proposal: '#8b5cf6', won: '#10b981', lost: '#ef4444',
};
const statusColors = {
  new: '#6366f1', confirmed: '#3b82f6', in_progress: '#f59e0b',
  completed: '#10b981', cancelled: '#ef4444',
};
const statusNames = {
  new: 'На рассмотрении', confirmed: 'Подтверждена', in_progress: 'В работе',
  completed: 'Завершена', cancelled: 'Отменена',
};

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка');
  return data;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function fmt(n) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n || 0);
}

// Login
document.getElementById('login-btn').onclick = async () => {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const err = document.getElementById('login-error');
  try {
    await api('/api/manager/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    err.textContent = '';
    init();
  } catch (e) {
    err.textContent = e.message;
  }
};

document.getElementById('logout-btn').onclick = async () => {
  await api('/api/manager/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  location.reload();
};

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => { t.classList.remove('active'); t.style.display = 'none'; });
    btn.classList.add('active');
    const tab = document.getElementById('tab-' + btn.dataset.tab);
    tab.classList.add('active');
    tab.style.display = 'block';
  };
});

async function init() {
  try {
    const state = await api('/api/manager/state');
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('main-screen').style.display = 'block';
    document.getElementById('manager-name').textContent = state.manager.name;
    renderDeals(state.deals, state.dealStages);
    renderAppointments(state.appointments);
  } catch {
    // not logged in
  }
}

function renderDeals(dealsList, stages) {
  const container = document.getElementById('tab-deals');
  const board = {};
  for (const s of stages) board[s.id] = [];
  for (const d of dealsList) {
    if (board[d.stage]) board[d.stage].push(d);
  }
  container.innerHTML = `
    <div style="margin-bottom:12px"><button class="btn btn-primary" id="mgr-new-deal" style="width:auto;padding:8px 16px">+ Новая сделка</button></div>
    <div class="kanban-board">
      ${stages.map(s => `
        <div class="kanban-column">
          <div class="kanban-column-header" style="background:${s.color}">
            <span>${s.name}</span><span class="count">${board[s.id].length}</span>
          </div>
          ${board[s.id].map(d => `
            <div class="kanban-card" data-id="${d.id}">
              <div class="title">${esc(d.title)}</div>
              <div class="client">${esc(d.client_name || '')}</div>
              <div class="amount">${fmt(d.amount)}</div>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>`;
  container.querySelector('#mgr-new-deal').onclick = () => showDealModal(stages);
  container.querySelectorAll('.kanban-card').forEach(el => {
    el.onclick = () => {
      const deal = dealsList.find(d => d.id === el.dataset.id);
      if (deal) showDealModal(stages, deal);
    };
  });
}

function showDealModal(stages, deal) {
  const overlay = document.createElement('div');
  overlay.className = 'deal-modal-overlay';
  overlay.innerHTML = `<div class="deal-modal">
    <h3>${deal ? 'Редактировать' : 'Новая сделка'}</h3>
    <label>Название</label><input id="md-title" value="${esc(deal?.title || '')}" />
    <label>Стадия</label><select id="md-stage">${stages.map(s => `<option value="${s.id}" ${deal?.stage === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
    <label>Сумма</label><input id="md-amount" type="number" value="${deal?.amount || 0}" />
    <label>Источник</label><input id="md-source" value="${esc(deal?.source || '')}" />
    <label>Описание</label><textarea id="md-desc">${esc(deal?.description || '')}</textarea>
    <div class="deal-actions">
      <button class="btn" id="md-cancel">Отмена</button>
      <button class="btn btn-primary" id="md-save" style="width:auto">Сохранить</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#md-cancel').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#md-save').onclick = async () => {
    const body = {
      title: overlay.querySelector('#md-title').value,
      stage: overlay.querySelector('#md-stage').value,
      amount: Number(overlay.querySelector('#md-amount').value),
      source: overlay.querySelector('#md-source').value,
      description: overlay.querySelector('#md-desc').value,
    };
    const url = deal ? '/api/manager/deals/' + deal.id : '/api/manager/deals';
    await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    overlay.remove();
    init();
  };
}

function renderAppointments(list) {
  const container = document.getElementById('tab-appointments');
  if (!list.length) { container.innerHTML = '<p style="color:var(--muted)">Нет заявок</p>'; return; }
  container.innerHTML = `<div class="appointments-list">${list.map(a => `
    <div class="appt-card">
      <div class="appt-info">
        <strong>${esc(a.vin)}</strong> — ${esc(a.service)}<br>
        <span style="color:var(--muted)">${esc(a.client_name || '')} · ${a.preferred_date} ${a.preferred_time || ''}</span>
      </div>
      <span class="appt-status" style="background:${statusColors[a.status] || '#64748b'}">${statusNames[a.status] || a.status}</span>
    </div>
  `).join('')}</div>`;
}

init();
