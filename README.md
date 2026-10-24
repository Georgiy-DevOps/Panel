<p align="center">
  <img src="public/favicon.svg" width="80" height="80" alt="VoltCRM">
</p>

<h1 align="center">VoltCRM</h1>

<p align="center">
  CRM-система для управления клиентами, автомобилями и продажами.<br>
  Разработана для дилеров <strong>Zeekr</strong> и <strong>Lynk & Co</strong>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D24-purple?logo=nodedotjs" alt="Node 24+">
  <img src="https://img.shields.io/badge/database-SQLite-blue?logo=sqlite" alt="SQLite">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero deps">
  <img src="https://img.shields.io/badge/license-private-lightgrey" alt="Private">
</p>

---

## Возможности

### Панель администратора

- **Автомобили** — реестр VIN, фильтры по марке, поиск, карточка автомобиля
- **Dashboard** — аналитика: воронка продаж, статистика менеджеров, графики по месяцам
- **Сделки** — Kanban-доска с 6 этапами (новая → переговоры → КП → оплата → выиграна / проиграна)
- **Запись на сервис** — обработка заявок клиентов, подтверждение визитов, история
- **Клиенты** — реестр личных кабинетов
- **Менеджеры** — управление командой с ролями и правами доступа
- **Журнал** — аудит всех действий в системе
- **Telegram-уведомления** — оповещения о новых сделках и заявках

### Личный кабинет клиента

- Регистрация и авторизация по email
- Мои автомобили — добавление VIN, статусы
- Запись на сервис — ТО, диагностика, настройка автомобиля, консультация
- История обращений и статус визитов

## Скриншоты

<!-- Добавьте скриншоты в папку docs/ и раскомментируйте -->
<!-- ![Логин](docs/login.png) -->
<!-- ![Админка](docs/admin.png) -->
<!-- ![Сделки](docs/deals.png) -->
<!-- ![Кабинет клиента](docs/client.png) -->

## Стек

| Компонент | Технология |
|-----------|-----------|
| Runtime | Node.js 24+ (ESM) |
| База данных | SQLite через `node:sqlite` (DatabaseSync) |
| HTTP-сервер | Встроенный `node:http` |
| Аутентификация | scrypt + cookie-сессии |
| Защита | CSRF (origin check), rate limiting |
| Уведомления | Telegram Bot API через `node:https` |
| Зависимости | **0** — только стандартная библиотека Node.js |

## Быстрый старт

Требуется **Node.js 24.14+**. Внешних npm-зависимостей нет.

```bash
git clone https://github.com/Georgiy-DevOps/Panel.git
cd Panel
npm run setup      # создаёт .env с паролем администратора
npm start          # запуск на http://127.0.0.1:3080
```

При первом запуске `setup` генерирует случайный пароль администратора — сохраните его.

## Развёртывание на сервере

### Systemd

```bash
# Клонировать и настроить
cd /srv/panel
git clone https://github.com/Georgiy-DevOps/Panel.git .
node scripts/setup.mjs

# Создать сервис
cat > /etc/systemd/system/voltcrm.service << 'EOF'
[Unit]
Description=VoltCRM Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/panel
ExecStart=/usr/bin/node --env-file-if-exists=.env server.mjs
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now voltcrm
```

### Nginx (HTTPS reverse proxy)

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Не забудьте указать `PUBLIC_URL=https://your-domain.com` и `TRUST_PROXY=1` в `.env`.

### Docker

```bash
docker compose up -d --build
```

## Переменные окружения

| Переменная | Описание | По умолчанию |
|-----------|----------|-------------|
| `PUBLIC_URL` | Публичный URL панели | `http://127.0.0.1:3080` |
| `PORT` | Порт HTTP-сервера | `3080` |
| `HOST` | Адрес привязки | `127.0.0.1` |
| `ADMIN_PASSWORD_HASH` | Хеш пароля администратора | генерируется `setup` |
| `TRUST_PROXY` | Доверять `X-Forwarded-*` | `0` |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота | — |
| `TELEGRAM_CHAT_ID` | ID чата для уведомлений | — |

## Тесты

```bash
npm test
```

## Структура проекта

```
Panel/
├── server.mjs           # HTTP-сервер, маршруты, middleware
├── deals.mjs            # CRUD сделок, Kanban, история
├── managers.mjs         # Менеджеры, авторизация, права
├── dashboard.mjs        # Бизнес-аналитика
├── appointments.mjs     # Сервисные заявки
├── telegram.mjs         # Telegram-уведомления
├── public/
│   ├── index.html       # Панель администратора
│   ├── client.html      # Личный кабинет клиента
│   ├── app.js           # JS админки
│   ├── client.js        # JS кабинета клиента
│   ├── deals-ui.js      # Kanban-доска
│   ├── dashboard-ui.js  # Графики и аналитика
│   ├── style.css        # Основные стили
│   └── ...
├── scripts/
│   └── setup.mjs        # Генерация .env
├── test/
│   └── *.test.mjs       # Тесты
└── compose.yaml         # Docker Compose
```

## Лицензия

Частный проект. Все права защищены.
