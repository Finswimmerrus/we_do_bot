'use strict';

const $ = (id) => document.getElementById(id);
const tg = window.Telegram?.WebApp;
const ui = {
  view: 'day', panel: 'list', listRequest: 0, cardRequest: 0,
  filters: {}, taskPeriod: null, statsPeriod: null, calendarPage: null,
  task: null, review: null, session: null,
  catalog: { categories: [] }, labelToDelete: null, today: null, dayFinished: false,
};
const viewTitles = { unscheduled: 'Без срока', major: 'Крупные', statistics: 'Статистика' };
const periods = {
  day: { length: 10, previous: 'Предыдущий день', next: 'Следующий день', current: 'Сегодня' },
  month: { length: 7, previous: 'Предыдущий месяц', next: 'Следующий месяц', current: 'Текущий месяц' },
  year: { length: 4, previous: 'Предыдущий год', next: 'Следующий год', current: 'Текущий год' },
};
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' });
const filterKeys = ['status', 'assignee', 'category', 'importance', 'query'];
const defaultTaskStatus = (view) => Object.hasOwn(periods, view) ? 'current' : 'active';
const importanceNames = { low: 'Низкая', medium: 'Средняя', high: 'Важная', global: 'Глобальная' };
const statusActions = {
  active: { label: 'Вернуть в активные', notice: 'Задача снова активна.' },
  done: { label: 'Завершить', notice: 'Задача завершена.' },
  obsolete: { label: 'Отменить задачу', notice: 'Задача отменена. Её можно вернуть через фильтр «Неактуальные».' },
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
    error.activeSubtasks = result.activeSubtasks;
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
  if (panel !== 'task') ui.cardRequest++;
  ui.panel = panel;
  for (const name of ['list', 'task', 'review', 'settings', 'labels']) $(`${name}-view`).hidden = name !== panel;
}

function periodLabel(period) {
  if (!period) return 'Без срока';
  if (period.length === 4) return period;
  if (period.length === 10) return dayFormat.format(new Date(`${period}T00:00:00Z`));
  const month = monthFormat.format(new Date(`${period}-01T00:00:00Z`));
  return `${month[0].toUpperCase()}${month.slice(1)} ${period.slice(0, 4)}`;
}

function selectedScope() {
  if (ui.view === 'unscheduled') return 'none';
  if (ui.view === 'major') return 'all';
  if (ui.view === 'statistics') return ui.statsPeriod ?? currentScope('month');
  return ui.taskPeriod ?? ui.today;
}

function periodMode(scope) {
  return scope.length === 10 ? 'day' : scope.length === 7 ? 'month' : 'year';
}

function currentScope(mode) {
  return ui.today.slice(0, periods[mode].length);
}

function shiftPeriod(scope, step) {
  const [year, month = 1, day = 1] = scope.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (scope.length === 10) date.setUTCDate(day + step);
  else if (scope.length === 7) date.setUTCMonth(month - 1 + step);
  else date.setUTCFullYear(year + step);
  return date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, scope.length) : null;
}

function applyPeriod(scope) {
  if (!scope || scope === selectedScope()) return;
  ui.cardRequest++;
  if (ui.view === 'statistics') ui.statsPeriod = scope;
  else {
    ui.taskPeriod = scope === ui.today ? null : scope;
    const mode = periodMode(scope);
    if (ui.view !== mode) return changeView(mode);
  }
  return loadList();
}

function renderPeriodSwitch(scope) {
  const settings = periods[periodMode(scope)];
  const day = scope.length === 10;
  const label = periodLabel(scope) + (day && scope.slice(0, 4) !== ui.today.slice(0, 4) ? ` ${scope.slice(0, 4)}` : '');
  const relative = scope === ui.today ? 'Сегодня' : scope === shiftPeriod(ui.today, 1) ? 'Завтра'
    : scope === shiftPeriod(ui.today, 2) ? 'Послезавтра' : null;
  $('period-caption').textContent = relative ?? label;
  $('period-open').setAttribute('aria-label', `Выбрать период · ${relative ? `${relative}, ` : ''}${label}`);
  for (const [id, step, hint] of [['period-prev', -1, settings.previous], ['period-next', 1, settings.next]]) {
    const button = $(id);
    button.disabled = !shiftPeriod(scope, step);
    button.title = hint;
    button.setAttribute('aria-label', hint);
  }
}

function calendarPageFor(scope) {
  if (scope.length === 10) return scope.slice(0, 7);
  if (scope.length === 7) return scope.slice(0, 4);
  return `${scope.slice(0, 3)}0`;
}

function chooseCalendarPeriod(scope) {
  $('period-picker').close();
  return applyPeriod(scope);
}

function renderCalendar() {
  const selected = selectedScope();
  const mode = periodMode(selected);
  const page = ui.calendarPage;
  const today = currentScope(mode);
  const grid = $('calendar-grid');
  const year = Number(page.slice(0, 4));
  const step = mode === 'year' ? 10 : 1;
  $('calendar-caption').textContent = mode === 'year' ? `${year}–${year + 9}` : periodLabel(page);
  $('calendar-prev').disabled = !shiftPeriod(page, -step);
  $('calendar-next').disabled = !shiftPeriod(page, step);
  $('calendar-current').textContent = periods[mode].current;
  for (const button of $('period-picker').querySelectorAll('[data-period-mode]')) {
    button.hidden = ui.view === 'statistics' && button.dataset.periodMode === 'day';
    button.setAttribute('aria-pressed', String(button.dataset.periodMode === mode));
  }
  const choices = [];
  const addChoice = (scope, label, accessibleLabel) => {
    const button = element('button', label, 'calendar-choice');
    button.type = 'button';
    button.dataset.scope = scope;
    if (accessibleLabel) button.setAttribute('aria-label', accessibleLabel);
    button.setAttribute('aria-pressed', String(scope === selected));
    if (scope === today) button.setAttribute('aria-current', 'date');
    choices.push(button);
  };
  if (mode === 'day') {
    const month = Number(page.slice(5));
    const first = new Date(Date.UTC(year, month - 1, 1));
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
    choices.push(...['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label) => element('span', label, 'calendar-weekday')));
    for (let index = 0; index < (first.getUTCDay() + 6) % 7; index++) choices.push(element('span'));
    for (let date = 1; date <= length; date++) {
      const scope = `${page}-${String(date).padStart(2, '0')}`;
      addChoice(scope, date, `${periodLabel(scope)} ${year}`);
    }
  } else if (mode === 'month') {
    for (let month = 1; month <= 12; month++) {
      const scope = `${page}-${String(month).padStart(2, '0')}`;
      addChoice(scope, periodLabel(scope).split(' ')[0]);
    }
  } else {
    for (let offset = 0; offset < 10; offset++) addChoice(String(year + offset), year + offset);
  }
  grid.dataset.mode = mode;
  grid.replaceChildren(...choices);
}

function openPeriodPicker() {
  const dialog = $('period-picker');
  ui.calendarPage = calendarPageFor(selectedScope());
  renderCalendar();
  dialog.showModal();
  $('period-open').setAttribute('aria-expanded', 'true');
  dialog.querySelector('[data-period-mode][aria-pressed="true"]').focus();
}

function categoryOption({ name, icon }) {
  return `${ui.session.categoryIcons[icon || 'folder'][0]} ${name}`;
}

function fillCategoryFilter(categories) {
  const select = $('filter-category');
  const previous = select.value;
  select.replaceChildren(new Option('Все', ''),
    ...categories.map((category) => new Option(categoryOption(category), category.id)));
  select.value = categories.some(({ id }) => String(id) === previous) ? previous : '';
}

function categoryChip({ name, color, icon }, compact = false) {
  const chip = element('span', undefined, 'label-chip');
  const [symbol] = ui.session.categoryIcons[icon || 'folder'];
  const badge = element('span', symbol, 'category-icon');
  if (color) badge.style.setProperty('--category-color', color);
  badge.setAttribute('aria-hidden', 'true');
  if (compact) {
    chip.classList.add('category-compact');
    chip.title = name;
    badge.removeAttribute('aria-hidden');
    badge.setAttribute('aria-label', name);
    chip.append(badge);
  } else chip.append(badge, element('span', name));
  return chip;
}

function priorityBadge(importance, compact = false) {
  const label = importanceNames[importance];
  const badge = element('span', compact ? undefined : label, compact ? 'importance-dot' : 'importance-chip');
  badge.dataset.importance = importance;
  if (compact) {
    badge.title = label;
    badge.setAttribute('aria-label', label);
  }
  return badge;
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
    button.addEventListener('click', () => run(() => applyPeriod(period), button));
    return button;
  }));
}

function memberName(id, distinguishSelf = false) {
  if (id === null) return 'Для двоих';
  const name = ui.session.members.find((member) => member.id === id)?.name;
  const mine = id === ui.session.userId;
  if (!name) return mine ? 'Вы' : 'Партнёр';
  return mine && distinguishSelf ? `${name} (вы)` : name;
}

function assigneeBadge(id) {
  const label = memberName(id, true);
  const member = ui.session.members.find((entry) => entry.id === id);
  const badge = element('span', undefined, 'assignee-badge');
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', label);
  badge.title = label;
  badge.dataset.slot = member?.slot ?? 'pair';
  if (id === null) badge.append(element('span', undefined, 'pair-symbol'));
  else {
    const name = memberName(id);
    badge.textContent = (name.match(/\p{L}/u)?.[0] ?? [...name][0]).toLocaleUpperCase('ru');
  }
  return badge;
}

function taskRow(task, listScope, expanded) {
  const row = element('details', undefined, 'task-row');
  row.open = expanded;
  row.dataset.taskId = task.id;
  row.dataset.status = task.status;
  const summary = element('summary', undefined, 'task-summary');
  summary.append(assigneeBadge(task.assigneeId), element('span', task.title, 'task-title'));
  const labels = element('span', undefined, 'task-labels');
  if (task.parentTitle) labels.append(taskHint('↳', `Подзадача к «${task.parentTitle}»`));
  const category = task.category && (ui.catalog.categories.find(({ name }) => name === task.category) ?? { name: task.category });
  if (category) labels.append(categoryChip(category, true));
  labels.append(priorityBadge(task.importance, true));
  if (task.period && task.period !== listScope) labels.append(element('small', periodLabel(task.period), 'row-period'));
  if (task.status === 'obsolete') labels.append(element('small', 'Отменена', 'task-hint'));
  summary.append(labels);

  const details = element('div', undefined, 'task-preview');
  if (task.description) details.append(element('p', task.description, 'task-description'));
  if (task.parentTitle) details.append(element('p', `Подзадача к «${task.parentTitle}»`));
  const metadata = element('div', undefined, 'task-metadata');
  metadata.append(element('span', memberName(task.assigneeId, true)), element('span', periodLabel(task.period)));
  if (category) metadata.append(categoryChip(category));
  metadata.append(priorityBadge(task.importance));
  details.append(metadata);

  const actions = element('div', undefined, 'task-status-actions');
  renderStatusActions(actions, task);
  const edit = element('button', 'Редактировать', 'quiet');
  edit.type = 'button';
  edit.addEventListener('click', () => run(() => openTask(task.id), edit));
  actions.append(edit);
  if (ui.view === 'day' && task.status === 'active' && task.period?.length === 10
      && (task.period < ui.today || task.period === ui.today && ui.dayFinished)) {
    const target = task.period < ui.today ? ui.today : shiftPeriod(ui.today, 1);
    if (target) {
      const move = element('button', '↪', 'icon-button');
      const label = task.period < ui.today ? 'Перенести на сегодня' : 'Перенести на завтра';
      move.type = 'button';
      move.title = label;
      move.setAttribute('aria-label', `${label}: ${task.title}`);
      move.addEventListener('click', () => run(async () => {
        await api(`tasks/${task.id}`, { version: task.version, period: target }, 'PATCH');
        if (ui.panel === 'list') await loadList();
        notify(`Перенесено на ${periodLabel(target)}.`);
      }, move));
      actions.prepend(move);
    }
  }
  details.append(actions);
  row.append(summary, details);
  return row;
}

function renderTaskList(container, tasks, listScope) {
  const expanded = new Set([...container.querySelectorAll('details[open]')].map((row) => Number(row.dataset.taskId)));
  container.replaceChildren(...tasks.map((task) => taskRow(task, listScope, expanded.has(task.id))));
}

function taskHint(symbol, label) {
  const hint = element('span', symbol, 'task-hint');
  hint.title = label;
  hint.setAttribute('aria-label', label);
  return hint;
}

function renderStatusActions(container, task, card = false) {
  const available = card ? Object.keys(statusActions).filter((status) => status !== task.status)
    : task.status === 'active' ? ['done', 'obsolete'] : ['active'];
  const controls = available.map((status) => {
    const { label } = statusActions[status];
    const button = element('button', status === 'active' ? label : undefined);
    button.type = 'button';
    button.dataset.statusAction = status;
    if (status !== 'active') {
      const icon = element('span', undefined, `action-icon ${status === 'done' ? 'icon-check' : 'icon-trash'}`);
      if (status === 'obsolete') icon.append(element('i'));
      icon.setAttribute('aria-hidden', 'true');
      button.classList.add('icon-button');
      button.title = label;
      button.append(icon);
    }
    button.setAttribute('aria-label', card ? label : `${label}: ${task.title}`);
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
  $('task-heading').dataset.status = task.status;
  $('task-priority').replaceChildren(priorityBadge(task.importance));
  $('task-status-label').textContent = 'Отменена';
  $('task-status-label').hidden = task.status !== 'obsolete';
  $('take-today').hidden = task.status !== 'active' || task.importance === 'global'
    || task.period === ui.today && task.assigneeId === ui.session.userId;
  renderStatusActions($('task-status-actions'), task, true);
}

function askDialog(id) {
  const dialog = $(id);
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
}

async function patchWithCompletionWarning(task, change) {
  const patch = (body) => api(`tasks/${task.id}`, { version: task.version, ...body }, 'PATCH');
  try {
    return await patch(change);
  } catch (error) {
    if (!error.activeSubtasks) throw error;
    $('complete-parent-note').textContent = `Активных подзадач: ${error.activeSubtasks}. Их можно завершить, сделать самостоятельными или удалить. Если завершить родителя сейчас, подзадачи останутся активными.`;
    const choice = await askDialog('complete-parent-dialog');
    if (choice === 'complete') return patch({ ...change, confirmWithActiveSubtasks: true });
    if (choice === 'children') {
      await openTask(task.id);
      if (ui.panel === 'task' && ui.task.id === task.id) $('subtasks').scrollIntoView({ block: 'start' });
    }
    return null;
  }
}

async function changeStatus(current, status) {
  const cardIsOpen = () => ui.panel === 'task' && ui.task.id === current.id;
  let updated;
  try {
    const result = await patchWithCompletionWarning(current, { status });
    if (!result) return;
    updated = result.task;
  } catch (error) {
    if (error.status === 409) {
      if (cardIsOpen()) await openTask(current.id);
      else await refreshVisibleTasks();
    }
    throw error;
  }
  if (cardIsOpen() && status === 'obsolete') {
    await changeView(ui.view);
  } else if (cardIsOpen()) {
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
  const view = ui.view;
  const statistics = ui.view === 'statistics';
  const scope = selectedScope();
  const params = statistics ? new URLSearchParams({ scope, view, include: 'summary' })
    : new URLSearchParams({
      scope, view, status: $('filter-status').value, query: $('filter-query').value,
      categoryId: $('filter-category').value, assignee: $('filter-assignee').value,
      importance: view === 'major' ? '' : $('filter-importance').value, include: 'catalog',
    });
  const dated = Object.hasOwn(periods, view);
  $('list-heading').dataset.view = view;
  $('period-switch').hidden = !dated && !statistics;
  if (dated || statistics) renderPeriodSwitch(scope);
  $('filter-importance').closest('label').hidden = statistics || view === 'major';
  $('quick-add-toggle').hidden = statistics;
  $('filters-toggle').hidden = statistics;
  $('filters-toggle').dataset.filtered = !statistics && (params.get('status') !== defaultTaskStatus(view) || params.get('assignee') !== 'all'
    || ['query', 'categoryId', 'importance'].some((key) => params.get(key)));
  $('review-start').hidden = !statistics;
  $('view-title').hidden = dated;
  $('view-title').textContent = viewTitles[view] ?? '';
  $('stats').hidden = !statistics;
  $('task-list').hidden = statistics;
  const listKey = `${view}/${scope}`;
  if ($('task-list').dataset.scope !== listKey) {
    $('task-list').dataset.scope = listKey;
    $('task-list').replaceChildren();
    $('carryover').hidden = true;
    $('day-rollover-note').hidden = true;
    $('list-empty').hidden = true;
  }
  if (statistics) $('list-empty').hidden = true;
  if (!statistics || scope.length !== 4) $('year-grid').hidden = true;
  $('task-list').setAttribute('aria-busy', 'true');

  try {
    const { tasks, stats, monthStats, catalog, carryover, today, dayFinished, partnerId, members } = await api(`tasks?${params}`);
    if (seq !== ui.listRequest) return;
    if (statistics) {
      showStats(stats);
      showYear(monthStats);
      return;
    }
    ui.catalog = catalog;
    const previousToday = ui.today;
    ui.today = today;
    ui.dayFinished = dayFinished;
    ui.session.partnerId = partnerId;
    ui.session.members = members;
    syncAssigneeFilter();
    if (dated && today !== previousToday) {
      if (ui.taskPeriod === null) return await loadList();
      renderPeriodSwitch(scope);
    }
    fillCategoryFilter(catalog.categories);
    if ($('filter-category').value !== params.get('categoryId') || $('filter-assignee').value !== params.get('assignee')) {
      return await loadList();
    }
    $('carryover').hidden = !carryover.length;
    renderTaskList($('carryover-list'), carryover);
    $('day-rollover-note').hidden = view !== 'day' || scope !== today || !dayFinished
      || !tasks.some((task) => task.status === 'active');
    renderTaskList($('task-list'), tasks, scope);
    $('list-empty').hidden = tasks.length > 0;
    $('list-empty').textContent = $('filters-toggle').dataset.filtered === 'true' ? 'По этим фильтрам задач нет.'
      : view === 'day' ? 'На этот день задач нет.' : 'Задач пока нет.';
    return tasks;
  } finally {
    if (seq === ui.listRequest) $('task-list').removeAttribute('aria-busy');
  }
}

function changeView(name) {
  if (name === 'period') name = periodMode(ui.taskPeriod ?? ui.today);
  if (name !== ui.view || ui.panel !== 'list') {
    toggleQuickAdd(false);
    $('task-filters').hidden = true;
    $('filters-toggle').setAttribute('aria-expanded', 'false');
  }
  ui.view = name;
  for (const tab of document.querySelectorAll('[data-view]')) {
    const active = tab.dataset.view === (Object.hasOwn(periods, name) ? 'period' : name);
    tab.setAttribute('aria-current', active ? 'page' : 'false');
  }
  if (name !== 'statistics') {
    const filters = ui.filters[name] ?? { status: defaultTaskStatus(name), assignee: 'all' };
    for (const key of filterKeys) $(`filter-${key}`).value = filters[key] ?? '';
    syncAssigneeFilter();
  }
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
  renderTaskList($('child-list'), children);
}

function toggleCategoryInput(selectId, fieldId, inputId) {
  const input = $(inputId);
  const adding = $(selectId).value === 'new';
  $(fieldId).hidden = !adding;
  input.disabled = !adding;
  if (adding) input.focus();
}

function editCategory(name) {
  const category = ui.catalog.categories.find((label) => label.name === name);
  $('edit-category').value = category ? category.id : '';
  $('new-category').value = '';
  toggleCategoryInput('edit-category', 'new-category-field', 'new-category');
}

function updateImportanceChoices() {
  const isSubtask = Boolean($('edit-parent').value);
  const global = $('edit-importance').querySelector('option[value="global"]');
  if (isSubtask && $('edit-importance').value === 'global') $('edit-importance').value = '';
  global.hidden = isSubtask;
  global.disabled = isSubtask;
}

function categoryChoice(value, inputId) {
  if (value === 'new') return { name: $(inputId).value };
  return value ? { id: Number(value) } : null;
}

function syncAssigneeFilter() {
  const select = $('filter-assignee');
  select.querySelector('option[value="me"]').textContent = memberName(ui.session.userId, true);
  const partner = select.querySelector('option[value="partner"]');
  partner.textContent = ui.session.partnerId ? memberName(ui.session.partnerId) : 'Партнёр';
  partner.hidden = !ui.session.partnerId;
  partner.disabled = !ui.session.partnerId;
  if (!ui.session.partnerId && select.value === 'partner') select.value = 'all';
  if (!$('quick-add').hidden) assigneeOptions($('new-assignee'), $('new-assignee').value);
}

function assigneeOptions(select, assigneeId) {
  select.replaceChildren(new Option('Для двоих', ''),
    ...ui.session.members.map(({ id }) => new Option(memberName(id, true), id)));
  select.value = assigneeId ?? '';
}

function toggleQuickAdd(open) {
  $('quick-add').hidden = !open;
  $('quick-add-toggle').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const assignee = $('filter-assignee').value;
  const assigneeId = assignee === 'partner' ? ui.session.partnerId
    : assignee === 'me' || ui.view === 'day' && assignee === 'all' ? ui.session.userId : null;
  assigneeOptions($('new-assignee'), assigneeId);
  $('new-title').focus();
}

function toggleSchedule(prefix) {
  const kind = $(`${prefix}-schedule`).value;
  for (const type of ['day', 'month', 'year']) {
    const input = $(`${prefix}-${type}`);
    const visible = type === kind;
    $(`${prefix}-${type}-label`).hidden = !visible;
    input.disabled = !visible;
    input.required = visible;
  }
}

function setSchedule(prefix, period) {
  const kind = period?.length === 10 ? 'day' : period?.length === 7 ? 'month' : period?.length === 4 ? 'year' : '';
  $(`${prefix}-schedule`).value = kind;
  $(`${prefix}-day`).value = kind === 'day' ? period : ui.today;
  $(`${prefix}-month`).value = kind === 'month' ? period : ui.today.slice(0, 7);
  $(`${prefix}-year`).value = kind === 'year' ? period : ui.today.slice(0, 4);
  toggleSchedule(prefix);
}

function scheduleValue(prefix) {
  const kind = $(`${prefix}-schedule`).value;
  return kind ? $(`${prefix}-${kind}`).value : null;
}

function prepareChildForm(task) {
  $('child-options').open = false;
  const defaults = task.category
    ? [new Option(`Как у родителя · ${task.category}`, 'inherit'), new Option('Без категории', '')]
    : [new Option('Без категории', 'inherit')];
  $('child-category').replaceChildren(...defaults,
    ...ui.catalog.categories.map((category) => new Option(categoryOption(category), category.id)),
    new Option('Новая категория…', 'new'));
  $('child-title').value = '';
  $('child-description').value = '';
  setSchedule('child', null);
  assigneeOptions($('child-assignee'), null);
  $('child-category-new').value = '';
  toggleCategoryInput('child-category', 'child-category-new-field', 'child-category-new');
}

async function openTask(id) {
  const request = ++ui.cardRequest;
  const result = await Promise.all([api(`tasks/${id}`), api('tasks')]).catch((error) => {
    if (request === ui.cardRequest) throw error;
  });
  if (request !== ui.cardRequest) return;
  const [{ task, children, catalog }, { tasks }] = result;
  ui.task = task;
  ui.catalog = catalog;
  $('task-heading').textContent = task.title;
  $('task-details').textContent = task.parentTitle ? `Подзадача к «${task.parentTitle}»` : '';
  showTaskStatus(task);
  $('edit-title').value = task.title;
  $('edit-description').value = task.description;
  setSchedule('edit', task.period);
  assigneeOptions($('edit-assignee'), task.assigneeId);
  $('edit-importance').value = task.importance;
  $('edit-category').replaceChildren(new Option('Без категории', ''),
    ...catalog.categories.map((category) => new Option(categoryOption(category), category.id)),
    new Option('Новая категория…', 'new'));
  editCategory(task.category);
  const parents = tasks.filter((item) => item.id !== task.id && item.parentId === null);
  $('edit-parent').replaceChildren(new Option('Без родителя', ''),
    ...parents.map((parent) => new Option(parent.title, parent.id)));
  $('edit-parent').value = task.parentId ?? '';
  $('edit-parent').disabled = children.length > 0;
  updateImportanceChoices();
  $('subtasks').hidden = task.parentId !== null;
  $('subtask-tools').hidden = task.parentId === null;
  if (task.parentId === null) prepareChildForm(task);
  showChildren(children);
  show('task');
}

async function updateTask() {
  const task = ui.task;
  const request = ui.cardRequest;
  const patch = {
    version: task.version,
    title: $('edit-title').value,
    description: $('edit-description').value,
    importance: $('edit-importance').value,
    period: scheduleValue('edit'),
    assigneeId: Number($('edit-assignee').value) || null,
    categoryChoice: categoryChoice($('edit-category').value, 'new-category'),
  };
  if (!$('edit-parent').disabled) patch.parentId = Number($('edit-parent').value) || null;
  try {
    await api(`tasks/${task.id}`, patch, 'PATCH');
  } catch (error) {
    if ((error.status === 409 || error.status === 404) && request === ui.cardRequest) await openTask(task.id);
    throw error;
  }
  if (request !== ui.cardRequest) return;
  await changeView(ui.view);
  notify('Изменения сохранены.');
}

async function startReview() {
  const scope = selectedScope();
  const { tasks } = await api(`tasks?scope=${scope}&status=active&view=statistics`);
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
  const current = () => api(`tasks?scope=${review.scope}&status=active&view=statistics`);
  try {
    if (change) {
      if ('period' in change && change.period === review.task.period) throw new Error('Выберите другой месяц или оставьте задачу.');
      try {
        if (!await patchWithCompletionWarning(review.task, change)) return;
      } catch (error) {
        if (error.status === 404 || error.status === 409) {
          const { tasks } = await current();
          if (ui.review === review) renderReview(tasks);
        }
        if (error.status === 404) {
          if (ui.review === review && ui.panel === 'review') notify('Задача уже удалена. Список разбора обновлён.');
          return;
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
  const request = ++ui.cardRequest;
  const session = await api('session');
  if (request !== ui.cardRequest) return;
  ui.session = session;
  syncAssigneeFilter();
  $('partner-info').textContent = session.partnerJoined ? 'Партнёр уже присоединился.' : 'Отправьте ссылку партнёру. Она действует до первого подключения.';
  $('invite-link').hidden = !session.invite;
  $('copy-invite').hidden = !session.invite || !navigator.clipboard;
  if (session.invite) $('invite-link').href = session.invite;
  $('group-info').textContent = session.groupLinked
    ? 'Чат подключён. Команда /unlink в личном чате с ботом отключит его.'
    : 'Выберите группу пары в Telegram. Ответы бота будут видны участникам выбранной группы.';
  $('group-setup').hidden = !session.groupSetupUrl;
  if (session.groupSetupUrl) $('group-setup').href = session.groupSetupUrl;
  $('group-help').hidden = session.groupLinked;
  $('group-command').textContent = session.linkCommand;
  show('settings');
}

function chooseCategoryIcon(label) {
  const dialog = $('category-icon-dialog');
  const choices = Object.entries(ui.session.categoryIcons).map(([icon, [symbol, name]]) => {
    const button = element('button', symbol);
    button.type = 'button';
    button.title = name;
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-pressed', String((label.icon || 'folder') === icon));
    button.addEventListener('click', () => run(async () => {
      await api(`labels/${label.id}`, { icon }, 'PATCH');
      dialog.close();
      await renderLabels();
      notify('Иконка сохранена.');
    }, button));
    return button;
  });
  $('category-icon-options').replaceChildren(...choices);
  dialog.showModal();
}

function labelManagerRow(label) {
  const row = element('li', undefined, 'label-row');
  const actions = element('div', undefined, 'label-row-actions');
  const icon = element('button', 'Иконка');
  icon.type = 'button';
  icon.setAttribute('aria-label', `Иконка «${label.name}»`);
  icon.addEventListener('click', () => chooseCategoryIcon(label));
  actions.append(icon);
  const colorField = element('label', 'Цвет', 'label-color-field');
  const color = element('input');
  color.type = 'color';
  color.value = label.color || '#6c776e';
  color.setAttribute('aria-label', `Цвет «${label.name}»`);
  color.addEventListener('change', () => run(async () => {
    try {
      await api(`labels/${label.id}`, { color: color.value }, 'PATCH');
    } catch (error) {
      color.value = label.color || '#6c776e';
      throw error;
    }
    await renderLabels();
    notify('Цвет сохранён.');
  }));
  colorField.append(color);
  actions.append(colorField);
  if (label.color) {
    const reset = element('button', 'Сбросить цвет', 'quiet');
    reset.type = 'button';
    reset.addEventListener('click', () => run(async () => {
      await api(`labels/${label.id}`, { color: null }, 'PATCH');
      await renderLabels();
      notify('Цвет сброшен.');
    }, reset));
    actions.append(reset);
  }
  const remove = element('button', 'Удалить', 'danger');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Удалить «${label.name}»`);
  remove.addEventListener('click', () => {
    const dialog = $('delete-label-dialog');
    ui.labelToDelete = label;
    $('delete-label-note').textContent = `«${label.name}» исчезнет из списка и всех задач пары. Сами задачи сохранятся.`;
    dialog.returnValue = '';
    dialog.showModal();
  });
  actions.append(remove);
  row.append(categoryChip(label), actions);
  return row;
}

async function renderLabels() {
  const { catalog } = await api('labels');
  ui.catalog = catalog;
  $('categories-empty').hidden = catalog.categories.length > 0;
  $('categories-list').replaceChildren(...catalog.categories.map(labelManagerRow));
}

function bindUi() {
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.addEventListener('click', () => {
      if (tab.dataset.view === 'period' && ui.panel === 'list' && Object.hasOwn(periods, ui.view)) openPeriodPicker();
      else run(() => changeView(tab.dataset.view), tab);
    });
  }
  const saveFilters = () => {
    if (ui.view !== 'statistics') {
      ui.filters[ui.view] = Object.fromEntries(filterKeys.map((key) => [key, $(`filter-${key}`).value]));
    }
  };
  for (const key of filterKeys.filter((key) => key !== 'query')) {
    $(`filter-${key}`).addEventListener('change', () => { saveFilters(); run(loadList); });
  }
  $('period-open').addEventListener('click', openPeriodPicker);
  $('period-picker').addEventListener('close', () => $('period-open').setAttribute('aria-expanded', 'false'));
  for (const [direction, step] of [['prev', -1], ['next', 1]]) {
    $(`period-${direction}`).addEventListener('click', () => run(() => applyPeriod(shiftPeriod(selectedScope(), step))));
    $(`calendar-${direction}`).addEventListener('click', () => {
      const offset = periodMode(selectedScope()) === 'year' ? 10 : 1;
      ui.calendarPage = shiftPeriod(ui.calendarPage, step * offset);
      renderCalendar();
    });
  }
  for (const button of $('period-picker').querySelectorAll('[data-period-mode]')) {
    button.addEventListener('click', () => run(() => {
      const mode = button.dataset.periodMode;
      if (mode === periodMode(selectedScope())) return;
      const scope = currentScope(mode);
      ui.calendarPage = calendarPageFor(scope);
      const loading = applyPeriod(scope);
      renderCalendar();
      return loading;
    }));
  }
  $('calendar-grid').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-scope]');
    if (button) run(() => chooseCalendarPeriod(button.dataset.scope));
  });
  $('calendar-current').addEventListener('click', () => run(() => chooseCalendarPeriod(currentScope(periodMode(selectedScope())))));
  let searchTimer;
  $('filter-query').addEventListener('input', () => {
    saveFilters();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => run(loadList), 160);
  });
  $('filters-toggle').addEventListener('click', () => {
    const open = $('task-filters').hidden;
    $('task-filters').hidden = !open;
    $('filters-toggle').setAttribute('aria-expanded', String(open));
  });
  $('quick-add-toggle').addEventListener('click', () => toggleQuickAdd($('quick-add').hidden));
  $('quick-add').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const input = $('new-title');
      const scope = selectedScope();
      const period = scope === 'all' || scope === 'none' ? null : scope;
      const description = $('new-description');
      const assigneeId = Number($('new-assignee').value) || null;
      const importance = ui.view === 'major' ? 'global' : 'low';
      const { task } = await api('tasks', { title: input.value, description: description.value, period, assigneeId, importance }, 'POST');
      input.value = '';
      description.value = '';
      if (!$('quick-add').hidden) {
        toggleQuickAdd(false);
        $('quick-add-toggle').focus();
      }
      const visible = ui.panel === 'list' && ui.view !== 'statistics' ? await loadList() : null;
      const location = period ? `Задача добавлена. Срок — ${periodLabel(period)}.` : 'Задача добавлена.';
      notify(visible && !visible.some(({ id }) => id === task.id)
        ? `${location} Текущие фильтры скрывают её.` : location);
    }, event.submitter);
  });
  $('task-back').addEventListener('click', () => run(() => changeView(ui.view)));
  $('task-editor').addEventListener('submit', (event) => {
    event.preventDefault();
    run(updateTask, event.submitter);
  });
  $('take-today').addEventListener('click', () => run(async () => {
    const task = ui.task;
    const request = ui.cardRequest;
    const { currentDay } = await api('session');
    await api(`tasks/${task.id}`, { version: task.version, period: currentDay, assigneeId: ui.session.userId }, 'PATCH');
    if (request === ui.cardRequest) await openTask(task.id);
    notify('Задача в вашем списке на сегодня.');
  }, $('take-today')));
  $('detach-subtask').addEventListener('click', () => run(async () => {
    const task = ui.task;
    const request = ui.cardRequest;
    await api(`tasks/${task.id}`, { version: task.version, parentId: null }, 'PATCH');
    if (request === ui.cardRequest) await openTask(task.id);
    notify('Подзадача стала самостоятельной задачей.');
  }, $('detach-subtask')));
  $('delete-subtask').addEventListener('click', () => run(async () => {
    const task = ui.task;
    const request = ui.cardRequest;
    $('delete-subtask-note').textContent = `«${task.title}» будет удалена из общего пространства пары. Удаление окончательное.`;
    if (await askDialog('delete-subtask-dialog') !== 'delete') return;
    await api(`tasks/${task.id}`, { version: task.version }, 'DELETE');
    if (request === ui.cardRequest) await openTask(task.parentId);
    notify('Подзадача удалена.');
  }, $('delete-subtask')));
  $('edit-category').addEventListener('change', () => toggleCategoryInput('edit-category', 'new-category-field', 'new-category'));
  $('edit-schedule').addEventListener('change', () => toggleSchedule('edit'));
  $('edit-parent').addEventListener('change', updateImportanceChoices);
  $('child-options').addEventListener('invalid', () => { $('child-options').open = true; }, true);
  $('child-category').addEventListener('change', () => toggleCategoryInput('child-category', 'child-category-new-field', 'child-category-new'));
  $('child-schedule').addEventListener('change', () => toggleSchedule('child'));
  $('add-child').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const parentId = ui.task.id;
      const request = ui.cardRequest;
      const category = $('child-category').value;
      const body = {
        title: $('child-title').value, description: $('child-description').value, parentId, period: scheduleValue('child'),
        assigneeId: Number($('child-assignee').value) || null,
      };
      if (category !== 'inherit') body.categoryChoice = categoryChoice(category, 'child-category-new');
      await api('tasks', body, 'POST');
      if (request === ui.cardRequest) await openTask(parentId);
      notify('Подзадача добавлена.');
    }, event.submitter);
  });
  $('review-start').addEventListener('click', () => run(startReview, $('review-start')));
  $('review-back').addEventListener('click', () => run(() => changeView('statistics')));
  for (const item of document.querySelectorAll('[data-review]')) {
    item.addEventListener('click', () => run(() => {
      const action = item.dataset.review;
      if (action === 'move') {
        $('review-move').hidden = !$('review-move').hidden;
        const period = ui.review.task.period;
        const input = $('review-month');
        input.type = period.length === 10 ? 'date' : period.length === 4 ? 'number' : 'month';
        input.min = period.length === 4 ? '1000' : '';
        input.max = period.length === 4 ? '9999' : '';
        input.value = period;
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
  $('open-labels').addEventListener('click', () => run(async () => {
    await renderLabels();
    show('labels');
  }, $('open-labels')));
  $('labels-back').addEventListener('click', () => run(openSettings, $('labels-back')));
  $('add-category-label').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const input = $('category-label-name');
      await api('labels', { kind: 'category', name: input.value }, 'POST');
      input.value = '';
      await renderLabels();
    }, event.submitter);
  });
  $('delete-label-dialog').addEventListener('close', (event) => {
    const label = ui.labelToDelete;
    ui.labelToDelete = null;
    if (event.currentTarget.returnValue !== 'delete' || !label) return;
    run(async () => {
      await api(`labels/${label.id}`, undefined, 'DELETE');
      await renderLabels();
      notify('Удалено из списка и задач пары.');
    });
  });
  for (const id of ['invite-link', 'group-setup']) {
    $(id).addEventListener('click', (event) => {
      if (tg.openTelegramLink) {
        event.preventDefault();
        tg.openTelegramLink(event.currentTarget.href);
      }
    });
  }
  $('copy-invite').addEventListener('click', () => run(async () => {
    await navigator.clipboard.writeText($('invite-link').href);
    notify('Ссылка скопирована.');
  }, $('copy-invite')));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ui.panel === 'list') run(loadList);
    if (!document.hidden && ui.panel === 'labels') run(renderLabels);
    if (!document.hidden && ui.panel === 'settings') run(openSettings);
  });
  setInterval(() => {
    if (!document.hidden && ui.panel === 'list' && ui.view === 'day') loadList().catch(() => {});
  }, 60_000);
}

async function init() {
  tg?.ready();
  if (!tg?.initData) {
    $('entry').textContent = 'Откройте Mini App из личного чата с ботом в Telegram.';
    return;
  }
  try {
    ui.session = await api('session');
    ui.today = ui.session.currentDay;
    $('entry').hidden = true;
    $('settings').hidden = false;
    $('workspace').hidden = false;
    bindUi();
    await changeView('period');
  } catch (error) {
    if ($('entry').hidden) notify(error.message, true);
    else $('entry').textContent = error.message;
  }
}

init();
