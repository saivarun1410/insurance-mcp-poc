// docker compose reports the container up before Postgres finishes its init scripts.
import { pool } from '../src/db.js';

const DEADLINE_MS = 60_000;
const start = Date.now();

while (true) {
  try {
    await pool.query('SELECT 1 FROM policy_documents LIMIT 1');
    console.log('Database ready.');
    await pool.end();
    process.exit(0);
  } catch (error) {
    if (Date.now() - start > DEADLINE_MS) {
      console.error(`Database not ready after ${DEADLINE_MS / 1000}s: ${error.message}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
