'use strict';

const $ = (id) => document.getElementById(id);
const tg = window.Telegram?.WebApp;
const ui = {
  view: 'backlog', panel: 'list', listRequest: 0, cardRequest: 0,
  filterStatus: { backlog: 'active', periods: 'all' },
  task: null, review: null, session: null,
};
const statusNames = { active: 'Активна', done: 'Выполнена', obsolete: 'Неактуальна' };
const statusActions = {
  active: { label: 'Вернуть в активные', notice: 'Задача снова активна.' },
  done: { label: 'Завершить', notice: 'Задача завершена.' },
  obsolete: { label: 'Отменить задачу', notice: 'Задача отменена. Её можно найти в списке «Неактуальные».' },
};

function element(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(path, data, method = 'GET') {
  const headers = { 'x-telegram-init-data': tg.initData };
  if (data) headers['content-type'] = 'application/json';
  const response = await fetch(`/api/${path}`, { method, headers, body: data && JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  return result;
}

function notify(text = '', error = false) {
  const notice = $('notice');
  notice.hidden = !text;
  notice.textContent = text;
  notice.dataset.error = error;
}

async function run(action, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    notify();
    return await action();
  } catch (error) {
    notify(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function show(panel) {
  ui.panel = panel;
  for (const name of ['list', 'task', 'review', 'settings']) $(`${name}-view`).hidden = name !== panel;
}

function periodLabel(period) {
  if (!period) return 'Без месяца';
  if (period.length === 4) return period;
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' })
    .format(new Date(`${period}-01T00:00:00Z`));
  return `${month[0].toUpperCase()}${month.slice(1)} ${period.slice(0, 4)}`;
}

function selectedScope() {
  if (ui.view === 'backlog' && $('backlog-scope').value !== 'month') return $('backlog-scope').value;
  if (ui.view === 'periods' && $('period-mode').value === 'year') {
    return $('scope-year').validity.valid && $('scope-year').value || ui.session.currentPeriod.slice(0, 4);
  }
  return /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test($('scope-month').value) ? $('scope-month').value : ui.session.currentPeriod;
}

function fillSelect(select, values, emptyLabel) {
  const previous = select.value;
  select.replaceChildren(new Option(emptyLabel, ''), ...values.map((value) => new Option(value, value)));
  select.value = values.includes(previous) ? previous : '';
}

function showStats(stats) {
  const labels = [
    ['Всего', stats.total], ['Выполнено', stats.done], ['Активно', stats.active],
    ['Неактуально', stats.obsolete], ['Доля выполненных', stats.percent === null ? '—' : `${stats.percent}%`],
  ];
  $('stats').replaceChildren(...labels.map(([label, value]) => {
    const card = element('div', undefined, 'stat');
    card.append(element('strong', value), element('span', label));
    return card;
  }));
}

function showYear(monthStats) {
  $('year-grid').hidden = !monthStats;
  if (!monthStats) return;
  $('year-grid').replaceChildren(...Object.entries(monthStats).map(([period, stats]) => {
    const button = element('button', periodLabel(period).split(' ')[0]);
    button.type = 'button';
    button.append(element('small', `${stats.done} ✓ · ${stats.active} ○ · ${stats.obsolete} –`));
    button.addEventListener('click', () => run(() => {
      $('scope-month').value = period;
      $('period-mode').value = 'month';
      return loadList();
    }, button));
    return button;
  }));
}

function taskRow(task) {
  const row = element('div', undefined, 'task-row');
  const open = element('button', task.title, 'task-open');
  open.type = 'button';
  const fields = [statusNames[task.status], periodLabel(task.period)];
  if (task.parentTitle) fields.push(`к «${task.parentTitle}»`);
  if (task.category) fields.push(task.category);
  fields.push(...task.tags);
  open.append(element('small', fields.join(' · ')));
  open.addEventListener('click', () => run(() => openTask(task.id), open));
  const actions = element('div', undefined, 'task-status-actions');
  renderStatusActions(actions, task);
  row.append(open, actions);
  return row;
}

function renderStatusActions(container, task, card = false) {
  const available = card ? Object.keys(statusActions).filter((status) => status !== task.status)
    : task.status === 'active' ? ['done', 'obsolete'] : ['active'];
  const controls = available.map((status) => {
    const { label } = statusActions[status];
    const button = element('button', label);
    button.type = 'button';
    button.dataset.statusAction = status;
    if (!card) button.setAttribute('aria-label', `${label}: ${task.title}`);
    button.addEventListener('click', () => run(async () => {
      controls.forEach((control) => { control.disabled = true; });
      try {
        await changeStatus(task, status);
      } finally {
        controls.forEach((control) => { control.disabled = false; });
      }
    }, button));
    return button;
  });
  container.replaceChildren(...controls);
}

function showTaskStatus(task) {
  $('task-status-label').textContent = statusNames[task.status];
  renderStatusActions($('task-status-actions'), task, true);
}

async function changeStatus(current, status) {
  const cardIsOpen = () => ui.panel === 'task' && ui.task.id === current.id;
  let updated;
  try {
    ({ task: updated } = await api(`tasks/${current.id}`, { version: current.version, status }, 'PATCH'));
  } catch (error) {
    if (error.status === 409) {
      if (cardIsOpen()) await openTask(current.id);
      else await refreshVisibleTasks();
    }
    throw error;
  }
  if (cardIsOpen()) {
    ui.task = updated;
    showTaskStatus(updated);
  } else {
    await refreshVisibleTasks();
  }
  notify(statusActions[status].notice);
}

async function refreshVisibleTasks() {
  if (ui.panel === 'list') return loadList();
  if (ui.panel === 'task') {
    const id = ui.task.id;
    const { children } = await api(`tasks/${id}`);
    if (ui.panel === 'task' && ui.task.id === id) showChildren(children);
  }
}

async function loadList() {
  const seq = ++ui.listRequest;
  const periods = ui.view === 'periods';
  const scope = selectedScope();
  const params = new URLSearchParams({
    scope, status: $('filter-status').value, query: $('filter-query').value,
    category: $('filter-category').value, tag: $('filter-tag').value, include: 'summary',
  });
  $('period-mode-label').hidden = !periods;
  $('backlog-scope-label').hidden = periods;
  $('scope-month-label').hidden = periods ? $('period-mode').value === 'year' : $('backlog-scope').value !== 'month';
  $('scope-year-label').hidden = !periods || $('period-mode').value !== 'year';
  $('quick-add').hidden = periods;
  $('review-start').hidden = !periods;
  $('view-title').textContent = periods ? periodLabel(scope) : 'Бэклог';
  $('stats').hidden = !periods;
  if (!periods || scope.length !== 4) $('year-grid').hidden = true;
  $('task-list').setAttribute('aria-busy', 'true');

  try {
    const { tasks, stats, monthStats, suggestions } = await api(`tasks?${params}`);
    if (seq !== ui.listRequest) return;
    fillSelect($('filter-category'), suggestions.categories, 'Все');
    fillSelect($('filter-tag'), suggestions.tags, 'Все');
    $('category-suggestions').replaceChildren(...suggestions.categories.map((name) => element('option', name)));
    if (periods) showStats(stats);
    showYear(monthStats);
    $('task-list').replaceChildren(...tasks.map(taskRow));
    $('list-empty').hidden = tasks.length > 0;
    $('list-empty').textContent = 'По этим фильтрам задач нет.';
  } finally {
    if (seq === ui.listRequest) $('task-list').removeAttribute('aria-busy');
  }
}

function changeView(name) {
  ui.view = name;
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.setAttribute('aria-current', tab.dataset.view === name ? 'page' : 'false');
  }
  $('filter-status').value = ui.filterStatus[name];
  show('list');
  return loadList();
}

function showChildren(children) {
  const counts = { active: 0, done: 0, obsolete: 0 };
  for (const child of children) counts[child.status]++;
  const progress = [];
  const available = counts.active + counts.done;
  if (available) progress.push(`${counts.done} из ${available} выполнено`, `${counts.active} активно`);
  if (counts.obsolete) progress.push(`${counts.obsolete} неактуально`);
  $('subtask-progress').textContent = progress.join(' · ');
  $('child-list').replaceChildren(...children.map(taskRow));
}

async function openTask(id) {
  const request = ++ui.cardRequest;
  const [{ task, children }, { tasks }] = await Promise.all([api(`tasks/${id}`), api('tasks')]);
  if (request !== ui.cardRequest) return;
  ui.task = task;
  $('task-heading').textContent = task.title;
  $('task-details').textContent = task.parentTitle ? `Подзадача к «${task.parentTitle}»` : '';
  showTaskStatus(task);
  $('edit-title').value = task.title;
  $('edit-period').value = task.period || '';
  $('edit-category').value = task.category || '';
  $('edit-tags').value = task.tags.join(', ');
  const parents = tasks.filter((item) => item.id !== task.id && item.parentId === null);
  $('edit-parent').replaceChildren(new Option('Без родителя', ''),
    ...parents.map((parent) => new Option(parent.title, parent.id)));
  $('edit-parent').value = task.parentId ?? '';
  $('edit-parent').disabled = children.length > 0;
  $('subtasks').hidden = task.parentId !== null;
  $('child-title').value = '';
  showChildren(children);
  show('task');
}

async function updateTask() {
  const task = ui.task;
  const patch = {
    version: task.version,
    title: $('edit-title').value,
    period: $('edit-period').value || null,
    category: $('edit-category').value || null,
    tags: $('edit-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean),
  };
  if (!$('edit-parent').disabled) patch.parentId = Number($('edit-parent').value) || null;
  try {
    await api(`tasks/${task.id}`, patch, 'PATCH');
  } catch (error) {
    if (error.status === 409) await openTask(task.id);
    throw error;
  }
  await openTask(task.id);
  notify('Изменения сохранены.');
}

async function startReview() {
  const scope = selectedScope();
  const { tasks } = await api(`tasks?scope=${scope}&status=active`);
  ui.review = { scope, ids: tasks.map((task) => task.id), task: null };
  show('review');
  renderReview(tasks);
}

function renderReview(tasks) {
  const review = ui.review;
  const current = new Map(tasks.map((task) => [task.id, task]));
  review.ids = review.ids.filter((id) => current.has(id));
  review.task = current.get(review.ids[0]);
  $('review-heading').textContent = `Разбор · ${periodLabel(review.scope)}`;
  $('review-progress').textContent = review.task ? `Осталось в этом проходе: ${review.ids.length}` : 'В этом проходе задач больше нет.';
  $('review-card').hidden = !review.task;
  $('review-move').hidden = true;
  if (review.task) {
    $('review-task-title').textContent = review.task.title;
    $('review-task-info').textContent =
      [periodLabel(review.task.period), review.task.parentTitle && `к «${review.task.parentTitle}»`].filter(Boolean).join(' · ');
  }
}

async function reviewAction(change) {
  const review = ui.review;
  if (review.busy || !review.task) return;
  review.busy = true;
  const current = () => api(`tasks?scope=${review.scope}&status=active`);
  try {
    if (change) {
      if ('period' in change && change.period === review.task.period) throw new Error('Выберите другой месяц или оставьте задачу.');
      try {
        await api(`tasks/${review.task.id}`, { version: review.task.version, ...change }, 'PATCH');
      } catch (error) {
        if (error.status === 409) {
          const { tasks } = await current();
          if (ui.review === review) renderReview(tasks);
        }
        throw error;
      }
    }
    review.ids.shift();
    const { tasks } = await current();
    if (ui.review === review) renderReview(tasks);
    if (change?.status) notify(statusActions[change.status].notice);
  } finally {
    review.busy = false;
  }
}

async function openSettings() {
  const session = await api('session');
  $('partner-info').textContent = session.partnerJoined ? 'Партнёр уже присоединился.' : 'Отправьте ссылку партнёру. Она действует до первого подключения.';
  $('invite-link').hidden = !session.invite;
  $('copy-invite').hidden = !session.invite || !navigator.clipboard;
  if (session.invite) $('invite-link').href = session.invite;
  $('group-info').textContent = session.groupLinked
    ? 'Чат подключён. Команда /unlink в личном чате с ботом отключит его.'
    : `Добавьте бота в чат пары и отправьте ${session.linkCommand}. Ответы бота будут видны участникам чата.`;
  show('settings');
}

function bindUi() {
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.addEventListener('click', () => run(() => changeView(tab.dataset.view), tab));
  }
  for (const id of ['period-mode', 'backlog-scope', 'scope-month', 'scope-year', 'filter-category', 'filter-tag', 'filter-status']) {
    $(id).addEventListener('change', () => {
      ui.filterStatus[ui.view] = $('filter-status').value;
      run(loadList);
    });
  }
  let searchTimer;
  $('filter-query').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => run(loadList), 160);
  });
  $('quick-add').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const input = $('new-title');
      await api('tasks', { title: input.value }, 'POST');
      input.value = '';
      await loadList();
      notify('Задача добавлена.');
    }, event.submitter);
  });
  $('task-back').addEventListener('click', () => run(() => changeView(ui.view)));
  $('task-editor').addEventListener('submit', (event) => {
    event.preventDefault();
    run(updateTask, event.submitter);
  });
  $('add-child').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const parentId = ui.task.id;
      await api('tasks', { title: $('child-title').value, parentId }, 'POST');
      await openTask(parentId);
      notify('Подзадача добавлена.');
    }, event.submitter);
  });
  $('review-start').addEventListener('click', () => run(startReview, $('review-start')));
  $('review-back').addEventListener('click', () => run(() => changeView('periods')));
  for (const item of document.querySelectorAll('[data-review]')) {
    item.addEventListener('click', () => run(() => {
      const action = item.dataset.review;
      if (action === 'move') {
        $('review-move').hidden = !$('review-move').hidden;
        $('review-month').value = ui.review.task.period;
        return;
      }
      return reviewAction(action === 'skip' ? null : { status: action });
    }, item));
  }
  $('review-move').addEventListener('submit', (event) => {
    event.preventDefault();
    run(() => reviewAction({ period: $('review-month').value }), event.submitter);
  });
  $('review-clear').addEventListener('click', () => run(() => reviewAction({ period: null }), $('review-clear')));
  $('settings').addEventListener('click', () => run(openSettings, $('settings')));
  $('settings-back').addEventListener('click', () => run(() => changeView(ui.view)));
  $('invite-link').addEventListener('click', (event) => {
    if (tg.openTelegramLink) {
      event.preventDefault();
      tg.openTelegramLink(event.currentTarget.href);
    }
  });
  $('copy-invite').addEventListener('click', () => run(async () => {
    await navigator.clipboard.writeText($('invite-link').href);
    notify('Ссылка скопирована.');
  }, $('copy-invite')));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ui.panel === 'list') run(loadList);
  });
}

async function init() {
  tg?.ready();
  if (!tg?.initData) {
    $('entry').textContent = 'Откройте Mini App из личного чата с ботом в Telegram.';
    return;
  }
  try {
    ui.session = await api('session');
    $('scope-month').value = ui.session.currentPeriod;
    $('scope-year').value = ui.session.currentPeriod.slice(0, 4);
    $('entry').hidden = true;
    $('settings').hidden = false;
    $('workspace').hidden = false;
    bindUi();
    await changeView('backlog');
  } catch (error) {
    if ($('entry').hidden) notify(error.message, true);
    else $('entry').textContent = error.message;
  }
}

init();
