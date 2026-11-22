'use strict';

const $ = (id) => document.getElementById(id);
const tg = window.Telegram?.WebApp;
const ui = {
  view: 'backlog', panel: 'list', listRequest: 0, cardRequest: 0,
  filterStatus: { backlog: 'active', periods: 'all' },
  task: null, review: null, session: null,
  catalog: { categories: [] }, labelToDelete: null,
};
const importanceNames = { low: 'Низкая', medium: 'Средняя', high: 'Важная', global: 'Глобальная' };
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
  if (!period) return 'Без месяца';
  if (period.length === 4) return period;
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' })
    .format(new Date(`${period}-01T00:00:00Z`));
  return `${month[0].toUpperCase()}${month.slice(1)} ${period.slice(0, 4)}`;
}

function selectedScope() {
  if (ui.view === 'backlog' && $('backlog-scope').value !== 'month') return $('backlog-scope').value;
  if (ui.view !== 'backlog' && $('period-mode').value === 'year') {
    return $('scope-year').validity.valid && $('scope-year').value || ui.session.currentPeriod.slice(0, 4);
  }
  return /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test($('scope-month').value) ? $('scope-month').value : ui.session.currentPeriod;
}

function categoryOption({ name, icon }) {
  return `${ui.session.categoryIcons[icon || 'folder'][0]} ${name}`;
}

function fillCategoryFilter(categories) {
  const select = $('filter-category');
  const previous = select.value;
  select.replaceChildren(new Option('Все', ''),
    ...categories.map((category) => new Option(categoryOption(category), category.name)));
  select.value = categories.some(({ name }) => name === previous) ? previous : '';
}

function categoryChip({ name, color, icon }) {
  const chip = element('span', undefined, 'label-chip');
  const [symbol] = ui.session.categoryIcons[icon || 'folder'];
  const badge = element('span', symbol, 'category-icon');
  if (color) badge.style.setProperty('--category-color', color);
  badge.setAttribute('aria-hidden', 'true');
  chip.append(badge, element('span', name));
  return chip;
}

function priorityBadge(importance) {
  const badge = element('span', importanceNames[importance], 'importance-chip');
  badge.dataset.importance = importance;
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
    button.addEventListener('click', () => run(() => {
      $('scope-month').value = period;
      $('period-mode').value = 'month';
      return loadList();
    }, button));
    return button;
  }));
}

function taskRow(task, hidePeriod = false) {
  const row = element('div', undefined, 'task-row');
  row.dataset.status = task.status;
  const open = element('button', undefined, 'task-open');
  open.type = 'button';
  open.append(element('span', task.title, 'task-title'));
  const fields = hidePeriod ? [] : [periodLabel(task.period)];
  if (task.status === 'obsolete') fields.unshift('Отменена');
  if (task.parentTitle) fields.push(`к «${task.parentTitle}»`);
  if (fields.length) open.append(element('small', fields.join(' · ')));
  const labels = element('span', undefined, 'task-labels');
  if (task.category) {
    const category = ui.catalog.categories.find(({ name }) => name === task.category) ?? { name: task.category };
    labels.append(categoryChip(category));
  }
  labels.append(priorityBadge(task.importance));
  open.append(labels);
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
  const periods = ui.view !== 'backlog';
  const statistics = ui.view === 'statistics';
  const scope = selectedScope();
  const params = statistics ? new URLSearchParams({ scope, include: 'summary' })
    : new URLSearchParams({
    scope, status: $('filter-status').value, query: $('filter-query').value,
    category: $('filter-category').value, importance: $('filter-importance').value, include: 'catalog',
  });
  $('period-mode-label').hidden = !periods;
  $('backlog-scope-label').hidden = periods;
  $('scope-month-label').hidden = periods ? $('period-mode').value === 'year' : $('backlog-scope').value !== 'month';
  $('scope-year-label').hidden = !periods || $('period-mode').value !== 'year';
  for (const filter of document.querySelectorAll('[data-task-filter]')) filter.hidden = statistics;
  $('quick-add').hidden = statistics || periods && scope.length !== 7;
  $('review-start').hidden = !statistics;
  $('view-title').textContent = statistics ? 'Статистика' : periods ? periodLabel(scope) : 'Бэклог';
  $('stats').hidden = !statistics;
  $('task-list').hidden = statistics;
  if (statistics) $('list-empty').hidden = true;
  if (!statistics || scope.length !== 4) $('year-grid').hidden = true;
  $('task-list').setAttribute('aria-busy', 'true');

  try {
    const { tasks, stats, monthStats, catalog } = await api(`tasks?${params}`);
    if (seq !== ui.listRequest) return;
    if (statistics) {
      showStats(stats);
      showYear(monthStats);
      return;
    }
    ui.catalog = catalog;
    fillCategoryFilter(catalog.categories);
    if ($('filter-category').value !== params.get('category')) {
      return await loadList();
    }
    const hidePeriod = scope.length === 7;
    $('task-list').replaceChildren(...tasks.map((task) => taskRow(task, hidePeriod)));
    $('list-empty').hidden = tasks.length > 0;
    $('list-empty').textContent = 'По этим фильтрам задач нет.';
    return tasks;
  } finally {
    if (seq === ui.listRequest) $('task-list').removeAttribute('aria-busy');
  }
}

function changeView(name) {
  ui.view = name;
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.setAttribute('aria-current', tab.dataset.view === name ? 'page' : 'false');
  }
  if (name !== 'statistics') $('filter-status').value = ui.filterStatus[name];
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
  $('child-list').replaceChildren(...children.map((task) => taskRow(task)));
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

function prepareChildForm(task) {
  const defaults = task.category
    ? [new Option(`Как у родителя · ${task.category}`, 'inherit'), new Option('Без категории', '')]
    : [new Option('Без категории', 'inherit')];
  $('child-category').replaceChildren(...defaults,
    ...ui.catalog.categories.map((category) => new Option(categoryOption(category), category.id)),
    new Option('Новая категория…', 'new'));
  $('child-title').value = '';
  $('child-period').value = '';
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
  $('edit-period').value = task.period || '';
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
    importance: $('edit-importance').value,
    period: $('edit-period').value || null,
    categoryChoice: categoryChoice($('edit-category').value, 'new-category'),
  };
  if (!$('edit-parent').disabled) patch.parentId = Number($('edit-parent').value) || null;
  try {
    await api(`tasks/${task.id}`, patch, 'PATCH');
  } catch (error) {
    if ((error.status === 409 || error.status === 404) && request === ui.cardRequest) await openTask(task.id);
    throw error;
  }
  if (request === ui.cardRequest) await openTask(task.id);
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
        if (!await patchWithCompletionWarning(review.task, change)) return;
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
  ui.cardRequest++;
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
    tab.addEventListener('click', () => run(() => changeView(tab.dataset.view), tab));
  }
  for (const id of ['period-mode', 'backlog-scope', 'scope-month', 'scope-year', 'filter-category', 'filter-importance', 'filter-status']) {
    $(id).addEventListener('change', () => {
      if (ui.view !== 'statistics') ui.filterStatus[ui.view] = $('filter-status').value;
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
      const scope = selectedScope();
      const period = scope.length === 7 ? scope : null;
      const { task } = await api('tasks', { title: input.value, period }, 'POST');
      input.value = '';
      const visible = ui.panel === 'list' && ui.view !== 'statistics' ? await loadList() : null;
      const location = period ? `Задача добавлена. Месяц — ${periodLabel(period)}.` : 'Задача добавлена.';
      notify(visible && !visible.some(({ id }) => id === task.id)
        ? `${location} Текущие фильтры скрывают её.` : location);
    }, event.submitter);
  });
  $('task-back').addEventListener('click', () => run(() => changeView(ui.view)));
  $('task-editor').addEventListener('submit', (event) => {
    event.preventDefault();
    run(updateTask, event.submitter);
  });
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
  $('edit-parent').addEventListener('change', updateImportanceChoices);
  $('child-category').addEventListener('change', () => toggleCategoryInput('child-category', 'child-category-new-field', 'child-category-new'));
  $('add-child').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const parentId = ui.task.id;
      const request = ui.cardRequest;
      const category = $('child-category').value;
      const body = { title: $('child-title').value, parentId, period: $('child-period').value || null };
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
    if (!document.hidden && ui.panel === 'labels') run(renderLabels);
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
