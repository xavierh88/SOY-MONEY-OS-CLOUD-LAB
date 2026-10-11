import { pool } from "@workspace/db";

export async function acquireSportsCheck(
  name: string,
  intervalHours: number
): Promise<boolean> {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sports_worker_checks (
        name TEXT PRIMARY KEY,
        last_check TIMESTAMPTZ NOT NULL
      )
    `);

    const result = await client.query(
      `INSERT INTO sports_worker_checks (name, last_check)
       VALUES ($1, NOW())
       ON CONFLICT (name)
       DO UPDATE SET last_check = NOW()
       WHERE sports_worker_checks.last_check <
         NOW() - ($2::double precision * INTERVAL '1 hour')
       RETURNING name`,
      [name, intervalHours]
    );

    return result.rowCount === 1;
  } finally {
    client.release();
  }
}
