const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { pool, initDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_MAX_PLAYS = 600;
const DEFAULT_MAX_WINNERS = 10;
const ADMIN_USER = process.env.ADMIN_USER || 'admid';
const ADMIN_PASS = process.env.ADMIN_PASS || 'bantudethuong';

app.set('trust proxy', true);
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required');
  }

  let creds;
  try {
    creds = Buffer.from(auth.split(' ')[1], 'base64').toString('utf8');
  } catch (e) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(400).send('Bad Authorization header');
  }

  const separator = creds.indexOf(':');
  const user = separator >= 0 ? creds.slice(0, separator) : creds;
  const pass = separator >= 0 ? creds.slice(separator + 1) : '';

  if ((user === ADMIN_USER || user === 'admin') && pass === ADMIN_PASS) return next();

  res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
  return res.status(403).send('Forbidden');
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip)).digest('hex');
}

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}

async function getCampaign(client = pool) {
  const { rows } = await client.query(`
    SELECT
      max_plays AS "maxPlays",
      max_winners AS "maxWinners",
      remaining_winners AS "remainingWinners"
    FROM campaign
    WHERE id = 1
  `);
  return rows[0] || null;
}

async function getSettings() {
  const camp = await getCampaign();
  if (camp) {
    return {
      maxPlays: Number(camp.maxPlays ?? DEFAULT_MAX_PLAYS),
      maxWinners: Number(camp.maxWinners ?? DEFAULT_MAX_WINNERS),
    };
  }

  const [maxPlaysV, maxWinnersV] = await Promise.all([
    getSetting('max_plays'),
    getSetting('max_winners'),
  ]);

  return {
    maxPlays: maxPlaysV ? parseInt(maxPlaysV, 10) : DEFAULT_MAX_PLAYS,
    maxWinners: maxWinnersV ? parseInt(maxWinnersV, 10) : DEFAULT_MAX_WINNERS,
  };
}

async function setCampaign(maxPlays, maxWinners) {
  await pool.query(`
    INSERT INTO campaign(id, max_plays, max_winners, remaining_winners)
    VALUES(1, $1, $2, $2)
    ON CONFLICT(id) DO UPDATE SET
      max_plays = EXCLUDED.max_plays,
      max_winners = EXCLUDED.max_winners,
      remaining_winners = EXCLUDED.remaining_winners
  `, [maxPlays, maxWinners]);
}

async function getCounts() {
  const [{ rows: totalRows }, { rows: winnerRows }] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS total FROM plays'),
    pool.query("SELECT COUNT(*)::int AS winners FROM plays WHERE result = 'win'"),
  ]);

  return {
    total: totalRows[0] ? totalRows[0].total : 0,
    winners: winnerRows[0] ? winnerRows[0].winners : 0,
  };
}

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
});

app.post('/api/play', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  const ipHash = hashIp(ip);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM plays WHERE ip_hash = $1', [ipHash]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.json({ result: 'already_played' });
    }

    const campaignResult = await client.query(`
      SELECT
        max_plays AS "maxPlays",
        max_winners AS "maxWinners",
        remaining_winners AS "remainingWinners"
      FROM campaign
      WHERE id = 1
      FOR UPDATE
    `);

    const campaign = campaignResult.rows[0] || {
      maxPlays: DEFAULT_MAX_PLAYS,
      maxWinners: DEFAULT_MAX_WINNERS,
      remainingWinners: DEFAULT_MAX_WINNERS,
    };

    const [{ rows: totalRows }, { rows: winnerRows }] = await Promise.all([
      client.query('SELECT COUNT(*)::int AS total FROM plays'),
      client.query("SELECT COUNT(*)::int AS winners FROM plays WHERE result = 'win'"),
    ]);

    const totalPlays = totalRows[0] ? totalRows[0].total : 0;
    const totalWinners = winnerRows[0] ? winnerRows[0].winners : 0;
    const maxPlays = Number(campaign.maxPlays ?? DEFAULT_MAX_PLAYS);
    const maxWinners = Number(campaign.maxWinners ?? DEFAULT_MAX_WINNERS);
    const remainingPlays = maxPlays - totalPlays;
    const remainingPrizes = Number(
      campaign.remainingWinners ?? Math.max(0, maxWinners - totalWinners)
    );

    if (remainingPlays <= 0 || remainingPrizes <= 0) {
      await client.query('ROLLBACK');
      return res.json({ result: 'ended', noPrizes: remainingPrizes <= 0 });
    }

    let winProbability = remainingPrizes / remainingPlays;
    winProbability = Math.max(0, Math.min(1, winProbability));

    let finalResult = Math.random() < winProbability ? 'win' : 'lose';

    if (finalResult === 'win') {
      const update = await client.query(`
        UPDATE campaign
        SET remaining_winners = remaining_winners - 1
        WHERE id = 1 AND remaining_winners > 0
        RETURNING remaining_winners
      `);

      if (update.rowCount === 0) {
        finalResult = 'lose';
      }
    }

    await client.query(`
      INSERT INTO plays (play_no, ip_hash, result, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [totalPlays + 1, ipHash, finalResult]);

    await client.query('COMMIT');
    return res.json({ result: finalResult });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') {
      return res.json({ result: 'already_played' });
    }
    console.error('Play error:', e);
    return res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db' });
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    let { maxPlays, maxWinners } = payload;

    if (typeof maxPlays === 'string' && maxPlays.trim() !== '') maxPlays = parseInt(maxPlays, 10);
    if (typeof maxWinners === 'string' && maxWinners.trim() !== '') maxWinners = parseInt(maxWinners, 10);

    const current = await getSettings();
    const newMaxPlays = typeof maxPlays === 'number' ? Math.max(0, Math.floor(maxPlays)) : current.maxPlays;
    const newMaxWinners = typeof maxWinners === 'number' ? Math.max(0, Math.floor(maxWinners)) : current.maxWinners;

    if (!Number.isFinite(newMaxPlays) || newMaxPlays < 0) return res.status(400).json({ error: 'invalid_maxPlays' });
    if (!Number.isFinite(newMaxWinners) || newMaxWinners < 0) return res.status(400).json({ error: 'invalid_maxWinners' });

    await setCampaign(newMaxPlays, Math.min(newMaxWinners, newMaxPlays));

    res.json({ ok: true, settings: await getSettings() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db' });
  }
});

app.delete('/api/admin/play/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query('DELETE FROM plays WHERE id = $1 RETURNING result', [id]);
    if (deleted.rows[0] && deleted.rows[0].result === 'win') {
      await client.query(`
        UPDATE campaign
        SET remaining_winners = LEAST(remaining_winners + 1, max_winners)
        WHERE id = 1
      `);
    }
    await client.query('COMMIT');
    res.json({ ok: true, deleted: deleted.rowCount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'db' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/user/:ipHash', requireAdmin, async (req, res) => {
  const { ipHash } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const deleted = await client.query('DELETE FROM plays WHERE ip_hash = $1 RETURNING result', [ipHash]);
    const restoredWins = deleted.rows.filter((row) => row.result === 'win').length;
    if (restoredWins > 0) {
      await client.query(`
        UPDATE campaign
        SET remaining_winners = LEAST(remaining_winners + $1, max_winners)
        WHERE id = 1
      `, [restoredWins]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, deleted: deleted.rowCount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'db' });
  } finally {
    client.release();
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const counts = await getCounts();
    const settings = await getSettings();
    const camp = await getCampaign();
    const remaining = camp && camp.remainingWinners != null
      ? Math.max(0, Number(camp.remainingWinners))
      : Math.max(0, settings.maxWinners - counts.winners);

    res.json({
      total: counts.total,
      winners: counts.winners,
      remaining,
      maxPlays: settings.maxPlays,
      maxWinners: settings.maxWinners,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [{ rows: plays }, counts, settings, camp] = await Promise.all([
      pool.query('SELECT id, play_no, ip_hash, result, created_at FROM plays ORDER BY id ASC'),
      getCounts(),
      getSettings(),
      getCampaign(),
    ]);

    const remaining = camp && camp.remainingWinners != null
      ? Math.max(0, Number(camp.remainingWinners))
      : Math.max(0, settings.maxWinners - counts.winners);

    res.json({
      total: counts.total,
      winners: counts.winners,
      remaining,
      maxPlays: settings.maxPlays,
      maxWinners: settings.maxWinners,
      plays,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.delete('/api/admin/reset', requireAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE plays RESTART IDENTITY');
    await client.query('UPDATE campaign SET remaining_winners = max_winners WHERE id = 1');
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
