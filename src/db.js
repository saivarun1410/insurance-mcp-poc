import pg from 'pg';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgres://insurance:insurance@localhost:55432/insurance';

export const pool = new pg.Pool({ connectionString: CONNECTION_STRING, max: 4 });

export async function query(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}
