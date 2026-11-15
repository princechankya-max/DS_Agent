import { closeDB, initDB } from './database.js';

try {
  await initDB();
} finally {
  await closeDB();
}
