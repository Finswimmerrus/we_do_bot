import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exactPeriod, InputError, parseScope } from './periods.js';

export const statuses = { active: 'Активна', done: 'Выполнена', obsolete: 'Неактуальна' };

const taskFields = `
  SELECT t.id, t.title, t.status, t.period, t.category, t.tags, t.parent_id AS parentId,
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
    `);
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
      const { lastInsertRowid } = this.db.prepare(`
        INSERT INTO tasks (space_id, title, parent_id, created_by, created_at, source) VALUES (?, ?, ?, ?, ?, ?)
      `).run(space, name, parentId, user, new Date().toISOString(), source);
      return this.task(space, Number(lastInsertRowid));
    });
  }

  updateTask(space, id, patch) {
    return this.transaction(() => {
      const task = this.task(space, id);
      if (task.version !== patch.version) {
        throw new InputError('Задача уже изменилась. Откройте её заново.', 409);
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
      if ('period' in patch) task.period = patch.period === null ? null : exactPeriod(patch.period);
      if ('category' in patch) {
        task.category = patch.category === null ? null : cleanText(patch.category, 60, 'Категория') || null;
      }
      if ('tags' in patch) task.tags = cleanTags(patch.tags);
      if ('parentId' in patch && patch.parentId !== task.parentId) {
        if (patch.parentId !== null) {
          if (patch.parentId === id) throw new InputError('Задача не может быть своим родителем.');
          if (this.task(space, patch.parentId).parentId !== null || this.children(space, id).length) {
            throw new InputError('Доступен один уровень подзадач.');
          }
        }
        task.parentId = patch.parentId;
      }
      this.db.prepare(`
        UPDATE tasks SET title = ?, status = ?, period = ?, category = ?, tags = ?, parent_id = ?,
          completed_at = ?, version = version + 1 WHERE space_id = ? AND id = ?
      `).run(task.title, task.status, task.period, task.category, JSON.stringify(task.tags),
        task.parentId, task.completedAt, space, id);
      return this.task(space, id);
    });
  }

  list(space, { scope = 'all', status = 'all', query = '', category = '', tag = '' } = {}) {
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
    const term = query.trim().toLowerCase();
    const rows = this.db.prepare(`${taskFields} WHERE ${filters.join(' AND ')} ORDER BY t.id DESC`).all(...args);
    return rows.map(asTask).filter((task) =>
      (!term || task.title.toLowerCase().includes(term)) &&
      (!category || task.category?.toLowerCase() === category.toLowerCase()) &&
      (!tag || task.tags.some((name) => name.toLowerCase() === tag.toLowerCase())));
  }
}
