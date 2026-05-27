const { pool, initDatabase } = require('./db');

initDatabase()
  .then(async () => {
    console.log('PostgreSQL schema is ready.');
    await pool.end();
  })
  .catch(async (err) => {
    console.error('Failed to initialize PostgreSQL schema:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
