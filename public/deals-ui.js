export function initDeals(container, api) {
  let board = {};
  let stages = [];
  let clients = [];
  let managers = [];
  let vehicles = [];
  let editingDeal = null;
  let draggedCard = null;

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

  function relativeDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = Math.floor((now - d) / 86400000);
    if (diff === 0) return 'сегодня';
    if (diff === 1) return 'вчера';
    if (diff < 7) return diff + ' дн. назад';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.ceil((d - now) / 86400000);
  }

  function render() {
    const totalActive = stages
      .filter(s => !['won', 'lost'].includes(s.id))
      .reduce((sum, s) => sum + (board[s.id] || []).length, 0);
    const totalAmount = Object.values(board).flat()
      .filter(d => !['won', 'lost'].includes(d.stage))
      .reduce((sum, d) => sum + (d.amount || 0), 0);

    container.innerHTML = `
      <div class="deals-toolbar">
        <div class="deals-stats">
          <div class="deals-stat"><span class="deals-stat-value">${totalActive}</span><span class="deals-stat-label">активных</span></div>
          <div class="deals-stat"><span class="deals-stat-value">${formatAmount(totalAmount)}</span><span class="deals-stat-label">в воронке</span></div>
        </div>
        <div class="deals-actions">
          <div class="deals-search">
            <span class="deals-search-icon">⌕</span>
            <input type="text" id="deal-search" placeholder="Поиск сделок..." />
          </div>
          <button class="primary" id="deal-add-btn">＋ Новая сделка</button>
        </div>
      </div>
      <div class="kanban-board" id="kanban-board">
        ${stages.map(s => {
          const cards = board[s.id] || [];
          const stageTotal = cards.reduce((sum, d) => sum + (d.amount || 0), 0);
          return `
          <div class="kanban-column" data-stage="${s.id}">
            <div class="kanban-column-header">
              <div class="kanban-header-left">
                <span class="kanban-stage-dot" style="background:${s.color}"></span>
                <span class="kanban-stage-name">${s.name}</span>
                <span class="kanban-count">${cards.length}</span>
              </div>
              <span class="kanban-stage-total">${stageTotal ? formatAmount(stageTotal) : ''}</span>
            </div>
            <div class="kanban-cards" data-stage="${s.id}">
              ${cards.map(d => cardHtml(d)).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>`;

    container.querySelector('#deal-add-btn').onclick = () => showModal();

    container.querySelectorAll('.kanban-card').forEach(el => {
      el.onclick = (e) => {
        if (el.classList.contains('dragging')) return;
        const id = el.dataset.id;
        const deal = Object.values(board).flat().find(d => d.id === id);
        if (deal) showModal(deal);
      };
      el.draggable = true;
      el.addEventListener('dragstart', onDragStart);
      el.addEventListener('dragend', onDragEnd);
    });

    container.querySelectorAll('.kanban-cards').forEach(zone => {
      zone.addEventListener('dragover', onDragOver);
      zone.addEventListener('dragenter', onDragEnter);
      zone.addEventListener('dragleave', onDragLeave);
      zone.addEventListener('drop', onDrop);
    });

    const search = container.querySelector('#deal-search');
    search.oninput = () => applyFilters(search.value);
  }

  function cardHtml(d) {
    const priorityClass = 'p' + (d.priority || 0);
    const daysLeft = daysUntil(d.expected_close);
    let deadlineClass = '';
    if (daysLeft !== null) {
      if (daysLeft < 0) deadlineClass = 'overdue';
      else if (daysLeft <= 3) deadlineClass = 'soon';
    }

    return `<div class="kanban-card" data-id="${d.id}" draggable="true">
      <div class="card-top">
        <span class="deal-priority ${priorityClass}" title="${['Обычный','Высокий','Срочный'][d.priority || 0]}"></span>
        <span class="card-date">${relativeDate(d.updated_at)}</span>
      </div>
      <div class="card-title">${esc(d.title)}</div>
      ${d.client_name ? `<div class="card-client">👤 ${esc(d.client_name)}</div>` : ''}
      <div class="card-bottom">
        <span class="card-amount">${formatAmount(d.amount)}</span>
        ${d.expected_close ? `<span class="card-deadline ${deadlineClass}" title="Закрытие: ${d.expected_close}">${daysLeft !== null && daysLeft < 0 ? 'просрочено' : d.expected_close}</span>` : ''}
      </div>
      ${d.manager_name ? `<div class="card-manager">${esc(d.manager_name)}</div>` : ''}
    </div>`;
  }

  // Drag and drop
  function onDragStart(e) {
    draggedCard = e.target.closest('.kanban-card');
    if (!draggedCard) return;
    draggedCard.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedCard.dataset.id);
    requestAnimationFrame(() => {
      container.querySelectorAll('.kanban-cards').forEach(zone => {
        if (zone.dataset.stage !== draggedCard.closest('.kanban-column').dataset.stage) {
          zone.closest('.kanban-column').classList.add('drop-target-column');
        }
      });
    });
  }

  function onDragEnd(e) {
    if (draggedCard) draggedCard.classList.remove('dragging');
    draggedCard = null;
    container.querySelectorAll('.kanban-column').forEach(col => {
      col.classList.remove('drop-target-column', 'drag-over');
    });
    container.querySelectorAll('.kanban-cards').forEach(zone => {
      zone.classList.remove('drag-over');
    });
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  function onDragEnter(e) {
    e.preventDefault();
    const zone = e.currentTarget;
    zone.classList.add('drag-over');
    zone.closest('.kanban-column').classList.add('drag-over');
  }

  function onDragLeave(e) {
    const zone = e.currentTarget;
    if (!zone.contains(e.relatedTarget)) {
      zone.classList.remove('drag-over');
      zone.closest('.kanban-column').classList.remove('drag-over');
    }
  }

  async function onDrop(e) {
    e.preventDefault();
    const zone = e.currentTarget;
    zone.classList.remove('drag-over');
    zone.closest('.kanban-column').classList.remove('drag-over');
    const dealId = e.dataTransfer.getData('text/plain');
    const newStage = zone.dataset.stage;
    if (!dealId || !newStage) return;

    const deal = Object.values(board).flat().find(d => d.id === dealId);
    if (!deal || deal.stage === newStage) return;

    const oldStage = deal.stage;
    // Optimistic update
    board[oldStage] = (board[oldStage] || []).filter(d => d.id !== dealId);
    deal.stage = newStage;
    board[newStage] = board[newStage] || [];
    board[newStage].push(deal);
    render();

    try {
      await api('/api/deals/' + dealId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: newStage }),
      });
    } catch {
      deal.stage = oldStage;
      board[newStage] = (board[newStage] || []).filter(d => d.id !== dealId);
      board[oldStage] = board[oldStage] || [];
      board[oldStage].push(deal);
      render();
    }
  }

  function applyFilters(query) {
    const q = query.toLowerCase();
    container.querySelectorAll('.kanban-card').forEach(card => {
      const id = card.dataset.id;
      const deal = Object.values(board).flat().find(d => d.id === id);
      if (!deal) return;
      const match = !q || deal.title.toLowerCase().includes(q) ||
        (deal.client_name || '').toLowerCase().includes(q) ||
        (deal.description || '').toLowerCase().includes(q) ||
        (deal.manager_name || '').toLowerCase().includes(q);
      card.style.display = match ? '' : 'none';
    });
  }

  function showModal(deal) {
    editingDeal = deal || null;
    const overlay = document.createElement('div');
    overlay.className = 'deal-modal-overlay';
    overlay.innerHTML = `<div class="deal-modal">
      <div class="deal-modal-header">
        <h3>${deal ? 'Редактировать сделку' : 'Новая сделка'}</h3>
        <button class="deal-modal-close" id="dm-close">×</button>
      </div>
      <div class="deal-modal-body">
        <div class="deal-form-grid">
          <label class="deal-field full">
            <span>Название *</span>
            <input id="dm-title" value="${esc(deal?.title || '')}" placeholder="Например: Zeekr 001 для Иванова" />
          </label>
          <label class="deal-field">
            <span>Стадия</span>
            <select id="dm-stage">${stages.map(s => `<option value="${s.id}" ${deal?.stage === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
          </label>
          <label class="deal-field">
            <span>Сумма, ₽</span>
            <input id="dm-amount" type="number" value="${deal?.amount || 0}" min="0" />
          </label>
          <label class="deal-field">
            <span>Клиент</span>
            <select id="dm-client"><option value="">— Без клиента —</option>${clients.map(c => `<option value="${c.id}" ${deal?.client_id === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.email)})</option>`).join('')}</select>
          </label>
          <label class="deal-field">
            <span>Менеджер</span>
            <select id="dm-manager"><option value="">— Без менеджера —</option>${managers.map(m => `<option value="${m.id}" ${deal?.manager_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
          </label>
          <label class="deal-field">
            <span>Источник</span>
            <input id="dm-source" value="${esc(deal?.source || '')}" placeholder="Сайт, звонок, рекомендация" />
          </label>
          <label class="deal-field">
            <span>Приоритет</span>
            <select id="dm-priority"><option value="0" ${deal?.priority === 0 ? 'selected' : ''}>Обычный</option><option value="1" ${deal?.priority === 1 ? 'selected' : ''}>Высокий</option><option value="2" ${deal?.priority === 2 ? 'selected' : ''}>Срочный</option></select>
          </label>
          <label class="deal-field">
            <span>Закрытие</span>
            <input id="dm-close" type="date" value="${deal?.expected_close || ''}" />
          </label>
          <label class="deal-field full">
            <span>Описание</span>
            <textarea id="dm-desc" placeholder="Подробности сделки, требования клиента...">${esc(deal?.description || '')}</textarea>
          </label>
        </div>
        ${deal ? `<div class="deal-history" id="dm-history"><div class="deal-history-loading">Загрузка истории...</div></div>` : ''}
      </div>
      <div class="deal-modal-footer">
        ${deal ? '<button class="danger" id="dm-delete">Удалить</button>' : '<span></span>'}
        <div class="deal-modal-actions">
          <button id="dm-cancel">Отмена</button>
          <button class="primary" id="dm-save">Сохранить</button>
        </div>
      </div>
    </div>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));

    const close = () => {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 200);
    };

    overlay.querySelector('#dm-close').onclick = close;
    overlay.querySelector('#dm-cancel').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.querySelector('#dm-save').onclick = () => saveDeal(overlay, close);

    if (deal) {
      const delBtn = overlay.querySelector('#dm-delete');
      if (delBtn) delBtn.onclick = () => deleteDeal(deal.id, close);
      loadHistory(deal.id, overlay.querySelector('#dm-history'));
    }

    overlay.querySelector('#dm-title').focus();
  }

  async function loadHistory(id, el) {
    if (!el) return;
    const deal = await api('/api/deals/' + id);
    if (!deal.history?.length) {
      el.innerHTML = '<p class="deal-history-empty">Нет истории изменений</p>';
      return;
    }
    el.innerHTML = '<div class="deal-history-title">История изменений</div>' + deal.history.map(h =>
      `<div class="deal-history-item">
        <span class="deal-history-field">${esc(h.field)}</span>
        <span class="deal-history-change">${esc(h.old_value || '—')} → ${esc(h.new_value || '—')}</span>
        <span class="deal-history-meta">${esc(h.actor)} · ${new Date(h.created_at).toLocaleString('ru-RU')}</span>
      </div>`
    ).join('');
  }

  async function saveDeal(overlay, close) {
    const saveBtn = overlay.querySelector('#dm-save');
    saveBtn.disabled = true;
    try {
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
      close();
      await load();
    } catch (e) {
      saveBtn.disabled = false;
    }
  }

  async function deleteDeal(id, close) {
    if (!confirm('Удалить сделку?')) return;
    await api('/api/deals/' + id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    close();
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
