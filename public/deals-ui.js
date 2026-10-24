export function initDeals(container, api) {
  let board = {};
  let stages = [];
  let clients = [];
  let managers = [];
  let vehicles = [];
  let editingDeal = null;

  async function load() {
    const [kanbanRes, stateRes] = await Promise.all([
      api('/api/deals/kanban'),
      api('/api/state'),
    ]);
    board = kanbanRes.board;
    stages = kanbanRes.stages;
    clients = stateRes.clients || [];
    managers = stateRes.managers || [];
    vehicles = stateRes.vehicles || [];
    render();
  }

  function formatAmount(n) {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n || 0);
  }

  function render() {
    container.innerHTML = `
      <div class="deals-filters">
        <input type="text" id="deal-search" placeholder="Поиск сделок..." />
        <select id="deal-filter-stage"><option value="">Все стадии</option>${stages.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
        <button class="btn btn-primary" id="deal-add-btn">+ Новая сделка</button>
      </div>
      <div class="kanban-board" id="kanban-board">
        ${stages.map(s => `
          <div class="kanban-column" data-stage="${s.id}">
            <div class="kanban-column-header" style="background:${s.color}">
              <span>${s.name}</span>
              <span class="count">${(board[s.id] || []).length}</span>
            </div>
            <div class="kanban-cards" data-stage="${s.id}">
              ${(board[s.id] || []).map(d => cardHtml(d)).join('')}
            </div>
          </div>
        `).join('')}
      </div>`;
    container.querySelector('#deal-add-btn').onclick = () => showModal();
    container.querySelectorAll('.kanban-card').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.id;
        const deal = Object.values(board).flat().find(d => d.id === id);
        if (deal) showModal(deal);
      };
    });
    const search = container.querySelector('#deal-search');
    const filter = container.querySelector('#deal-filter-stage');
    search.oninput = filter.onchange = () => applyFilters(search.value, filter.value);
  }

  function cardHtml(d) {
    const priorityClass = 'p' + (d.priority || 0);
    return `<div class="kanban-card" data-id="${d.id}">
      <div class="deal-title"><span class="deal-priority ${priorityClass}"></span>${esc(d.title)}</div>
      ${d.client_name ? `<div class="deal-client">${esc(d.client_name)}</div>` : ''}
      <div class="deal-amount">${formatAmount(d.amount)}</div>
    </div>`;
  }

  function applyFilters(query, stage) {
    const q = query.toLowerCase();
    container.querySelectorAll('.kanban-column').forEach(col => {
      if (stage && col.dataset.stage !== stage) { col.style.display = 'none'; return; }
      col.style.display = '';
      col.querySelectorAll('.kanban-card').forEach(card => {
        const id = card.dataset.id;
        const deal = Object.values(board).flat().find(d => d.id === id);
        if (!deal) return;
        const match = !q || deal.title.toLowerCase().includes(q) ||
          (deal.client_name || '').toLowerCase().includes(q) ||
          (deal.description || '').toLowerCase().includes(q);
        card.style.display = match ? '' : 'none';
      });
    });
  }

  function showModal(deal) {
    editingDeal = deal || null;
    const overlay = document.createElement('div');
    overlay.className = 'deal-modal-overlay';
    overlay.innerHTML = `<div class="deal-modal">
      <h3>${deal ? 'Редактировать сделку' : 'Новая сделка'}</h3>
      <label>Название *</label>
      <input id="dm-title" value="${esc(deal?.title || '')}" />
      <label>Стадия</label>
      <select id="dm-stage">${stages.map(s => `<option value="${s.id}" ${deal?.stage === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
      <label>Сумма</label>
      <input id="dm-amount" type="number" value="${deal?.amount || 0}" min="0" />
      <label>Клиент</label>
      <select id="dm-client"><option value="">— Без клиента —</option>${clients.map(c => `<option value="${c.id}" ${deal?.client_id === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.email)})</option>`).join('')}</select>
      <label>Менеджер</label>
      <select id="dm-manager"><option value="">— Без менеджера —</option>${managers.map(m => `<option value="${m.id}" ${deal?.manager_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <label>Источник</label>
      <input id="dm-source" value="${esc(deal?.source || '')}" placeholder="Сайт, звонок, рекомендация..." />
      <label>Приоритет</label>
      <select id="dm-priority"><option value="0" ${deal?.priority === 0 ? 'selected' : ''}>Обычный</option><option value="1" ${deal?.priority === 1 ? 'selected' : ''}>Высокий</option><option value="2" ${deal?.priority === 2 ? 'selected' : ''}>Срочный</option></select>
      <label>Ожидаемое закрытие</label>
      <input id="dm-close" type="date" value="${deal?.expected_close || ''}" />
      <label>Описание</label>
      <textarea id="dm-desc">${esc(deal?.description || '')}</textarea>
      ${deal ? `<div class="deal-history" id="dm-history"></div>` : ''}
      <div class="deal-actions">
        ${deal ? '<button class="btn btn-danger" id="dm-delete">Удалить</button>' : ''}
        <button class="btn" id="dm-cancel">Отмена</button>
        <button class="btn btn-primary" id="dm-save">Сохранить</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#dm-cancel').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('#dm-save').onclick = () => saveDeal(overlay);
    if (deal) {
      const delBtn = overlay.querySelector('#dm-delete');
      if (delBtn) delBtn.onclick = () => deleteDeal(deal.id, overlay);
      loadHistory(deal.id, overlay.querySelector('#dm-history'));
    }
  }

  async function loadHistory(id, el) {
    if (!el) return;
    const deal = await api('/api/deals/' + id);
    if (!deal.history?.length) { el.innerHTML = '<p style="color:var(--muted)">Нет истории</p>'; return; }
    el.innerHTML = '<strong>История изменений:</strong>' + deal.history.map(h =>
      `<div class="deal-history-item"><span class="field">${esc(h.field)}</span>: ${esc(h.old_value || '—')} → ${esc(h.new_value || '—')} <span style="color:var(--muted)">(${esc(h.actor)}, ${new Date(h.created_at).toLocaleString('ru-RU')})</span></div>`
    ).join('');
  }

  async function saveDeal(overlay) {
    const body = {
      title: overlay.querySelector('#dm-title').value,
      stage: overlay.querySelector('#dm-stage').value,
      amount: Number(overlay.querySelector('#dm-amount').value),
      client_id: overlay.querySelector('#dm-client').value || null,
      manager_id: overlay.querySelector('#dm-manager').value || null,
      source: overlay.querySelector('#dm-source').value,
      priority: Number(overlay.querySelector('#dm-priority').value),
      expected_close: overlay.querySelector('#dm-close').value || null,
      description: overlay.querySelector('#dm-desc').value,
    };
    const url = editingDeal ? '/api/deals/' + editingDeal.id : '/api/deals';
    await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    overlay.remove();
    await load();
  }

  async function deleteDeal(id, overlay) {
    if (!confirm('Удалить сделку?')) return;
    await api('/api/deals/' + id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    overlay.remove();
    await load();
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  load();
  return { reload: load };
}
