import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const origin = process.argv[2] || 'http://127.0.0.1:3080';
const url = new URL(origin);
if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw new Error('Для внешнего адреса требуется HTTPS');
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16).toString('hex');
const hash = salt + ':' + scryptSync(password, salt, 64).toString('hex');
writeFileSync(
  '.env',
  `PUBLIC_URL=${url.origin}\nADMIN_PASSWORD_HASH=${hash}\nPORT=3080\nHOST=127.0.0.1\nMAX_PACKAGE_BYTES=5368709120\nSTORAGE_QUOTA_BYTES=32212254720\n`,
  { flag: 'wx', mode: 0o600 },
);
console.log(
  'Настройки сохранены в .env. Сохраните пароль в менеджере паролей. Он показан только сейчас.\nПароль администратора: ' +
    password,
);
