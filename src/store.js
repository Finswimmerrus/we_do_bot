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

const taskPeriod = 'CASE WHEN p.id IS NULL THEN t.period ELSE p.period END';
const taskCategory = 'CASE WHEN p.id IS NULL THEN t.category ELSE p.category END';
const taskFields = `
  SELECT t.id, t.title, t.status, ${taskPeriod} AS period, ${taskCategory} AS category,
    t.importance, t.tags, t.parent_id AS parentId,
    p.title AS parentTitle, t.created_by AS createdBy, t.created_at AS createdAt,
    t.completed_at AS completedAt, t.version
  FROM tasks AS t LEFT JOIN tasks AS p ON p.id = t.parent_id
`;

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
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
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
        UNIQUE (space_id, source),
        UNIQUE (space_id, id),
        FOREIGN KEY (space_id, parent_id) REFERENCES tasks(space_id, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_by_period ON tasks(space_id, period, status);
      CREATE INDEX IF NOT EXISTS tasks_by_parent ON tasks(space_id, parent_id);
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
    `);
    this.#migrateSchema();
  }

  close() {
    this.db.close();
  }

  transaction(action) {
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

  spaceFor(user) {
    const space = this.db.prepare(`
      SELECT s.id, s.invite, s.group_chat AS groupChat,
        (SELECT COUNT(*) FROM members WHERE space_id = s.id) AS memberCount
      FROM members AS m JOIN spaces AS s ON s.id = m.space_id WHERE m.user_id = ?
    `).get(user);
    return space ?? null;
  }

  joinOrCreate(user, invite = '') {
    return this.transaction(() => {
      const current = this.spaceFor(user);
      if (current) return current;

      if (invite) {
        const target = this.db.prepare('SELECT id FROM spaces WHERE invite = ?').get(invite);
        if (!target) throw new InputError('Приглашение уже использовано или ссылка неверна.');
        this.db.prepare('INSERT INTO members VALUES (?, ?, 2)').run(user, target.id);
        this.db.prepare('UPDATE spaces SET invite = NULL WHERE id = ?').run(target.id);
      } else {
        const { lastInsertRowid } = this.db.prepare('INSERT INTO spaces (invite) VALUES (?)')
          .run(randomBytes(18).toString('base64url'));
        this.db.prepare('INSERT INTO members VALUES (?, ?, 1)').run(user, lastInsertRowid);
      }
      return this.spaceFor(user);
    });
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
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 2) return;
    this.transaction(() => {
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version >= 2) return;
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN importance TEXT NOT NULL DEFAULT 'low'
          CHECK (importance IN ('low', 'medium', 'high', 'global'));
        ALTER TABLE labels ADD COLUMN icon TEXT;
      `);
      if (version < 1) this.#migrateLabels();
      this.db.prepare('UPDATE tasks SET version = version + 1 WHERE parent_id IS NOT NULL').run();
      this.db.exec('PRAGMA user_version = 2');
    });
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
        this.db.prepare(`UPDATE tasks SET version = version + 1
          WHERE space_id = ? AND category IS NOT ? AND parent_id IN
          (SELECT id FROM tasks WHERE space_id = ? AND parent_id IS NULL AND category = ?)`)
          .run(space, name, space, name);
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

  task(space, id) {
    if (!isId(id)) throw new InputError('Некорректный номер задачи.');
    const row = this.db.prepare(`${taskFields} WHERE t.space_id = ? AND t.id = ?`).get(space, id);
    if (!row) throw new InputError('Задача не найдена.', 404);
    return asTask(row);
  }

  children(space, id) {
    return this.db.prepare(`${taskFields} WHERE t.space_id = ? AND t.parent_id = ? ORDER BY t.id`)
      .all(space, id).map(asTask);
  }

  #insertTask(space, user, title, parentId, source) {
    const { lastInsertRowid } = this.db.prepare('INSERT INTO tasks (space_id, title, parent_id, created_by, created_at, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(space, title, parentId, user, new Date().toISOString(), source);
    return Number(lastInsertRowid);
  }

  createTask(space, user, { title, parentId = null }, source = null) {
    const name = taskTitle(title);
    return this.transaction(() => {
      if (source) {
        const existing = this.db.prepare('SELECT id FROM tasks WHERE space_id = ? AND source = ?').get(space, source);
        if (existing) return this.task(space, existing.id);
      }
      if (parentId !== null && this.task(space, parentId).parentId !== null) {
        throw new InputError('Подзадачу можно добавить только к задаче верхнего уровня.');
      }
      return this.task(space, this.#insertTask(space, user, name, parentId, source));
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
      const result = this.db.prepare('UPDATE voice_jobs SET file_id = NULL WHERE id = ? AND file_id IS NOT NULL').run(job.id);
      if (!result.changes) return [];
      const tasks = [];
      for (const [index, title] of [...titles.entries()].reverse()) {
        const source = ['voice', job.chat, job.message, index].join(':');
        const id = this.#insertTask(job.space, job.user, taskTitle(title), null, source);
        tasks.push(this.task(job.space, id));
      }
      return tasks.reverse();
    });
  }

  updateTask(space, id, patch) {
    return this.transaction(() => {
      const task = this.task(space, id);
      if (task.version !== patch.version) {
        throw new InputError('Задача уже изменилась. Откройте её заново.', 409);
      }
      const previousPeriod = task.period;
      const previousCategory = task.category;
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
          task.status = patch.status;
          task.completedAt = task.status === 'done' ? new Date().toISOString() : null;
        }
      }
      if (task.parentId !== null) {
        if ('period' in patch || 'categoryChoice' in patch || 'category' in patch) {
          throw new InputError('Период и категория подзадачи задаются в карточке родителя.');
        }
        task.period = null;
        task.category = null;
      } else {
        if ('period' in patch) task.period = patch.period === null ? null : exactPeriod(patch.period);
        if ('categoryChoice' in patch) {
          task.category = patch.categoryChoice === null ? null : this.#chosenLabel(space, 'category', patch.categoryChoice);
        } else if ('category' in patch) {
          const name = patch.category === null ? '' : cleanText(patch.category, 60, 'Категория');
          task.category = name ? this.#registerLabel(space, 'category', name).name : null;
        }
      }
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
      if (task.parentId === null && (task.period !== previousPeriod || task.category !== previousCategory)) {
        this.db.prepare('UPDATE tasks SET version = version + 1 WHERE space_id = ? AND parent_id = ?').run(space, id);
      }
      return this.task(space, id);
    });
  }

  list(space, { scope = 'all', status = 'all', query = '', category = '', tag = '', importance = '' } = {}) {
    parseScope(scope);
    if (status !== 'all' && !Object.hasOwn(statuses, status)) throw new InputError('Выберите статус задачи.');
    const filters = ['t.space_id = ?'];
    const args = [space];
    if (scope === 'none') filters.push(`(${taskPeriod}) IS NULL`);
    else if (scope !== 'all') {
      filters.push(scope.length === 4 ? `substr((${taskPeriod}), 1, 4) = ?` : `(${taskPeriod}) = ?`);
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
