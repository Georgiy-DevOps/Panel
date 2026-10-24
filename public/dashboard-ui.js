const stageColors = {
  new: '#6366f1', contacted: '#3b82f6', negotiation: '#f59e0b',
  proposal: '#8b5cf6', won: '#10b981', lost: '#ef4444',
};
const stageNames = {
  new: 'Новый', contacted: 'Связались', negotiation: 'Переговоры',
  proposal: 'Предложение', won: 'Выигран', lost: 'Проигран',
};

export function initDashboard(container, api) {
  async function load() {
    const data = await api('/api/dashboard');
    render(data);
  }

  function fmt(n) {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n || 0);
  }
  function num(n) { return new Intl.NumberFormat('ru-RU').format(n || 0); }

  function render(data) {
    const o = data.overview;
    const maxFunnel = Math.max(...data.dealsByStage.map(s => s.count), 1);
    const maxMonth = Math.max(...data.dealsByMonth.map(m => m.count), 1);

    container.innerHTML = `
      <div class="dashboard">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input type="text" id="global-search" placeholder="Поиск клиентов, автомобилей, сделок..." />
          <div class="search-results" id="search-results"></div>
        </div>
        <div class="dash-grid">
          <div class="dash-card"><div class="dash-value">${num(o.totalClients)}</div><div class="dash-label">Клиенты</div></div>
          <div class="dash-card"><div class="dash-value">${num(o.totalVehicles)}</div><div class="dash-label">Автомобили</div></div>
          <div class="dash-card"><div class="dash-value">${num(o.activeDeals)}</div><div class="dash-label">Активные сделки</div></div>
          <div class="dash-card"><div class="dash-value">${o.wonRate}%</div><div class="dash-label">Конверсия</div></div>
          <div class="dash-card"><div class="dash-value">${fmt(o.totalRevenue)}</div><div class="dash-label">Выручка</div></div>
          <div class="dash-card"><div class="dash-value">${fmt(o.pipelineValue)}</div><div class="dash-label">В воронке</div></div>
          <div class="dash-card"><div class="dash-value">${num(o.activeAppointments)}</div><div class="dash-label">Активные заявки</div></div>
          <div class="dash-card"><div class="dash-value">+${num(o.dealsThisMonth)}</div><div class="dash-label">Сделок за месяц</div></div>
        </div>
        <div class="dash-charts">
          <div class="dash-chart">
            <h4>Воронка сделок</h4>
            ${data.dealsByStage.map(s => `
              <div class="funnel-bar">
                <div class="bar-label">${stageNames[s.stage] || s.stage}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max((s.count / maxFunnel) * 100, 2)}%;background:${stageColors[s.stage] || '#64748b'}">${s.count}</div></div>
                <div class="bar-value">${fmt(s.total)}</div>
              </div>
            `).join('')}
          </div>
          <div class="dash-chart">
            <h4>Сделки по месяцам</h4>
            <div class="bar-chart">
              ${data.dealsByMonth.map(m => `
                <div class="bar-col">
                  <div class="bar" style="height:${Math.max((m.count / maxMonth) * 140, 4)}px"></div>
                  <div class="bar-month">${m.month}</div>
                </div>
              `).join('') || '<p style="color:var(--muted);font-size:.8rem">Нет данных</p>'}
            </div>
          </div>
          <div class="dash-chart recent-deals">
            <h4>Последние сделки</h4>
            <table>
              <thead><tr><th>Сделка</th><th>Клиент</th><th>Стадия</th><th>Сумма</th></tr></thead>
              <tbody>${data.recentDeals.map(d => `
                <tr>
                  <td>${esc(d.title)}</td>
                  <td>${esc(d.client_name || '—')}</td>
                  <td><span class="stage-badge" style="background:${stageColors[d.stage] || '#64748b'}">${stageNames[d.stage] || d.stage}</span></td>
                  <td>${fmt(d.amount)}</td>
                </tr>
              `).join('') || '<tr><td colspan="4" style="color:var(--muted)">Нет сделок</td></tr>'}</tbody>
            </table>
          </div>
          <div class="dash-chart">
            <h4>Автомобили по маркам</h4>
            ${data.vehiclesByBrand.map(b => `
              <div class="funnel-bar">
                <div class="bar-label">${esc(b.brand)}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max((b.count / Math.max(...data.vehiclesByBrand.map(x => x.count), 1)) * 100, 4)}%;background:var(--accent)">${b.count}</div></div>
              </div>
            `).join('') || '<p style="color:var(--muted);font-size:.8rem">Нет данных</p>'}
          </div>
          ${data.managerStats.length ? `
          <div class="dash-chart manager-stats">
            <h4>Менеджеры</h4>
            <table>
              <thead><tr><th>Имя</th><th>Сделок</th><th>Выиграно</th></tr></thead>
              <tbody>${data.managerStats.map(m => `
                <tr><td>${esc(m.name)}</td><td>${m.deals_count}</td><td>${fmt(m.won_total)}</td></tr>
              `).join('')}</tbody>
            </table>
          </div>` : ''}
        </div>
      </div>`;

    initSearch(container, api);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  load();
  return { reload: load };
}

function initSearch(container, api) {
  const input = container.querySelector('#global-search');
  const results = container.querySelector('#search-results');
  if (!input || !results) return;
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.classList.remove('active'); return; }
    timer = setTimeout(async () => {
      const data = await api('/api/search?q=' + encodeURIComponent(q));
      renderResults(data, results);
    }, 300);
  };
  input.onblur = () => setTimeout(() => results.classList.remove('active'), 200);
  input.onfocus = () => { if (results.innerHTML) results.classList.add('active'); };
}

function renderResults(data, el) {
  const sections = [];
  if (data.clients.length) sections.push(group('Клиенты', data.clients.map(c => `${c.name} — ${c.email}`)));
  if (data.vehicles.length) sections.push(group('Автомобили', data.vehicles.map(v => `${v.vin} — ${v.brand} ${v.model}`)));
  if (data.deals.length) sections.push(group('Сделки', data.deals.map(d => d.title)));
  if (!sections.length) { el.innerHTML = '<div class="search-group"><div class="search-item">Ничего не найдено</div></div>'; }
  else el.innerHTML = sections.join('');
  el.classList.add('active');
}

function group(title, items) {
  return `<div class="search-group"><div class="search-group-title">${title}</div>${items.map(i => `<div class="search-item">${i}</div>`).join('')}</div>`;
}
