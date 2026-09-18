import { statuses, transitions, activeStatuses, moscowDate } from './service-catalog.js';
import { appointmentCard, serviceName, preferred } from './appointments-ui.js';
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
let state = { vehicles: [], clients: [], events: [], bytedepp: { devices: [] } },
  view = 'vehicles',
  brandFilter = 'all',
  selectedId = null,
  refreshing = false;
const states = {
  pending: 'Ожидает проверки',
  linked: 'Связан',
  unavailable: 'Источник недоступен',
  missing: 'Устройство не найдено',
  mismatch: 'Не совпадает VIN',
};
const fmt = (t) =>
  t
    ? new Date(t).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const empty = (title, text) =>
  `<div class="empty-symbol" aria-hidden="true">▦</div><h2>${title}</h2><p>${text}</p>`;
const badge = (v) =>
  `<span class="pill ${v ? 'ready' : ''}">${v ? 'Активен' : 'Не активен'}</span>`;
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($('#toast').hidden = true), 4500);
}
async function api(path, body) {
  const r = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await r.json();
  if (!r.ok) {
    if (r.status === 401 && path !== '/login') showLogin();
    throw new Error(result.error || 'Ошибка запроса');
  }
  return result;
}
function showLogin() {
  $('#modal').close();
  $('#app').hidden = true;
  $('#login-view').hidden = false;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api('/state');
    $('#app').hidden = false;
    $('#login-view').hidden = true;
    $('#connection-error').hidden = true;
    $('#server-status').textContent = state.bytedepp.connected
      ? '● ByteDepp подключён'
      : 'ByteDepp недоступен';
    $('#last-refresh').textContent = 'Синхронизация ' + new Date().toLocaleTimeString('ru-RU');
    render();
  } catch (e) {
    if (!$('#app').hidden) {
      $('#connection-error').hidden = false;
      $('#server-status').textContent = 'Нет связи с сервером';
    }
  } finally {
    refreshing = false;
  }
}
function render() {
  $('#stat-total').textContent = state.vehicles.length;
  $('#nav-count').textContent = state.vehicles.length;
  $('#stat-linked').textContent = state.vehicles.filter((v) => v.link_status === 'linked').length;
  $('#stat-pending').textContent = state.vehicles.filter((v) => v.link_status !== 'linked').length;
  $('#stat-clients').textContent = state.clients.length;
  renderVehicles();
  renderAppointments();
  $('#integration-title').textContent = state.bytedepp.connected
    ? 'ByteDepp подключён'
    : 'ByteDepp недоступен';
  $('#integration-note').textContent = state.bytedepp.connected
    ? 'VIN и версия системы автомобиля поступают от приложения ByteDepp. Время изменения записи не означает, что автомобиль сейчас в сети.'
    : state.bytedepp.error;
  $('#device-rows').innerHTML = state.bytedepp.devices
    .map(
      (d) =>
        `<tr><td class="device-id">${esc(d.device_id)}</td><td><span class="vin">${esc(d.vin || 'Не передан приложением')}</span></td><td>${esc(d.vehicle_software_version || 'Не передана')}${d.vehicle_software_reported_at ? '<span class="vin">Получена ' + fmt(d.vehicle_software_reported_at) + '</span>' : ''}</td><td>${badge(d.language.active)}</td><td>${badge(d.store.active)}${d.store.expires_at ? '<span class="vin">До ' + fmt(d.store.expires_at) + '</span>' : ''}</td><td>${fmt(d.updated_at)}</td></tr>`,
    )
    .join('');
  $('#devices-empty').hidden = state.bytedepp.devices.length > 0;
  $('#devices-empty').innerHTML = empty(
    'Устройств пока нет',
    'Здесь появятся устройства, когда приложение ByteDepp зарегистрируется на действующем сервере.',
  );
  $('#client-rows').innerHTML = state.clients
    .map(
      (c) =>
        `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${state.vehicles.filter((v) => v.client_id === c.id).length}</td><td>${fmt(c.created_at)}</td></tr>`,
    )
    .join('');
  $('#clients-empty').hidden = state.clients.length > 0;
  $('#clients-empty').innerHTML = empty(
    'Клиентов пока нет',
    'Клиенты создают свои учётные записи через отдельный личный кабинет.',
  );
  $('#event-list').innerHTML = state.events.length
    ? state.events
        .map(
          (e) =>
            `<div class="event"><time>${fmt(e.created_at)}</time><div>${esc(e.action)}<small>${esc(e.target)} · ${e.actor === 'admin' ? 'Администратор' : e.actor === 'client' ? 'Клиент' : 'Система'}</small></div></div>`,
        )
        .join('')
    : '<div class="event">Журнал пуст</div>';
}
function renderVehicles() {
  const q = $('#search').value.trim().toLowerCase(),
    vehicles = state.vehicles.filter(
      (v) =>
        (brandFilter === 'all' || v.brand === brandFilter) &&
        `${v.vin} ${v.model} ${v.client_name} ${v.client_email}`.toLowerCase().includes(q),
    );
  $('#vehicle-rows').innerHTML = vehicles
    .map(
      (v) =>
        `<tr class="${v.id === selectedId ? 'selected' : ''}"><td><span class="vehicle-brand">${esc(v.brand)}</span><strong>${esc(v.model)}</strong><span class="vin">${esc(v.vin)}</span></td><td>${esc(v.client_name || 'Не назначен')}<span class="vin">${esc(v.client_email || '')}</span></td><td><span class="pill ${v.link_status}">${states[v.link_status]}</span></td><td><button class="row-open" data-select="${v.id}" aria-label="Открыть ${esc(v.vin)}">↗</button></td></tr>`,
    )
    .join('');
  $('#vehicle-count').textContent = `Показано ${vehicles.length} из ${state.vehicles.length}`;
  $('#vehicle-empty').hidden = vehicles.length > 0;
  $('#vehicle-empty').innerHTML = state.vehicles.length
    ? empty('Ничего не найдено', 'Измените поиск или фильтр марки.')
    : empty(
        'Добавьте первый автомобиль',
        'Укажите VIN сами или дождитесь регистрации автомобиля клиентом.',
      ) + '<button class="primary" data-add-vehicle>＋ Добавить автомобиль</button>';
  const v = state.vehicles.find((v) => v.id === selectedId);
  if (!v) {
    $('#vehicle-detail').innerHTML =
      '<p class="detail-caption">СВЯЗЬ С BYTEDEPP</p><h2>От VIN к устройству</h2><div class="steps"><div class="step"><span>1</span><p><strong>Добавьте VIN</strong>Вы или клиент регистрируете автомобиль.</p></div><div class="step"><span>2</span><p><strong>Вы проверяете связь</strong>Сопоставляете VIN с устройством ByteDepp.</p></div><div class="step"><span>3</span><p><strong>Назначьте клиента</strong>В его кабинете появятся автомобиль и статусы сервисов.</p></div></div>';
    return;
  }
  const row = (label, value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`,
    license = (l) =>
      l.active
        ? l.expires_at
          ? 'Активен до ' + fmt(l.expires_at)
          : 'Активен, бессрочно'
        : 'Не активен';
  $('#vehicle-detail').innerHTML =
    `<p class="detail-caption">КАРТОЧКА АВТОМОБИЛЯ</p><span class="vehicle-brand">${esc(v.brand)}</span><h2>${esc(v.model)}</h2><span class="vin">${esc(v.vin)}</span><dl>${row('Клиент', v.client_name || 'Не назначен')}${row('Email', v.client_email || '—')}${row('VIN из ByteDepp', v.reported_vin || 'Не передан')}${row('Версия системы авто', v.software || 'Не передана ByteDepp')}${v.software_reported_at ? row('Версия получена', fmt(v.software_reported_at)) : ''}${row('Регион', v.region || 'Не указан')}${row('Связь', states[v.link_status])}${row('Устройство', v.byte_device_id || 'Не связано')}${v.bytedepp ? row('Русский язык', license(v.bytedepp.language)) + row('Магазин', license(v.bytedepp.store)) : ''}</dl><button data-assign-client="${v.id}">${v.client_id ? 'Изменить клиента' : 'Назначить клиента'}</button><button class="primary" data-link="${v.id}" ${!state.bytedepp.connected ? 'disabled' : ''}>${v.byte_device_id ? 'Изменить связь' : 'Связать с ByteDepp'}</button>${v.byte_device_id ? `<button data-unlink="${v.id}">Снять связь</button>` : ''}<button class="danger" data-delete-vehicle="${v.id}">Удалить автомобиль</button><p class="muted">VIN из ByteDepp, версия системы и статусы сервисов поступают с сервера приложения. VIN при регистрации используется для сопоставления автомобиля.</p>`;
}
function setView(next) {
  view = next;
  const names = {
    vehicles: ['Автомобили', 'Зарегистрированные VIN и связь с устройствами ByteDepp.'],
    appointments: [
      'Запись на сервис',
      'Заявки клиентов на ТО, диагностику, настройку ByteDepp и консультацию.',
    ],
    devices: ['Устройства ByteDepp', 'Русский язык и магазин приложений на действующем сервере.'],
    clients: ['Клиенты', 'Личные кабинеты и зарегистрированные автомобили.'],
    history: ['Журнал', 'Регистрация автомобилей, сервисные заявки и связи с ByteDepp.'],
  };
  for (const key of Object.keys(names)) $('#' + key + '-view').hidden = key !== view;
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  });
  $('#page-title').textContent = names[view][0];
  $('#breadcrumb-current').textContent = names[view][0];
  $('#page-subtitle').textContent = names[view][1];
  $('#add-vehicle').hidden = view !== 'vehicles';
}
function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').showModal();
}
const formEnd = (label) =>
  `<p class="error-text" id="form-error" role="alert"></p><div class="form-actions"><button type="button" data-close>Отмена</button><button class="primary" type="submit">${label}</button></div>`;
function handleForm(action, success = 'Связь обновлена') {
  $('#modal form').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      button = form.querySelector('[type=submit]');
    button.disabled = true;
    $('#form-error').textContent = '';
    try {
      await action(Object.fromEntries(new FormData(form)));
      $('#modal').close();
      await refresh();
      toast(success);
    } catch (error) {
      $('#form-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}
const clientOptions = (selected = null) =>
  '<option value="">Без клиента — назначить позже</option>' +
  state.clients
    .map(
      (c) =>
        `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)} · ${esc(c.email)}</option>`,
    )
    .join('');
function addVehicle() {
  modal(
    'Добавить автомобиль',
    `<form><p class="form-hint">Введите VIN для регистрации автомобиля. Версия системы появится после получения данных из ByteDepp.</p><div class="form-grid"><label class="full">VIN<input name="vin" autofocus required minlength="17" maxlength="17" pattern="[A-HJ-NPR-Za-hj-npr-z0-9]{17}" title="17 латинских букв и цифр, без I, O, Q" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="17 символов"></label><label class="full">Клиент<select name="client_id" aria-label="Клиент">${clientOptions()}</select></label><label>Марка<select name="brand" aria-label="Марка"><option value="">Не указана</option><option>Zeekr</option><option>Lynk &amp; Co</option></select></label><label>Модель<input name="model" maxlength="100" placeholder="Например, 001"></label><label>Регион<input name="region" maxlength="100" placeholder="Если известен"></label></div><p class="form-hint">${state.clients.length ? 'При выборе клиента автомобиль сразу появится в его кабинете.' : 'Клиентов пока нет. Когда клиент зарегистрируется, назначьте его через карточку автомобиля.'}</p>${formEnd('Добавить автомобиль')}</form>`,
  );
  handleForm(async (b) => {
    const result = await api('/vehicles', b);
    selectedId = result.id;
    brandFilter = 'all';
    $('#search').value = '';
    document
      .querySelectorAll('[data-brand]')
      .forEach((x) => x.classList.toggle('selected', x.dataset.brand === 'all'));
  }, 'Автомобиль добавлен');
}
function assignClient(id) {
  const v = state.vehicles.find((v) => v.id === id);
  modal(
    v.client_id ? 'Изменить клиента' : 'Назначить клиента',
    `<form><div class="field-summary">VIN: <strong>${esc(v.vin)}</strong><br>Текущий клиент: ${esc(v.client_name || 'Не назначен')}${v.client_email ? ' · ' + esc(v.client_email) : ''}</div><label>Клиент<select name="client_id" aria-label="Клиент">${clientOptions(v.client_id)}</select></label><p class="form-hint">${state.clients.length ? 'Автомобиль будет виден только выбранному клиенту. При смене клиента или выборе «Без клиента» активные сервисные заявки будут отменены. Их история останется у прежнего клиента.' : 'Пока нет зарегистрированных клиентов. Клиенту нужно создать личный кабинет, затем его можно будет выбрать здесь.'}</p><label>Введите VIN для подтверждения<input name="confirm_vin" required maxlength="17" autocomplete="off"></label>${v.byte_device_id ? '<p></p><label class="checkbox-label"><input type="checkbox" name="owner_verified">Я проверил принадлежность автомобиля выбранному клиенту. Ему будут видны статусы ByteDepp.</label>' : ''}${formEnd('Сохранить')}</form>`,
  );
  handleForm(
    (b) => api(`/vehicles/${id}/client`, { ...b, owner_verified: b.owner_verified === 'on' }),
    'Клиент автомобиля обновлён',
  );
}
function linkVehicle(id) {
  const v = state.vehicles.find((v) => v.id === id),
    devices = state.bytedepp.devices.filter(
      (d) =>
        (!d.vin || d.vin === v.vin) &&
        !state.vehicles.some((other) => other.id !== id && other.byte_device_id === d.device_id),
    );
  if (!devices.length) {
    modal(
      'Нет подходящего устройства',
      `<p class="muted">В ByteDepp пока нет свободного устройства с VIN ${esc(v.vin)} или без указанного VIN. Откройте ByteDepp на автомобиле и проверьте его регистрацию на сервере.</p><div class="form-actions"><button data-close>Закрыть</button></div>`,
    );
    return;
  }
  modal(
    'Связать автомобиль с ByteDepp',
    `<form><div class="field-summary"><strong>${esc(v.client_name || 'Клиент не назначен')}</strong>${v.client_email ? '<br>' + esc(v.client_email) : ''}<br>VIN: <strong>${esc(v.vin)}</strong></div><label>Устройство ByteDepp<select name="device_id">${devices.map((d) => `<option value="${esc(d.device_id)}">${esc(d.device_id)} · ${esc(d.vin || 'VIN в приложении не указан')}</option>`).join('')}</select></label><p class="form-hint">${v.client_id ? 'После подтверждения клиент увидит статус русского языка и магазина этого устройства.' : 'Статусы сервисов появятся в карточке. Клиент увидит их после назначения автомобиля в его кабинет.'} Лицензии ByteDepp останутся прежними.</p><label>Введите VIN для подтверждения<input name="confirm_vin" required autocomplete="off" maxlength="17"></label><p></p><label class="checkbox-label"><input type="checkbox" name="owner_verified" required>Я проверил, что устройство относится к этому автомобилю${v.client_id ? ' и принадлежит указанному клиенту' : ''}.</label>${formEnd('Подтвердить связь')}</form>`,
  );
  handleForm((b) =>
    api(`/vehicles/${id}/link`, { ...b, owner_verified: b.owner_verified === 'on' }),
  );
}
function deleteVehicle(id) {
  const v = state.vehicles.find((v) => v.id === id);
  if (!v) return;
  if (state.appointments.some((a) => a.vehicle_id === id)) {
    modal(
      'Удаление недоступно',
      '<p class="muted">У автомобиля есть сервисные заявки. Он сохранён в панели, чтобы не потерять историю обслуживания.</p><div class="form-actions"><button data-close>Закрыть</button></div>',
    );
    return;
  }
  modal(
    'Удалить автомобиль',
    `<form><div class="field-summary">${esc(v.brand)} ${esc(v.model)}<br>VIN: <strong>${esc(v.vin)}</strong></div><p class="muted">Автомобиль исчезнет из панели и кабинета клиента. Связь с ByteDepp будет снята; устройство и лицензии в ByteDepp останутся без изменений. Отменить удаление нельзя. VIN можно будет зарегистрировать заново.</p><label>Введите VIN для подтверждения<input name="confirm_vin" required minlength="17" maxlength="17" autocomplete="off" spellcheck="false"></label>${formEnd('Удалить автомобиль')}</form>`,
  );
  $('#modal form button[type="submit"]').classList.add('danger');
  handleForm(async (b) => {
    await api(`/vehicles/${id}/delete`, b);
    selectedId = null;
  }, 'Автомобиль удалён');
}
function unlinkVehicle(id) {
  const v = state.vehicles.find((v) => v.id === id);
  modal(
    'Снять связь с ByteDepp',
    `<form><p class="muted">Клиент перестанет видеть статусы этого устройства. VIN сохранится в кабинете. Лицензии приложения не изменятся.</p><div class="field-summary">VIN: ${esc(v.vin)}</div><label>Повторите VIN<input name="confirm_vin" required maxlength="17"></label>${formEnd('Снять связь')}</form>`,
  );
  handleForm((b) => api(`/vehicles/${id}/unlink`, b));
}
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.currentTarget,
    button = form.querySelector('button');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/login', { password: form.password.value });
    form.reset();
    await refresh();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$('#logout').onclick = async () => {
  try {
    await api('/logout', {});
    showLogin();
  } catch (e) {
    toast(e.message);
  }
};
$('#search').oninput = renderVehicles;
$('#close-modal').onclick = () => $('#modal').close();
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.view) setView(b.dataset.view);
  if (b.dataset.brand) {
    brandFilter = b.dataset.brand;
    document
      .querySelectorAll('[data-brand]')
      .forEach((x) => x.classList.toggle('selected', x === b));
    renderVehicles();
  }
  if (b.dataset.select) {
    selectedId = b.dataset.select;
    renderVehicles();
  }
  if (b.hasAttribute('data-add-vehicle')) addVehicle();
  if (b.dataset.assignClient) assignClient(b.dataset.assignClient);
  if (b.dataset.link) linkVehicle(b.dataset.link);
  if (b.dataset.deleteVehicle) deleteVehicle(b.dataset.deleteVehicle);
  if (b.dataset.unlink) unlinkVehicle(b.dataset.unlink);
  if (b.hasAttribute('data-close')) $('#modal').close();
});
if (document.modelContext?.registerTool)
  for (const [name, description, key] of [
    ['list_vehicles', 'List registered client VINs and confirmed ByteDepp links', 'vehicles'],
    [
      'list_bytedepp_devices',
      'Read ByteDepp language and application store statuses without modifying licenses',
      'bytedepp',
    ],
  ]) {
    try {
      Promise.resolve(
        document.modelContext.registerTool({
          name,
          description,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async () => ({
            content: [{ type: 'text', text: JSON.stringify((await api('/state'))[key]) }],
          }),
        }),
      ).catch(() => {});
    } catch {
      // Browser integrations are optional; normal panel controls remain available.
    }
  }
let appointmentRenderKey = '';
function renderAppointments() {
  const items = state.appointments || [],
    filter = $('#appointment-filter').value,
    q = $('#appointment-search').value.trim().toLowerCase();
  $('#nav-appointments').textContent = items.filter((a) => a.status === 'new').length;
  $('#appointment-summary').textContent =
    `Новых: ${items.filter((a) => a.status === 'new').length} · Подтверждено: ${items.filter((a) => a.status === 'confirmed').length} · В работе: ${items.filter((a) => a.status === 'in_progress').length}`;
  const renderKey = JSON.stringify([items, filter, q]);
  if (renderKey === appointmentRenderKey) return;
  appointmentRenderKey = renderKey;
  const open = new Set(
    [...document.querySelectorAll('#admin-appointments details[open]')].map(
      (d) => d.dataset.history,
    ),
  );
  const rows = items.filter(
    (a) =>
      (filter === 'all' ||
        (filter === 'active' && activeStatuses.includes(a.status)) ||
        a.status === filter) &&
      `${a.vin} ${a.model} ${a.client_name} ${a.client_email} ${a.phone}`.toLowerCase().includes(q),
  );
  $('#admin-appointments').innerHTML = rows.length
    ? rows.map((a) => appointmentCard(a, true)).join('')
    : '<div class="appointment-empty"><h3>Заявок не найдено</h3>Клиентские заявки появятся здесь. Проверьте выбранный фильтр.</div>';
  document
    .querySelectorAll('#admin-appointments details')
    .forEach((d) => (d.open = open.has(d.dataset.history)));
}
function manageAppointment(id) {
  const a = state.appointments.find((a) => a.id === id);
  if (!a) return;
  const scheduledTime = a.scheduled_at
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Moscow',
        hour: '2-digit',
        minute: '2-digit',
      }).format(a.scheduled_at)
    : a.preferred_time;
  modal(
    'Обработка заявки',
    `<form class="appointment-form"><div class="field-summary"><strong>${esc(serviceName(a.service))} · ${esc(a.model)}</strong><br>${esc(a.vin)}<br>${esc(a.client_name)} · ${esc(a.phone)}<br>Пожелание: ${esc(preferred(a))}</div><label>Статус<select name="status">${transitions[a.status].map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${statuses[s]}</option>`).join('')}</select></label><div id="visit-fields" class="form-grid"><label>Дата визита<input type="date" name="scheduled_date" min="${moscowDate()}" max="${moscowDate(Date.now() + 180 * 86400000)}" value="${a.scheduled_at ? moscowDate(a.scheduled_at) : a.preferred_date}"></label><label>Время визита · МСК<input type="time" name="scheduled_time" value="${esc(scheduledTime)}"></label><label class="full">Адрес визита<input name="address" maxlength="500" value="${esc(a.address)}" placeholder="Город, улица, дом, ориентир"></label></div><label>Комментарий клиенту / результат работ<textarea name="staff_note" maxlength="2000" placeholder="Комментарий появится в личном кабинете">${esc(a.staff_note)}</textarea></label><p class="form-hint">При подтверждении обязательны дата, время и адрес. При завершении — результат работ, при отмене — причина. Все часы — МСК.</p>${formEnd('Сохранить изменения')}</form>`,
  );
  const form = $('#modal form'),
    toggle = () => {
      const confirmed = form.elements.status.value === 'confirmed';
      $('#visit-fields').hidden = !confirmed;
      for (const name of ['scheduled_date', 'scheduled_time', 'address']) {
        form.elements[name].required = confirmed;
        form.elements[name].disabled = !confirmed;
      }
      form.elements.staff_note.required = ['completed', 'cancelled'].includes(
        form.elements.status.value,
      );
    };
  form.elements.status.onchange = toggle;
  toggle();
  handleForm(
    (b) => api(`/appointments/${id}/update`, { ...b, version: a.version }),
    'Заявка обновлена. Изменения доступны клиенту',
  );
}
$('#appointment-filter').onchange = renderAppointments;
$('#appointment-search').oninput = renderAppointments;
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-manage-appointment]');
  if (b) manageAppointment(b.dataset.manageAppointment);
});
refresh();
setInterval(() => {
  if (!$('#app').hidden && !document.hidden) refresh();
}, 10000);
