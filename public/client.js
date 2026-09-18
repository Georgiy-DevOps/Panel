import { services, activeStatuses, moscowDate } from './service-catalog.js';
import {
  escapeHTML as esc,
  appointmentCard,
  ordered,
  dateTime,
  serviceName,
} from './appointments-ui.js';
const $ = (s) => document.querySelector(s);
let registering = false,
  refreshing = false,
  state = { vehicles: [], appointments: [] },
  requestFilter = 'active',
  pendingService = null;
const states = {
  pending: 'Ожидает связи',
  linked: 'Связан с ByteDepp',
  unavailable: 'Данные временно недоступны',
  missing: 'Устройство не найдено',
  mismatch: 'Нужна проверка VIN',
};
async function api(path, body) {
  const r = await fetch('/api/client' + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401 && !['/login', '/register'].includes(path)) showAuth();
    throw new Error(data.error || 'Ошибка запроса');
  }
  return data;
}
function showAuth() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('#cabinet').hidden = true;
  $('#auth').hidden = false;
  state = { vehicles: [], appointments: [] };
  pendingService = null;
}
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($('#toast').hidden = true), 6000);
}
function mode(register) {
  registering = register;
  $('#name-label').hidden = !register;
  $('#auth-form').elements.name.disabled = !register;
  $('#auth-form').elements.name.required = register;
  $('#auth-form').elements.password.minLength = register ? 12 : 1;
  $('#auth-form').elements.password.autocomplete = register ? 'new-password' : 'current-password';
  $('#password-hint').hidden = !register;
  $('#login-tab').classList.toggle('selected', !register);
  $('#register-tab').classList.toggle('selected', register);
  $('#auth-submit').textContent = register ? 'Создать кабинет →' : 'Войти в кабинет →';
  $('#auth-error').textContent = '';
}
const date = (t) => (t ? new Date(t).toLocaleDateString('ru-RU') : 'Бессрочно');
const service = (title, data) =>
  `<div class="client-service"><div><strong>${title}</strong><small>${data.active ? (data.expires_at ? 'До ' + date(data.expires_at) : 'Бессрочно') : 'Доступ не активен'}</small></div><span class="pill ${data.active ? 'ready' : ''}">${data.active ? 'Активен' : 'Не активен'}</span></div>`;
function render() {
  $('#client-name').textContent = state.client.name;
  $('#client-cars').innerHTML = state.vehicles.length
    ? state.vehicles
        .map(
          (v) =>
            `<article class="client-car"><div class="car-header"><div><span class="vehicle-brand">${esc(v.brand)}</span><h2>${esc(v.model)}</h2></div><span class="pill ${v.link_status}">${states[v.link_status]}</span></div><div class="client-vin">${esc(v.vin)}</div><div class="car-details"><span>Версия системы: ${esc(v.software || 'ещё не передана ByteDepp')}</span>${v.region ? '<span>Регион: ' + esc(v.region) + '</span>' : ''}</div>${v.bytedepp ? service('Русский язык', v.bytedepp.language) + service('Магазин приложений', v.bytedepp.store) : `<div class="pending-message">${v.link_status === 'pending' ? 'VIN зарегистрирован. Связь с ByteDepp ожидает проверки. Запись на сервис уже доступна.' : 'Связь с ByteDepp требует проверки. Запись на сервис доступна.'}</div>`}<button class="book-car" data-book-car="${v.id}">Записать автомобиль →</button></article>`,
        )
        .join('')
    : '<div class="empty"><div class="empty-symbol" aria-hidden="true">▦</div><h2>Начните с вашего автомобиля</h2><p>Добавьте VIN, чтобы записаться на обслуживание и подключить сервисы ByteDepp.</p><button class="primary" data-add-vin>＋ Добавить VIN</button></div>';
  const next = ordered(state.appointments).find(
    (a) => a.status === 'confirmed' && a.scheduled_at > Date.now(),
  );
  $('#next-visit').hidden = !next;
  $('#next-visit').innerHTML = next
    ? `<div><p class="eyebrow">БЛИЖАЙШИЙ ВИЗИТ</p><strong>${esc(dateTime(next.scheduled_at))}</strong><p>${esc(serviceName(next.service))} · ${esc(next.model)}<br>${esc(next.address)}</p></div><a href="#requests" id="show-next-visit">Посмотреть заявку ↓</a>`
    : '';
  $('#show-next-visit')?.addEventListener('click', () => setRequestFilter('active'));
  renderAppointments();
}
function renderAppointments() {
  const open = new Set(
    [...document.querySelectorAll('#client-appointments details[open]')].map(
      (d) => d.dataset.history,
    ),
  );
  const rows = state.appointments.filter(
    (a) => activeStatuses.includes(a.status) === (requestFilter === 'active'),
  );
  $('#request-count').textContent =
    `Активных: ${state.appointments.filter((a) => activeStatuses.includes(a.status)).length}`;
  $('#client-appointments').innerHTML = rows.length
    ? (requestFilter === 'active' ? ordered(rows) : rows).map((a) => appointmentCard(a)).join('')
    : `<div class="appointment-empty"><h3>${requestFilter === 'active' ? 'Активных заявок пока нет' : 'История пока пуста'}</h3>${requestFilter === 'active' ? 'Выберите услугу выше — заявка появится здесь.' : 'Здесь сохраняются завершённые и отменённые обращения.'}</div>`;
  document
    .querySelectorAll('#client-appointments details')
    .forEach((d) => (d.open = open.has(d.dataset.history)));
}
function setRequestFilter(value) {
  requestFilter = value;
  document.querySelectorAll('[data-request-filter]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.requestFilter === value);
    b.setAttribute('aria-pressed', String(b.dataset.requestFilter === value));
  });
  renderAppointments();
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await api('/state'),
      changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    $('#auth').hidden = true;
    $('#cabinet').hidden = false;
    $('#client-offline').hidden = true;
    if (changed) render();
  } catch (e) {
    if (!$('#cabinet').hidden) $('#client-offline').hidden = false;
  } finally {
    refreshing = false;
  }
}
$('#service-options').innerHTML = services
  .map(
    (s) =>
      `<button class="service-option" data-service="${s.id}"><span>${s.icon} ↗</span><strong>${s.name}</strong><small>${s.description}</small></button>`,
  )
  .join('');
$('#login-tab').onclick = () => mode(false);
$('#register-tab').onclick = () => mode(true);
$('#auth-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = $('#auth-submit');
  button.disabled = true;
  $('#auth-error').textContent = '';
  try {
    await api(registering ? '/register' : '/login', Object.fromEntries(new FormData(form)));
    form.reset();
    await refresh();
  } catch (e) {
    $('#auth-error').textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
function addVin() {
  $('#vin-error').textContent = '';
  $('#vin-form').reset();
  $('#vin-modal').showModal();
}
$('#add-vin').onclick = () => {
  pendingService = null;
  addVin();
};
$('#close-vin').onclick = () => $('#vin-modal').close();
$('#vin-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('[type=submit]');
  button.disabled = true;
  $('#vin-error').textContent = '';
  try {
    const car = await api('/vehicles', Object.fromEntries(new FormData(form)));
    $('#vin-modal').close();
    await refresh();
    toast('Автомобиль добавлен');
    if (pendingService && state.vehicles.some((v) => v.id === car.id)) {
      const next = pendingService;
      pendingService = null;
      book(next, car.id);
    }
  } catch (e) {
    $('#vin-error').textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
const formEnd = (label) =>
  `<p id="booking-error" class="error-text" role="alert"></p><div class="form-actions"><button type="button" data-close-booking>Закрыть</button><button type="submit" class="primary">${label}</button></div>`;
function bookingModal(title, html, action, success) {
  $('#booking-title').textContent = title;
  $('#booking-body').innerHTML = html;
  $('#booking-modal').showModal();
  $('#booking-body form').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      button = form.querySelector('[type=submit]');
    button.disabled = true;
    $('#booking-error').textContent = '';
    try {
      await action(Object.fromEntries(new FormData(form)));
      $('#booking-modal').close();
      await refresh();
      toast(success);
    } catch (error) {
      if (error.message.includes('уже изменена')) await refresh();
      $('#booking-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}
function book(serviceId = 'maintenance', vehicleId) {
  if (!state.vehicles.length) {
    pendingService = serviceId;
    toast('Сначала добавьте автомобиль — затем продолжим запись');
    addVin();
    return;
  }
  const requestKey = crypto.randomUUID(),
    last = state.appointments[0];
  bookingModal(
    'Запись на сервис',
    `<form class="appointment-form"><div class="notice">Это заявка на визит. Администратор подтвердит дату и адрес в вашем кабинете. Все часы указаны по Москве (МСК).</div><label>Автомобиль<select name="vehicle_id" required>${state.vehicles.map((v) => `<option value="${v.id}" ${v.id === vehicleId ? 'selected' : ''}>${esc(v.brand)} ${esc(v.model)} · ${esc(v.vin)}</option>`).join('')}</select></label><label>Услуга<select name="service" required>${services.map((s) => `<option value="${s.id}" ${s.id === serviceId ? 'selected' : ''}>${s.name}</option>`).join('')}</select></label><div class="form-grid"><label>Желаемая дата<input name="preferred_date" type="date" required min="${moscowDate()}" max="${moscowDate(Date.now() + 180 * 86400000)}"></label><label>Желаемое время · МСК<input name="preferred_time" type="time"></label><label>Телефон для связи<input name="phone" type="tel" required maxlength="32" autocomplete="tel" placeholder="+7 999 123-45-67" value="${esc(last?.phone || '')}"></label><label>Пробег, км · необязательно<input name="mileage" type="number" min="0" max="2000000" step="1" inputmode="numeric" placeholder="Например, 25000"></label></div><label>Что нужно сделать?<textarea name="description" maxlength="2000" placeholder="Опишите проблему, симптомы или пожелания"></textarea></label><p class="form-hint">Изменения заявки появятся в кабинете. При необходимости администратор свяжется по указанному телефону.</p>${formEnd('Отправить заявку →')}</form>`,
    (b) => api('/appointments', { ...b, request_key: requestKey }),
    'Заявка отправлена. Ожидайте подтверждения в кабинете',
  );
  setRequestFilter('active');
}
function cancelAppointment(id) {
  const a = state.appointments.find((a) => a.id === id);
  if (!a) return;
  bookingModal(
    'Отменить заявку?',
    `<form class="appointment-form"><p>${esc(serviceName(a.service))} · ${esc(a.model)}</p><p class="form-hint">Заявка останется в истории. Если нужен другой день, после отмены можно создать новую.</p>${formEnd('Отменить заявку')}</form>`,
    () => api(`/appointments/${id}/cancel`, { version: a.version }),
    'Заявка отменена',
  );
}
$('#close-booking').onclick = () => $('#booking-modal').close();
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-add-vin')) {
    pendingService = null;
    addVin();
  }
  if (b.hasAttribute('data-book')) book();
  if (b.dataset.service) book(b.dataset.service);
  if (b.dataset.bookCar) book('maintenance', b.dataset.bookCar);
  if (b.dataset.requestFilter) setRequestFilter(b.dataset.requestFilter);
  if (b.hasAttribute('data-close-booking')) $('#booking-modal').close();
  if (b.dataset.cancelAppointment) cancelAppointment(b.dataset.cancelAppointment);
});
$('#logout-client').onclick = async () => {
  try {
    await api('/logout', {});
    showAuth();
  } catch (e) {
    toast(e.message);
  }
};
refresh();
setInterval(() => {
  if (!$('#cabinet').hidden && !document.hidden) refresh();
}, 15000);
