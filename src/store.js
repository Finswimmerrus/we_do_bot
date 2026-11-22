import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exactPeriod, InputError, parseScope } from './periods.js';

export const statuses = { active: 'Активна', done: 'Выполнена', obsolete: 'Неактуальна' };
export const importanceLevels = { low: 'Низкая', medium: 'Средняя', high: 'Важная', global: 'Глобальная' };
export const categoryIcons = {
  folder: ['📁', 'Папка'], home: ['🏠', 'Дом'], shopping: ['🛒', 'Покупки'],
  car: ['🚗', 'Машина'], travel: ['✈️', 'Поездки'], health: ['🩺', 'Здоровье'],
  money: ['💳', 'Финансы'], work: ['💼', 'Работа'], tools: ['🔧', 'Ремонт'],
  family: ['👪', 'Семья'], phone: ['📞', 'Звонки'], document: ['📄', 'Документы'],
  sport: ['🏃', 'Спорт'], study: ['📚', 'Учёба'], gift: ['🎁', 'Подарки'],
  pet: ['🐾', 'Питомцы'], food: ['🍽️', 'Еда'], calendar: ['📅', 'События'],
  leaf: ['🌿', 'Природа'], idea: ['💡', 'Идеи'], entertainment: ['🎬', 'Досуг'],
};

const taskFields = `
  SELECT t.id, t.title, t.status, t.period, t.category,
    t.importance, t.tags, t.parent_id AS parentId,
    p.title AS parentTitle, t.created_by AS createdBy, t.created_at AS createdAt,
    t.completed_at AS completedAt, t.version
  FROM tasks AS t LEFT JOIN tasks AS p ON p.id = t.parent_id
`;

function taskTable(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id INTEGER NOT NULL REFERENCES spaces(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'obsolete')),
    period TEXT,
    category TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    parent_id INTEGER,
    created_by INTEGER NOT NULL REFERENCES members(user_id),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    source TEXT,
    importance TEXT NOT NULL DEFAULT 'low' CHECK (importance IN ('low', 'medium', 'high', 'global')),
    UNIQUE (space_id, source),
    UNIQUE (space_id, id),
    FOREIGN KEY (space_id, parent_id) REFERENCES ${name}(space_id, id)
  ) STRICT;`;
}

function asTask(row) {
  return { ...row, tags: JSON.parse(row.tags) };
}

function cleanText(value, max, field) {
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new InputError(`${field} — до ${max} символов.`);
  }
  return value.trim().replace(/\s+/g, ' ');
}

export function taskTitle(value) {
  const title = cleanText(value, 200, 'Название');
  if (!title) throw new InputError('Введите название задачи.');
  return title;
}

function cleanTags(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new InputError('Добавьте до 20 тегов.');
  }
  return [...new Map(value.map((tag) => {
    const name = cleanText(tag, 40, 'Тег');
    return [name.toLowerCase(), name];
  })).values()].filter(Boolean);
}

const labelLimits = { category: 60, tag: 40 };

function labelKey(name) {
  return name.normalize('NFKC').toLowerCase();
}

function labelName(kind, value) {
  if (typeof kind !== 'string' || !Object.hasOwn(labelLimits, kind)) throw new InputError('Выберите категорию или тег.');
  const name = cleanText(value, labelLimits[kind], kind === 'category' ? 'Название категории' : 'Название тега');
  if (!name) throw new InputError('Введите название.');
  return name;
}

function labelColor(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^#[a-fA-F\d]{6}$/.test(value)) {
    throw new InputError('Выберите цвет.');
  }
  return value.toLowerCase();
}

function isId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function taskStats(tasks) {
  const result = { total: tasks.length, active: 0, done: 0, obsolete: 0, percent: null };
  for (const task of tasks) result[task.status]++;
  const actionable = result.active + result.done;
  if (actionable) result.percent = Math.round(result.done * 100 / actionable);
  return result;
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS spaces (
        id INTEGER PRIMARY KEY,
        invite TEXT UNIQUE,
        group_chat INTEGER UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS members (
        user_id INTEGER PRIMARY KEY,
        space_id INTEGER NOT NULL REFERENCES spaces(id),
        slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
        UNIQUE (space_id, slot)
      ) STRICT;
      ${taskTable('tasks')}
      CREATE TABLE IF NOT EXISTS voice_jobs (
        id INTEGER PRIMARY KEY,
        space_id INTEGER NOT NULL REFERENCES spaces(id),
        user_id INTEGER NOT NULL REFERENCES members(user_id),
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        file_id TEXT,
        UNIQUE (chat_id, message_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS pending_voice_jobs ON voice_jobs(id) WHERE file_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        space_id INTEGER NOT NULL REFERENCES spaces(id),
        kind TEXT NOT NULL CHECK (kind IN ('category', 'tag')),
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        color TEXT,
        UNIQUE (space_id, kind, name_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS accepted_invites (
        token TEXT PRIMARY KEY,
        space_id INTEGER NOT NULL REFERENCES spaces(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS telegram_updates (
        id INTEGER PRIMARY KEY,
        payload TEXT,
        action_result TEXT,
        failed INTEGER NOT NULL DEFAULT 0,
        received_at INTEGER NOT NULL DEFAULT (unixepoch())
      ) STRICT;
      CREATE INDEX IF NOT EXISTS telegram_pending_updates ON telegram_updates(id) WHERE payload IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_prompts (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      ) STRICT;
    `);
    this.#migrateSchema();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS tasks_by_period ON tasks(space_id, period, status);
      CREATE INDEX IF NOT EXISTS tasks_by_parent ON tasks(space_id, parent_id);
    `);
  }

  close() {
    this.db.close();
  }

  transaction(action) {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveTelegramUpdates(updates) {
    this.transaction(() => {
      const save = this.db.prepare('INSERT INTO telegram_updates (id, payload) VALUES (?, ?) ON CONFLICT (id) DO NOTHING');
      for (const update of updates) save.run(update.update_id, JSON.stringify(update));
      this.db.prepare('DELETE FROM telegram_updates WHERE payload IS NULL AND received_at < unixepoch() - 172800').run();
    });
  }

  pendingTelegramUpdate() {
    const row = this.db.prepare('SELECT payload FROM telegram_updates WHERE payload IS NOT NULL ORDER BY id LIMIT 1').get();
    return row ? JSON.parse(row.payload) : null;
  }

  applyTelegramAction(id, action) {
    if (id === undefined) return action();
    return this.transaction(() => {
      const row = this.db.prepare('SELECT action_result AS result FROM telegram_updates WHERE id = ?').get(id);
      if (!row) return action();
      if (row.result !== null) return JSON.parse(row.result);
      const result = action();
      this.db.prepare('UPDATE telegram_updates SET action_result = ? WHERE id = ?').run(JSON.stringify(result ?? null), id);
      return result;
    });
  }

  finishTelegramUpdate(id, failed = false) {
    this.db.prepare('UPDATE telegram_updates SET payload = NULL, action_result = NULL, failed = ? WHERE id = ?').run(Number(failed), id);
  }

  hasTelegramAction(id) {
    return id !== undefined && Boolean(this.db.prepare('SELECT 1 FROM telegram_updates WHERE id = ? AND action_result IS NOT NULL').get(id));
  }

  taskPrompt(chat, user) {
    return this.db.prepare('SELECT message_id AS messageId FROM task_prompts WHERE chat_id = ? AND user_id = ? AND expires_at > ?')
      .get(chat, user, Date.now());
  }

  setTaskPrompt(chat, user, message, expires) {
    this.db.prepare(`INSERT INTO task_prompts VALUES (?, ?, ?, ?)
      ON CONFLICT (chat_id, user_id) DO UPDATE SET message_id = excluded.message_id, expires_at = excluded.expires_at`)
      .run(chat, user, message, expires);
  }

  clearTaskPrompt(chat, user) {
    this.db.prepare('DELETE FROM task_prompts WHERE chat_id = ? AND user_id = ?').run(chat, user);
  }

  spaceFor(user) {
    const space = this.db.prepare(`
      SELECT s.id, s.invite, s.group_chat AS groupChat,
        (SELECT COUNT(*) FROM members WHERE space_id = s.id) AS memberCount
      FROM members AS m JOIN spaces AS s ON s.id = m.space_id WHERE m.user_id = ?
    `).get(user);
    return space ?? null;
  }

  joinOrCreate(user, invite = '', confirmedSpace = null) {
    return this.transaction(() => {
      const current = this.spaceFor(user);
      if (!invite) {
        if (current) return current;
        const { lastInsertRowid } = this.db.prepare('INSERT INTO spaces (invite) VALUES (?)')
          .run(randomBytes(18).toString('base64url'));
        this.db.prepare('INSERT INTO members VALUES (?, ?, 1)').run(user, lastInsertRowid);
        return this.spaceFor(user);
      }

      const target = this.db.prepare('SELECT id FROM spaces WHERE invite = ?').get(invite);
      if (!target) {
        const accepted = this.db.prepare('SELECT space_id AS space FROM accepted_invites WHERE token = ?').get(invite);
        if (accepted && current?.id === accepted.space) return current;
        throw new InputError('Приглашение уже использовано или ссылка неверна.');
      }
      if (current?.id === target.id) return current;
      if (current?.memberCount === 2) {
        throw new InputError('Вы уже в пространстве с партнёром. Текущее пространство и задачи сохранены.');
      }
      if (current && confirmedSpace === null) {
        const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE space_id = ?').get(current.id);
        return { ...current, pendingJoin: { token: invite, taskCount: count } };
      }
      if (confirmedSpace !== null && current?.id !== confirmedSpace) {
        throw new InputError('Ваше пространство изменилось. Откройте приглашение ещё раз.');
      }
      if (current) this.#moveSoloSpace(current.id, target.id, user);
      else this.db.prepare('INSERT INTO members VALUES (?, ?, 2)').run(user, target.id);
      this.db.prepare('UPDATE spaces SET invite = NULL WHERE id = ?').run(target.id);
      this.db.prepare('INSERT INTO accepted_invites (token, space_id) VALUES (?, ?)').run(invite, target.id);
      return this.spaceFor(user);
    });
  }

  #moveSoloSpace(source, target, user) {
    const labels = this.catalog(source);
    const names = { category: new Map(), tag: new Map() };
    const keepAppearance = this.db.prepare('UPDATE labels SET color = COALESCE(color, ?), icon = COALESCE(icon, ?) WHERE id = ?');
    for (const label of [...labels.categories, ...labels.tags]) {
      const destination = this.#registerLabel(target, label.kind, label.name);
      names[label.kind].set(label.name, destination.name);
      keepAppearance.run(label.color, label.icon, destination.id);
    }
    const tasks = this.db.prepare('SELECT id, category, tags FROM tasks WHERE space_id = ?').all(source);
    const relabel = this.db.prepare('UPDATE tasks SET category = ?, tags = ? WHERE id = ?');
    for (const task of tasks) {
      const category = names.category.get(task.category) ?? task.category;
      const tags = JSON.parse(task.tags).map((name) => names.tag.get(name) ?? name);
      relabel.run(category, JSON.stringify(tags), task.id);
    }
    this.db.prepare(`UPDATE tasks AS moving SET source = NULL
      WHERE space_id = ? AND source IS NOT NULL AND EXISTS
      (SELECT 1 FROM tasks AS existing WHERE existing.space_id = ? AND existing.source = moving.source)`).run(source, target);
    this.db.prepare('UPDATE tasks SET space_id = ?, version = version + 1 WHERE space_id = ?').run(target, source);
    this.db.prepare('UPDATE voice_jobs SET space_id = ? WHERE space_id = ?').run(target, source);
    this.db.prepare('UPDATE members SET space_id = ?, slot = 2 WHERE user_id = ? AND space_id = ?').run(target, user, source);
    this.db.prepare('DELETE FROM labels WHERE space_id = ?').run(source);
    this.db.prepare('UPDATE spaces SET invite = NULL, group_chat = NULL WHERE id = ?').run(source);
  }

  linkGroup(space, chat) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT group_chat AS groupChat FROM spaces WHERE id = ?').get(space);
      const owner = this.db.prepare('SELECT id FROM spaces WHERE group_chat = ?').get(chat);
      if (current.groupChat !== null && current.groupChat !== chat) {
        throw new InputError('Сначала отвяжите текущий чат командой /unlink в личном чате.');
      }
      if (owner && owner.id !== space) throw new InputError('Этот чат уже подключён к другому пространству.');
      this.db.prepare('UPDATE spaces SET group_chat = ? WHERE id = ?').run(chat, space);
    });
  }

  unlinkGroup(space) {
    this.db.prepare('UPDATE spaces SET group_chat = NULL WHERE id = ?').run(space);
  }

  migrateGroup(from, to) {
    this.db.prepare('UPDATE spaces SET group_chat = ? WHERE group_chat = ? AND NOT EXISTS (SELECT 1 FROM spaces WHERE group_chat = ?)')
      .run(to, from, to);
  }

  #migrateSchema() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 4) return;
    const { sql } = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
    const rebuildTasks = !/\bAUTOINCREMENT\b/i.test(sql);
    if (rebuildTasks) this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version >= 4) return;
        if (version < 2) {
          if (!this.db.prepare('PRAGMA table_info(tasks)').all().some(({ name }) => name === 'importance')) {
            this.db.exec(`ALTER TABLE tasks ADD COLUMN importance TEXT NOT NULL DEFAULT 'low'
              CHECK (importance IN ('low', 'medium', 'high', 'global'))`);
          }
          this.db.exec('ALTER TABLE labels ADD COLUMN icon TEXT');
          if (version < 1) this.#migrateLabels();
        } else if (version === 2) {
          this.db.exec(`
            UPDATE tasks AS child
            SET category = COALESCE(child.category, (SELECT parent.category FROM tasks AS parent WHERE parent.id = child.parent_id)),
              version = version + 1
            WHERE child.parent_id IS NOT NULL;
          `);
        }
        if (rebuildTasks) this.#migrateTaskIds();
        this.db.exec('PRAGMA user_version = 4');
      });
    } finally {
      if (rebuildTasks) this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  #migrateTaskIds() {
    const columns = 'id, space_id, title, status, period, category, tags, parent_id, created_by, created_at, completed_at, version, source, importance';
    this.db.exec(`
      ${taskTable('new_tasks')}
      INSERT INTO new_tasks (${columns}) SELECT ${columns} FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE new_tasks RENAME TO tasks;
    `);
    if (this.db.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('Не удалось перенести задачи: нарушены связи в базе.');
    }
  }

  #migrateLabels() {
    const tasks = this.db.prepare("SELECT id, space_id AS space, category, tags FROM tasks WHERE category IS NOT NULL OR tags != '[]' ORDER BY id").all();
    const update = this.db.prepare('UPDATE tasks SET category = ?, tags = ?, version = version + 1 WHERE id = ?');
    for (const task of tasks) {
      const category = task.category ? this.#registerLabel(task.space, 'category', task.category).name : null;
      const tags = JSON.stringify(this.#namesForTags(task.space, cleanTags(JSON.parse(task.tags))));
      if (category !== task.category || tags !== task.tags) update.run(category, tags, task.id);
    }
  }

  #registerLabel(space, kind, value) {
    const name = labelName(kind, value);
    const key = labelKey(name);
    this.db.prepare('INSERT INTO labels (space_id, kind, name, name_key) VALUES (?, ?, ?, ?) ON CONFLICT (space_id, kind, name_key) DO NOTHING')
      .run(space, kind, name, key);
    return this.db.prepare('SELECT id, kind, name, color, icon FROM labels WHERE space_id = ? AND kind = ? AND name_key = ?')
      .get(space, kind, key);
  }

  #labelById(space, id) {
    if (!isId(id)) throw new InputError('Некорректный номер категории или тега.');
    const label = this.db.prepare('SELECT id, kind, name, color, icon FROM labels WHERE space_id = ? AND id = ?').get(space, id);
    if (!label) throw new InputError('Категория или тег уже удалены либо недоступны.', 404);
    return label;
  }

  #chosenLabel(space, kind, choice) {
    if (!choice || Array.isArray(choice) || typeof choice !== 'object') throw new InputError('Выберите значение из списка.');
    if (!('id' in choice)) return this.#registerLabel(space, kind, choice.name).name;
    const label = this.#labelById(space, choice.id);
    if (label.kind !== kind) throw new InputError('Выберите значение из нужного списка.');
    return label.name;
  }

  #categoryFromInput(space, input, fallback) {
    if ('categoryChoice' in input) {
      return input.categoryChoice === null ? null : this.#chosenLabel(space, 'category', input.categoryChoice);
    }
    if ('category' in input) {
      const name = input.category === null ? '' : cleanText(input.category, 60, 'Категория');
      return name ? this.#registerLabel(space, 'category', name).name : null;
    }
    return fallback;
  }

  #namesForTags(space, names) {
    return [...new Set(names.map((name) => this.#registerLabel(space, 'tag', name).name))];
  }

  catalog(space) {
    const labels = this.db.prepare('SELECT id, kind, name, color, icon FROM labels WHERE space_id = ?').all(space)
      .sort((first, second) => first.name.localeCompare(second.name, 'ru'));
    return {
      categories: labels.filter(({ kind }) => kind === 'category'),
      tags: labels.filter(({ kind }) => kind === 'tag'),
    };
  }

  createLabel(space, { kind, name }) {
    return this.transaction(() => this.#registerLabel(space, kind, name));
  }

  updateLabel(space, id, patch) {
    return this.transaction(() => {
      const label = this.#labelById(space, id);
      if ('color' in patch) label.color = labelColor(patch.color);
      if ('icon' in patch) {
        if (label.kind !== 'category' || typeof patch.icon !== 'string' || !Object.hasOwn(categoryIcons, patch.icon)) {
          throw new InputError('Выберите иконку категории.');
        }
        label.icon = patch.icon;
      }
      this.db.prepare('UPDATE labels SET color = ?, icon = ? WHERE space_id = ? AND id = ?')
        .run(label.color, label.icon, space, id);
      return this.#labelById(space, id);
    });
  }

  deleteLabel(space, id) {
    return this.transaction(() => {
      const { kind, name } = this.#labelById(space, id);
      if (kind === 'category') {
        this.db.prepare('UPDATE tasks SET category = NULL, version = version + 1 WHERE space_id = ? AND category = ?')
          .run(space, name);
      } else {
        const tasks = this.db.prepare('SELECT id, tags FROM tasks WHERE space_id = ? AND EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE value = ?)')
          .all(space, name);
        const update = this.db.prepare('UPDATE tasks SET tags = ?, version = version + 1 WHERE space_id = ? AND id = ?');
        for (const task of tasks) {
          const remaining = JSON.parse(task.tags).filter((tag) => tag !== name);
          update.run(JSON.stringify(remaining), space, task.id);
        }
      }
      this.db.prepare('DELETE FROM labels WHERE space_id = ? AND id = ?').run(space, id);
    });
  }

  findTask(space, id) {
    if (!isId(id)) throw new InputError('Некорректный номер задачи.');
    const row = this.db.prepare(`${taskFields} WHERE t.space_id = ? AND t.id = ?`).get(space, id);
    return row ? asTask(row) : null;
  }

  task(space, id) {
    const task = this.findTask(space, id);
    if (!task) throw new InputError('Задача не найдена.', 404);
    return task;
  }

  children(space, id) {
    return this.db.prepare(`${taskFields} WHERE t.space_id = ? AND t.parent_id = ? ORDER BY t.id`)
      .all(space, id).map(asTask);
  }

  #insertTask(space, user, { title, parentId = null, period = null, category = null, source = null }) {
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO tasks (space_id, title, parent_id, period, category, created_by, created_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(space, title, parentId, period, category, user, new Date().toISOString(), source);
    return Number(lastInsertRowid);
  }

  createTask(space, user, input, source = null) {
    const { title, parentId = null, period = null } = input;
    const name = taskTitle(title);
    return this.transaction(() => {
      if (source) {
        const existing = this.db.prepare('SELECT id FROM tasks WHERE space_id = ? AND source = ?').get(space, source);
        if (existing) return this.task(space, existing.id);
      }
      const parent = parentId === null ? null : this.task(space, parentId);
      if (parent && parent.parentId !== null) {
        throw new InputError('Подзадачу можно добавить только к задаче верхнего уровня.');
      }
      const category = this.#categoryFromInput(space, input, parent?.category ?? null);
      const taskPeriod = period === null ? null : exactPeriod(period);
      return this.task(space, this.#insertTask(space, user, { title: name, parentId, period: taskPeriod, category, source }));
    });
  }

  queueVoice(space, user, chat, message, fileId) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM voice_jobs WHERE chat_id = ? AND message_id = ?').get(chat, message)) return;
      const { total, byUser } = this.db.prepare('SELECT COUNT(*) AS total, COUNT(CASE WHEN user_id = ? THEN 1 END) AS byUser FROM voice_jobs WHERE file_id IS NOT NULL')
        .get(user);
      if (total >= 8 || byUser >= 2) {
        throw new InputError('Сейчас распознаю другие записи. Отправьте голосовое чуть позже.');
      }
      this.db.prepare('INSERT INTO voice_jobs (space_id, user_id, chat_id, message_id, file_id) VALUES (?, ?, ?, ?, ?)')
        .run(space, user, chat, message, fileId);
    });
  }

  pendingVoice() {
    return this.db.prepare('SELECT id, space_id AS space, user_id AS user, chat_id AS chat, message_id AS message, file_id AS fileId FROM voice_jobs WHERE file_id IS NOT NULL ORDER BY id LIMIT 1')
      .get();
  }

  completeVoice(job, titles) {
    return this.transaction(() => {
      const { space } = this.db.prepare('SELECT space_id AS space FROM voice_jobs WHERE id = ? AND file_id IS NOT NULL').get(job.id) ?? {};
      if (space === undefined) return [];
      this.db.prepare('UPDATE voice_jobs SET file_id = NULL WHERE id = ?').run(job.id);
      const tasks = [];
      for (const [index, title] of [...titles.entries()].reverse()) {
        const source = ['voice', job.chat, job.message, index].join(':');
        const id = this.#insertTask(space, job.user, { title: taskTitle(title), source });
        tasks.push(this.task(space, id));
      }
      return tasks.reverse();
    });
  }

  deleteSubtask(space, id, version) {
    this.transaction(() => {
      const task = this.task(space, id);
      if (task.version !== version) throw new InputError('Подзадача уже изменилась. Откройте её заново.', 409);
      if (task.parentId === null) throw new InputError('Удаление доступно только для подзадач.');
      this.db.prepare('DELETE FROM tasks WHERE id = ? AND space_id = ?').run(id, space);
    });
  }

  updateTask(space, id, patch) {
    return this.transaction(() => {
      const task = this.task(space, id);
      if (task.version !== patch.version) {
        throw new InputError('Задача уже изменилась. Откройте её заново.', 409);
      }
      if ('parentId' in patch && patch.parentId !== task.parentId) {
        if (patch.parentId !== null) {
          if (patch.parentId === id) throw new InputError('Задача не может быть своим родителем.');
          if (this.task(space, patch.parentId).parentId !== null || this.children(space, id).length) {
            throw new InputError('Доступен один уровень подзадач.');
          }
        }
        task.parentId = patch.parentId;
      }
      if ('importance' in patch) {
        if (typeof patch.importance !== 'string' || !Object.hasOwn(importanceLevels, patch.importance)) {
          throw new InputError('Выберите важность задачи.');
        }
        task.importance = patch.importance;
      }
      if (task.parentId !== null && task.importance === 'global') {
        throw new InputError('Глобальная важность доступна только задачам верхнего уровня.');
      }
      if ('title' in patch) task.title = taskTitle(patch.title);
      if ('status' in patch) {
        if (typeof patch.status !== 'string' || !Object.hasOwn(statuses, patch.status)) {
          throw new InputError('Выберите статус задачи.');
        }
        if (task.status !== patch.status) {
          if (patch.status === 'done' && patch.confirmWithActiveSubtasks !== true) {
            const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE space_id = ? AND parent_id = ? AND status = 'active'")
              .get(space, id);
            if (count) {
              const warning = new InputError('У задачи остались активные подзадачи.', 422);
              warning.activeSubtasks = count;
              throw warning;
            }
          }
          task.status = patch.status;
          task.completedAt = task.status === 'done' ? new Date().toISOString() : null;
        }
      }
      if ('period' in patch) task.period = patch.period === null ? null : exactPeriod(patch.period);
      task.category = this.#categoryFromInput(space, patch, task.category);
      if ('tagChoices' in patch) {
        if (!Array.isArray(patch.tagChoices) || patch.tagChoices.length > 20) {
          throw new InputError('Добавьте до 20 тегов.');
        }
        task.tags = [...new Set(patch.tagChoices.map((choice) => this.#chosenLabel(space, 'tag', choice)))];
      } else if ('tags' in patch) {
        task.tags = this.#namesForTags(space, cleanTags(patch.tags));
      }
      this.db.prepare(`
        UPDATE tasks SET title = ?, status = ?, period = ?, category = ?, importance = ?, tags = ?, parent_id = ?,
          completed_at = ?, version = version + 1 WHERE space_id = ? AND id = ?
      `).run(task.title, task.status, task.period, task.category, task.importance, JSON.stringify(task.tags),
        task.parentId, task.completedAt, space, id);
      return this.task(space, id);
    });
  }

  list(space, { scope = 'all', status = 'all', query = '', category = '', tag = '', importance = '' } = {}) {
    parseScope(scope);
    if (status !== 'all' && !Object.hasOwn(statuses, status)) throw new InputError('Выберите статус задачи.');
    const filters = ['t.space_id = ?'];
    const args = [space];
    if (scope === 'none') filters.push('t.period IS NULL');
    else if (scope !== 'all') {
      filters.push(scope.length === 4 ? 'substr(t.period, 1, 4) = ?' : 't.period = ?');
      args.push(scope);
    }
    if (status !== 'all') {
      filters.push('t.status = ?');
      args.push(status);
    }
    if (importance) {
      if (!Object.hasOwn(importanceLevels, importance)) throw new InputError('Выберите важность задачи.');
      filters.push('t.importance = ?');
      args.push(importance);
    }
    const term = query.trim().toLowerCase();
    const rows = this.db.prepare(`${taskFields} WHERE ${filters.join(' AND ')} ORDER BY t.id DESC`).all(...args);
    return rows.map(asTask).filter((task) =>
      (!term || task.title.toLowerCase().includes(term)) &&
      (!category || task.category && labelKey(task.category) === labelKey(category)) &&
      (!tag || task.tags.some((name) => labelKey(name) === labelKey(tag))));
  }
}
