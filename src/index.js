import { once } from 'node:events';
import { Bot, poll, registerCommands, TelegramApi } from './bot.js';
import { currentPeriod } from './periods.js';
import { Store } from './store.js';
import { webServer } from './web.js';

async function main() {
  const token = process.env.BOT_TOKEN;
  const timeZone = process.env.TIME_ZONE || 'Europe/Moscow';
  const host = process.env.BIND_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const appUrl = process.env.MINI_APP_URL;
  if (!token || !/^\d+:[\w-]+$/.test(token)) throw new Error('Проверьте BOT_TOKEN в настройках.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
  if (appUrl) {
    const url = URL.parse(appUrl);
    if (!url || url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
      throw new Error('Укажите публичный HTTPS-адрес Mini App без дополнительного пути.');
    }
  }
  currentPeriod(timeZone);

  const api = new TelegramApi(token);
  const { username } = await api.call('getMe');
  if (!username) throw new Error('У бота отсутствует имя пользователя.');
  const webhook = await api.call('getWebhookInfo');
  if (webhook.url) throw new Error('Для этого бота уже включён webhook. Отключите его перед запуском опроса.');
  const store = new Store(process.env.DATABASE_PATH || 'data/we-do.sqlite');
  const server = webServer({ store, token, username, timeZone });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    server.listen(port, host);
    await once(server, 'listening');
    await registerCommands(api);
    console.log(`@${username} запущен. Mini App слушает http://${host}:${port}`);
    await poll(api, new Bot({ api, store, username, appUrl, timeZone }), controller.signal);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

main().catch((error) => {
  const token = process.env.BOT_TOKEN;
  console.error(token ? error.message.replaceAll(token, '[скрыто]') : error.message);
  process.exitCode = 1;
});
