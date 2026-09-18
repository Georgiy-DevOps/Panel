import { services, statuses, activeStatuses } from './service-catalog.js';
export const escapeHTML = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const esc = escapeHTML;
export const serviceName = (id) => services.find((s) => s.id === id)?.name || id;
export const dateTime = (t) =>
  new Date(t).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' МСК';
export const preferred = (a) =>
  new Date(a.preferred_date + 'T12:00:00+03:00').toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  }) + (a.preferred_time ? ' · ' + a.preferred_time + ' МСК' : ' · время согласуем');
export const ordered = (rows) =>
  [...rows].sort(
    (a, b) =>
      Number(activeStatuses.includes(b.status)) - Number(activeStatuses.includes(a.status)) ||
      (a.scheduled_at || a.created_at) - (b.scheduled_at || b.created_at),
  );
export function appointmentCard(a, admin = false) {
  const active = activeStatuses.includes(a.status);
  return `<article class="appointment-card" data-appointment="${a.id}">
    <div class="appointment-heading"><div><span class="eyebrow">ЗАЯВКА № ${esc(a.id.slice(0, 8).toUpperCase())}</span><h3>${esc(serviceName(a.service))}</h3></div><span class="pill appointment-${a.status}">${statuses[a.status]}</span></div>
    <p class="appointment-car">${esc(a.brand)} ${esc(a.model)} <span class="vin">${esc(a.vin)}</span></p>
    ${admin ? `<div class="appointment-contact"><strong>${esc(a.client_name)}</strong><span>${esc(a.phone)}</span><span>${esc(a.client_email)}</span></div>` : ''}
    <div class="visit-summary ${active && a.scheduled_at ? 'visit-confirmed' : ''}"><span>${a.scheduled_at ? 'Согласованный визит' : 'Желаемая дата'}</span><strong>${esc(a.scheduled_at ? dateTime(a.scheduled_at) : preferred(a))}</strong>${a.address ? `<p>${esc(a.address)}</p>` : active ? '<p>Дата и адрес появятся после подтверждения администратором.</p>' : ''}</div>
    ${a.mileage !== null ? `<p class="form-hint">Пробег при обращении: ${a.mileage.toLocaleString('ru-RU')} км</p>` : ''}
    ${a.description ? `<div class="appointment-message"><span>Обращение клиента</span><p>${esc(a.description)}</p></div>` : ''}
    ${a.staff_note ? `<div class="appointment-message staff-message"><span>${a.status === 'completed' ? 'Результат работ' : 'Комментарий администратора'}</span><p>${esc(a.staff_note)}</p></div>` : ''}
    <div class="appointment-bottom"><details data-history="${a.id}"><summary>История заявки <span>${a.history.length}</span></summary><ol class="appointment-timeline">${a.history.map((h) => `<li><strong>${statuses[h.status]}</strong><time>${esc(dateTime(h.created_at))} · ${h.actor === 'admin' ? 'Администратор' : 'Клиент'}</time><p>${esc(h.note)}</p></li>`).join('')}</ol></details>
    ${admin && active ? `<button class="primary" data-manage-appointment="${a.id}">Обработать →</button>` : !admin && ['new', 'confirmed'].includes(a.status) ? `<button class="quiet-button" data-cancel-appointment="${a.id}">Отменить заявку</button>` : ''}</div>
  </article>`;
}
