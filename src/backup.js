import { existsSync, realpathSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';

const destination = process.argv[2];
if (!destination) throw new Error('Укажите путь к копии: npm run backup -- путь-к-копии.sqlite');
const source = realpathSync(process.env.DATABASE_PATH || 'data/we-do.sqlite');
if (existsSync(destination)) throw new Error('Укажите имя нового файла для резервной копии.');
const database = new DatabaseSync(source, { readOnly: true });
try {
  await backup(database, destination);
  console.log('Резервная копия создана.');
} finally {
  database.close();
}
