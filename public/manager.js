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

const $ = (s) => document.querySelector(s);

// Theme toggle
const themeBtn = $('#mgr-theme-toggle');
if (themeBtn) {
  function updateThemeIcon() {
    themeBtn.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '☀' : '☾';
  }
  updateThemeIcon();
  themeBtn.onclick = () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('voltcrm-theme', next); } catch {}
    updateThemeIcon();
  };
}

// Login
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('#login-email').value;
  const password = $('#login-password').value;
  const err = $('#login-error');
  const btn = e.currentTarget.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    await api('/api/manager/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    err.textContent = '';
    init();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
};

$('#logout-btn').onclick = async () => {
  await api('/api/manager/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  location.reload();
};

// Tabs
document.querySelectorAll('.mgr-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.mgr-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.mgr-tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    const titles = { deals: 'Сделки', appointments: 'Заявки клиентов' };
    const subtitles = {
      deals: 'Kanban-доска сделок и управление заявками клиентов.',
      appointments: 'Все заявки на сервис от клиентов.',
    };
    $('#mgr-hero-title').textContent = titles[btn.dataset.tab] || '';
    $('#mgr-hero-subtitle').textContent = subtitles[btn.dataset.tab] || '';
    $('#mgr-new-deal').hidden = btn.dataset.tab !== 'deals';
  };
});

async function init() {
  try {
    const state = await api('/api/manager/state');
    $('#login-screen').hidden = true;
    $('#main-screen').hidden = false;
    $('#manager-name').textContent = state.manager.name;
    renderDeals(state.deals, state.dealStages);
    renderAppointments(state.appointments);
  } catch {
    $('#login-screen').hidden = false;
  }
}

function renderDeals(dealsList, stages) {
  const container = $('#tab-deals');
  const board = {};
  for (const s of stages) board[s.id] = [];
  for (const d of dealsList) {
    if (board[d.stage]) board[d.stage].push(d);
  }
  container.innerHTML = `
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
  container.querySelectorAll('.kanban-card').forEach(el => {
    el.onclick = () => {
      const deal = dealsList.find(d => d.id === el.dataset.id);
      if (deal) showDealModal(stages, deal);
    };
  });
}

$('#mgr-new-deal').onclick = async () => {
  try {
    const state = await api('/api/manager/state');
    showDealModal(state.dealStages);
  } catch {}
};

function showDealModal(stages, deal) {
  const overlay = document.createElement('div');
  overlay.className = 'deal-modal-overlay';
  overlay.innerHTML = `<div class="deal-modal">
    <h3>${deal ? 'Редактировать сделку' : 'Новая сделка'}</h3>
    <label>Название</label><input id="md-title" value="${esc(deal?.title || '')}" />
    <label>Стадия</label><select id="md-stage">${stages.map(s => `<option value="${s.id}" ${deal?.stage === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
    <label>Сумма</label><input id="md-amount" type="number" value="${deal?.amount || 0}" />
    <label>Источник</label><input id="md-source" value="${esc(deal?.source || '')}" />
    <label>Описание</label><textarea id="md-desc">${esc(deal?.description || '')}</textarea>
    <div class="deal-actions">
      <button class="btn-cancel" id="md-cancel">Отмена</button>
      <button class="btn-save" id="md-save">Сохранить</button>
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
  const container = $('#tab-appointments');
  if (!list.length) {
    container.innerHTML = '<div class="appt-empty"><h3>Заявок пока нет</h3><p>Здесь появятся заявки клиентов на сервис.</p></div>';
    return;
  }
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
