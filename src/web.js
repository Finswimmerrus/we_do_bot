import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { currentPeriod, InputError } from './periods.js';
import { taskStats } from './store.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([path, [file, type]]) => [path, { body: readFileSync(new URL(`../public/${file}`, import.meta.url)), type }]));

export function telegramUser(initData, token, now = Date.now()) {
  if (typeof initData !== 'string' || !initData || initData.length > 8192) return null;
  const data = new URLSearchParams(initData);
  const hash = data.get('hash');
  if (!hash || !/^[\da-f]{64}$/.test(hash) || new Set(data.keys()).size !== data.size) return null;
  data.delete('hash');
  data.sort();
  const check = [...data].map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  const issued = Number(data.get('auth_date')) * 1000;
  if (!Number.isSafeInteger(issued) || issued < now - 86_400_000 || issued > now + 60_000) return null;
  try {
    const { id } = JSON.parse(data.get('user'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function bodyOf(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new InputError('Ожидается JSON.', 415);
  }
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 16_384) throw new InputError('Запрос слишком большой.', 413);
    parts.push(part);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new InputError('Данные запроса не читаются.');
  }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new InputError('Некорректный запрос.');
  return data;
}

function queryOptions(url) {
  const options = Object.fromEntries(url.searchParams);
  const { scope, status, query, category, tag } = options;
  return { scope, status, query, category, tag };
}

export function webServer({ store, token, username, timeZone }) {
  return createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy',
      "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const { pathname, searchParams } = url;
      if (request.method === 'GET' && assets.has(pathname)) {
        const { body, type } = assets.get(pathname);
        response.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        return response.end(body);
      }
      if (request.method === 'GET' && pathname === '/health') return sendJson(response, 200, { ok: true });
      if (!pathname.startsWith('/api/')) throw new InputError('Страница не найдена.', 404);
      const user = telegramUser(request.headers['x-telegram-init-data'], token);
      if (!user) throw new InputError('Откройте приложение из личного чата с ботом.', 401);
      const space = store.spaceFor(user);
      if (!space) throw new InputError('Сначала отправьте боту команду /start.', 403);

      if (pathname === '/api/session' && request.method === 'GET') {
        return sendJson(response, 200, {
          currentPeriod: currentPeriod(timeZone),
          partnerJoined: space.memberCount === 2,
          groupLinked: space.groupChat !== null,
          invite: space.invite ? `https://t.me/${username}?start=${space.invite}` : null,
          linkCommand: `/link@${username}`,
        });
      }
      if (pathname === '/api/labels') {
        if (request.method === 'GET') return sendJson(response, 200, { catalog: store.catalog(space.id) });
        if (request.method === 'POST') {
          return sendJson(response, 201, { label: store.createLabel(space.id, await bodyOf(request)) });
        }
      }
      const labelRoute = pathname.match(/^\/api\/labels\/(\d+)$/);
      if (labelRoute) {
        const id = Number(labelRoute[1]);
        if (request.method === 'PATCH') {
          const { color } = await bodyOf(request);
          return sendJson(response, 200, { label: store.setLabelColor(space.id, id, color) });
        }
        if (request.method === 'DELETE') {
          store.deleteLabel(space.id, id);
          return sendJson(response, 200, { ok: true });
        }
      }
      if (pathname === '/api/tasks' && request.method === 'GET') {
        const tasks = store.list(space.id, queryOptions(url));
        if (searchParams.get('include') !== 'summary') return sendJson(response, 200, { tasks });
        const scope = searchParams.get('scope') ?? 'all';
        const periodTasks = store.list(space.id, { scope });
        const catalog = store.catalog(space.id);
        const suggestions = {
          categories: catalog.categories.map(({ name }) => name),
          tags: catalog.tags.map(({ name }) => name),
        };
        const monthStats = scope.length === 4
          ? Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
            const period = `${scope}-${String(index + 1).padStart(2, '0')}`;
            return [period, taskStats(periodTasks.filter((task) => task.period === period))];
          }))
          : null;
        return sendJson(response, 200, { tasks, stats: taskStats(periodTasks), monthStats, catalog, suggestions });
      }
      if (pathname === '/api/tasks' && request.method === 'POST') {
        return sendJson(response, 201, { task: store.createTask(space.id, user, await bodyOf(request)) });
      }
      const taskRoute = pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (taskRoute) {
        const id = Number(taskRoute[1]);
        if (request.method === 'GET') {
          return sendJson(response, 200, {
            task: store.task(space.id, id),
            children: store.children(space.id, id),
            catalog: store.catalog(space.id),
          });
        }
        if (request.method === 'PATCH') {
          return sendJson(response, 200, { task: store.updateTask(space.id, id, await bodyOf(request)) });
        }
      }
      throw new InputError('Маршрут не найден.', 404);
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof InputError) return sendJson(response, error.status, { error: error.message });
      console.error('Ошибка Mini App:', error.message);
      return sendJson(response, 500, { error: 'Не удалось обработать запрос.' });
    }
  });
}
