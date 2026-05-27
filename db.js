const { Pool } = require('pg');

const DEFAULT_DATABASE_URL = 'postgresql://minigame:minigame@localhost:5432/minigame';
const connectionString = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

function sslConfig() {
  const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
  const pgSsl = (process.env.PGSSL || '').toLowerCase();

  if (sslMode === 'disable' || pgSsl === 'false') return false;
  if (sslMode === 'require' || pgSsl === 'true') return { rejectUnauthorized: false };
  if (connectionString.includes('sslmode=require')) return { rejectUnauthorized: false };

  return false;
}

const pool = new Pool({
  connectionString,
  ssl: sslConfig(),
  max: parseInt(process.env.PGPOOL_MAX || '10', 10),
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plays (
      id BIGSERIAL PRIMARY KEY,
      play_no INTEGER NOT NULL,
      ip_hash TEXT NOT NULL UNIQUE,
      result TEXT NOT NULL CHECK (result IN ('win', 'lose')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign (
      id INTEGER PRIMARY KEY,
      max_plays INTEGER NOT NULL DEFAULT 600,
      max_winners INTEGER NOT NULL DEFAULT 10,
      remaining_winners INTEGER NOT NULL DEFAULT 10
    )
  `);

  await pool.query(`
    INSERT INTO settings(key, value)
    VALUES ('max_plays', '600'), ('max_winners', '10')
    ON CONFLICT(key) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO campaign(id, max_plays, max_winners, remaining_winners)
    VALUES (1, 600, 10, 10)
    ON CONFLICT(id) DO NOTHING
  `);
}

module.exports = {
  pool,
  initDatabase,
};
