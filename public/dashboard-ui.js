const stageColors = {
  new: '#6366f1', contacted: '#3b82f6', negotiation: '#f59e0b',
  proposal: '#8b5cf6', won: '#10b981', lost: '#ef4444',
};
const stageNames = {
  new: 'Новый', contacted: 'Связались', negotiation: 'Переговоры',
  proposal: 'Предложение', won: 'Выигран', lost: 'Проигран',
};

export function initDashboard(container, api) {
  let currentPeriod = 'all';

  async function load(period) {
    if (period !== undefined) currentPeriod = period;
    const data = await api('/api/dashboard?period=' + currentPeriod);
    render(data);
  }

  function fmt(n) {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n || 0);
  }
  function num(n) { return new Intl.NumberFormat('ru-RU').format(n || 0); }
  function shortFmt(n) {
    if (!n) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return num(n);
  }

  function render(data) {
    const o = data.overview;
    const maxFunnel = Math.max(...data.dealsByStage.map(s => s.count), 1);
    const maxMonth = Math.max(...data.dealsByMonth.map(m => m.count), 1);

    const wonPct = o.wonRate;
    const circumference = 2 * Math.PI * 42;
    const strokeDash = (wonPct / 100) * circumference;

    container.innerHTML = `
      <div class="dashboard">
        <div class="dash-header">
          <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" id="global-search" placeholder="Поиск клиентов, автомобилей, сделок..." />
            <div class="search-results" id="search-results"></div>
          </div>
          <div class="period-tabs" id="period-tabs">
            <button data-period="7d" class="${currentPeriod === '7d' ? 'active' : ''}">7 дн.</button>
            <button data-period="30d" class="${currentPeriod === '30d' ? 'active' : ''}">30 дн.</button>
            <button data-period="90d" class="${currentPeriod === '90d' ? 'active' : ''}">90 дн.</button>
            <button data-period="365d" class="${currentPeriod === '365d' ? 'active' : ''}">Год</button>
            <button data-period="all" class="${currentPeriod === 'all' ? 'active' : ''}">Все</button>
          </div>
        </div>

        <div class="dash-grid">
          <div class="dash-card">
            <div class="dash-icon">👥</div>
            <div class="dash-value">${num(o.totalClients)}</div>
            <div class="dash-label">Клиенты</div>
          </div>
          <div class="dash-card">
            <div class="dash-icon">🚗</div>
            <div class="dash-value">${num(o.totalVehicles)}</div>
            <div class="dash-label">Автомобили</div>
          </div>
          <div class="dash-card">
            <div class="dash-icon">📊</div>
            <div class="dash-value">${num(o.activeDeals)}</div>
            <div class="dash-label">Активные сделки</div>
          </div>
          <div class="dash-card dash-card-accent">
            <div class="dash-icon">💰</div>
            <div class="dash-value">${shortFmt(o.totalRevenue)} ₽</div>
            <div class="dash-label">Выручка</div>
          </div>
          <div class="dash-card">
            <div class="dash-icon">📈</div>
            <div class="dash-value">${shortFmt(o.pipelineValue)} ₽</div>
            <div class="dash-label">В воронке</div>
          </div>
          <div class="dash-card">
            <div class="dash-icon">📋</div>
            <div class="dash-value">${num(o.activeAppointments)}</div>
            <div class="dash-label">Активные заявки</div>
          </div>
          <div class="dash-card">
            <div class="dash-icon">🔄</div>
            <div class="dash-value">+${num(o.dealsThisMonth)}</div>
            <div class="dash-label">Сделок за месяц</div>
          </div>
          <div class="dash-card">
            <div class="dash-icon">✅</div>
            <div class="dash-value">${o.wonRate}%</div>
            <div class="dash-label">Конверсия</div>
          </div>
        </div>

        <div class="dash-charts">
          <div class="dash-chart">
            <h4>📊 Воронка сделок</h4>
            ${data.dealsByStage.map(s => `
              <div class="funnel-bar">
                <div class="bar-label">${stageNames[s.stage] || s.stage}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max((s.count / maxFunnel) * 100, 2)}%;background:${stageColors[s.stage] || '#64748b'}">${s.count}</div></div>
                <div class="bar-value">${fmt(s.total)}</div>
              </div>
            `).join('')}
          </div>

          <div class="dash-chart">
            <h4>🎯 Конверсия</h4>
            <div class="conversion-ring">
              <svg viewBox="0 0 100 100" class="ring-svg">
                <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8" />
                <circle cx="50" cy="50" r="42" fill="none" stroke="#10b981" stroke-width="8"
                  stroke-dasharray="${strokeDash} ${circumference}" stroke-dashoffset="0"
                  stroke-linecap="round" transform="rotate(-90 50 50)"
                  class="ring-progress" />
                <text x="50" y="46" text-anchor="middle" fill="var(--accent)" font-size="18" font-weight="700">${wonPct}%</text>
                <text x="50" y="60" text-anchor="middle" fill="var(--muted)" font-size="6">конверсия</text>
              </svg>
              <div class="ring-legend">
                <div class="ring-legend-item"><span class="ring-dot" style="background:#10b981"></span> Выиграно: ${num(o.wonDeals)}</div>
                <div class="ring-legend-item"><span class="ring-dot" style="background:#ef4444"></span> Проиграно: ${num(o.lostDeals)}</div>
                <div class="ring-legend-item"><span class="ring-dot" style="background:#6366f1"></span> В работе: ${num(o.activeDeals)}</div>
              </div>
            </div>
          </div>

          <div class="dash-chart">
            <h4>📅 Сделки по месяцам</h4>
            <div class="bar-chart">
              ${data.dealsByMonth.map(m => `
                <div class="bar-col">
                  <div class="bar-amount">${shortFmt(m.total)}</div>
                  <div class="bar" style="height:${Math.max((m.count / maxMonth) * 140, 4)}px"></div>
                  <div class="bar-count">${m.count}</div>
                  <div class="bar-month">${formatMonth(m.month)}</div>
                </div>
              `).join('') || '<p style="color:var(--muted);font-size:.8rem">Нет данных</p>'}
            </div>
          </div>

          <div class="dash-chart">
            <h4>💰 Выручка по месяцам</h4>
            ${renderRevenueTrend(data.revenueByMonth || [])}
          </div>

          <div class="dash-chart recent-deals">
            <h4>🕐 Последние сделки</h4>
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
            <h4>🚘 Автомобили по маркам</h4>
            ${data.vehiclesByBrand.map(b => `
              <div class="funnel-bar">
                <div class="bar-label">${esc(b.brand)}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max((b.count / Math.max(...data.vehiclesByBrand.map(x => x.count), 1)) * 100, 4)}%;background:var(--accent)">${b.count}</div></div>
              </div>
            `).join('') || '<p style="color:var(--muted);font-size:.8rem">Нет данных</p>'}
          </div>

          ${data.managerStats.length ? `
          <div class="dash-chart manager-stats">
            <h4>👔 Менеджеры</h4>
            <table>
              <thead><tr><th>Имя</th><th>Сделок</th><th>Выиграно</th></tr></thead>
              <tbody>${data.managerStats.map(m => `
                <tr><td>${esc(m.name)}</td><td>${m.deals_count}</td><td>${fmt(m.won_total)}</td></tr>
              `).join('')}</tbody>
            </table>
          </div>` : ''}
        </div>
      </div>`;

    container.querySelector('#period-tabs').onclick = (e) => {
      const btn = e.target.closest('button[data-period]');
      if (!btn) return;
      load(btn.dataset.period);
    };

    initSearch(container, api);
  }

  function formatMonth(ym) {
    if (!ym) return '';
    const months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    const [y, m] = ym.split('-');
    return months[parseInt(m, 10) - 1] || m;
  }

  function renderRevenueTrend(months) {
    if (!months.length) return '<p style="color:var(--muted);font-size:.8rem">Нет данных</p>';
    const max = Math.max(...months.map(m => m.total), 1);
    const points = months.map((m, i) => {
      const x = months.length > 1 ? (i / (months.length - 1)) * 280 + 10 : 150;
      const y = 130 - (m.total / max) * 110;
      return `${x},${y}`;
    });
    const polyline = points.join(' ');
    const areaPoints = `10,130 ${polyline} ${280 + 10},130`;

    return `
      <div class="revenue-chart">
        <svg viewBox="0 0 300 160" class="revenue-svg">
          <defs>
            <linearGradient id="rev-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.3" />
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <polygon points="${areaPoints}" fill="url(#rev-grad)" />
          <polyline points="${polyline}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
          ${months.map((m, i) => {
            const x = months.length > 1 ? (i / (months.length - 1)) * 280 + 10 : 150;
            const y = 130 - (m.total / max) * 110;
            return `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5" />`;
          }).join('')}
        </svg>
        <div class="revenue-labels">
          ${months.map(m => `<span>${formatMonth(m.month)}</span>`).join('')}
        </div>
        <div class="revenue-total">
          Итого: ${fmt(months.reduce((s, m) => s + m.total, 0))}
        </div>
      </div>`;
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
