import https from 'node:https';

const TELEGRAM_API = 'https://api.telegram.org/bot';

function request(token, method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      `${TELEGRAM_API}${token}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve({ ok: false });
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

export function createNotifier(config = {}) {
  const token = config.telegramToken || process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID || '';
  const enabled = !!(token && chatId);

  const icons = {
    deal_created: '🆕',
    deal_stage_changed: '📊',
    appointment_created: '📋',
    appointment_status: '🔄',
    client_registered: '👤',
    vehicle_added: '🚗',
  };

  const formatters = {
    deal_created: (d) =>
      `${icons.deal_created} <b>Новая сделка</b>\n${d.title}\nСумма: ${formatAmount(d.amount)}\nСтадия: ${d.stage}`,
    deal_stage_changed: (d) =>
      `${icons.deal_stage_changed} <b>Сделка изменена</b>\n${d.title}\n${d.old_stage} → <b>${d.new_stage}</b>`,
    appointment_created: (d) =>
      `${icons.appointment_created} <b>Новая заявка</b>\nVIN: ${d.vin}\nУслуга: ${d.service}\nДата: ${d.date}`,
    appointment_status: (d) =>
      `${icons.appointment_status} <b>Заявка обновлена</b>\nID: ${d.id}\nСтатус: <b>${d.status}</b>`,
    client_registered: (d) =>
      `${icons.client_registered} <b>Новый клиент</b>\n${d.name}\n${d.email}`,
    vehicle_added: (d) =>
      `${icons.vehicle_added} <b>Новый автомобиль</b>\nVIN: ${d.vin}\n${d.brand} ${d.model}`,
  };

  function formatAmount(amount) {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(amount || 0);
  }

  async function send(event, data) {
    if (!enabled) return;
    const format = formatters[event];
    if (!format) return;
    try {
      await request(token, 'sendMessage', {
        chat_id: chatId,
        text: format(data),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (e) {
      console.error('Telegram notification failed:', e.message);
    }
  }

  return { send, enabled };
}
