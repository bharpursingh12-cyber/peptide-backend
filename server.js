/**
 * PeptideProspect AI — Backend API v2.1 (SQLite)
 * REST API for opportunities, AI responses, queue, analytics
 * Port: from env PORT or 8009
 */

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const app = express();

// ─── CONFIG ───────────────────────────────────────────
const PORT = process.env.PORT || 8009;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const DB_PATH = process.env.DB_PATH || '/tmp/peptide.db';

// CORS
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ─── SQLITE ───────────────────────────────────────────
let db;
async function getDb() {
  if (!db) {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL');
  }
  return db;
}

// ─── INIT ─────────────────────────────────────────────
async function initDb() {
  const d = await getDb();

  await d.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      intent_type TEXT,
      intent_score INTEGER DEFAULT 0,
      subreddit TEXT,
      post_url TEXT,
      media_url TEXT,
      engaged INTEGER DEFAULT 0,
      discovered_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      ai_responses TEXT,
      status TEXT DEFAULT 'new',
      keywords_matched TEXT,
      raw_data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_opp_platform ON opportunities(platform);
    CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status);
    CREATE INDEX IF NOT EXISTS idx_opp_score ON opportunities(intent_score);
    CREATE INDEX IF NOT EXISTS idx_opp_discovered ON opportunities(discovered_at);

    CREATE TABLE IF NOT EXISTS engagement_queue (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      opportunity_id TEXT REFERENCES opportunities(id),
      platform TEXT NOT NULL,
      response_text TEXT NOT NULL,
      post_url TEXT,
      recipient_username TEXT,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      error_message TEXT,
      executed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON engagement_queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_opp ON engagement_queue(opportunity_id);

    CREATE TABLE IF NOT EXISTS brand_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      brand_name TEXT DEFAULT 'My Brand',
      tone TEXT DEFAULT 'professional',
      product_description TEXT DEFAULT 'research peptides',
      keywords TEXT DEFAULT '["peptide","BPC-157","TB-500","CJC-1295","Ipamorelin"]',
      platforms_enabled TEXT DEFAULT '["reddit","tiktok","instagram","twitter","youtube"]',
      auto_engage_threshold INTEGER DEFAULT 85
    );

    CREATE TABLE IF NOT EXISTS analytics_daily (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      date TEXT NOT NULL,
      platform TEXT,
      opportunities_found INTEGER DEFAULT 0,
      responses_generated INTEGER DEFAULT 0,
      responses_approved INTEGER DEFAULT 0,
      responses_sent INTEGER DEFAULT 0,
      avg_intent_score REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      entity_type TEXT,
      entity_id TEXT,
      activity_type TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed settings
  const settings = await d.get('SELECT COUNT(*) as c FROM brand_settings');
  if (settings.c === 0) {
    await d.run(`INSERT INTO brand_settings (brand_name, tone, product_description) VALUES ('My Brand', 'professional', 'research peptides')`);
  }
  console.log('[DB] Tables and indexes created');
}

// ─── SEED DATA ────────────────────────────────────────
async function seedData() {
  const d = await getDb();
  const count = await d.get('SELECT COUNT(*) as c FROM opportunities');
  if (count.c > 0) return;

  console.log('[DB] Seeding opportunities...');
  const ops = [
    { id:'reddit_r1', p:'reddit', u:'peptide_researcher22', c:'Looking for a reliable source for BPC-157. Anyone have recommendations? Been dealing with a nagging shoulder injury and heard this could help with recovery.', t:'purchase_intent', s:92, sub:'Peptides', url:'https://reddit.com/r/Peptides/comments/abc123' },
    { id:'reddit_r2', p:'reddit', u:'gymrat2024', c:'What is the best peptide for muscle growth? Looking to stack with my current routine. Been hearing good things about CJC-1295 and Ipamorelin.', t:'research_query', s:87, sub:'PEDs', url:'https://reddit.com/r/PEDs/comments/def456' },
    { id:'reddit_r3', p:'reddit', u:'biohacker99', c:'Just finished my first month of TB-500. Results have been incredible for my tendonitis. Happy to answer any questions for those considering it.', t:'review_request', s:78, sub:'Peptides', url:'https://reddit.com/r/Peptides/comments/ghi789' },
    { id:'reddit_r4', p:'reddit', u:'injured_runner', c:'Where to buy BPC-157 and TB-500 that ships to Canada? Need it ASAP for my marathon training. Any legit sources?', t:'purchase_intent', s:95, sub:'Peptides', url:'https://reddit.com/r/Peptides/comments/mno345' },
    { id:'reddit_r5', p:'reddit', u:'longevity_dave', c:'Comparing different GHRH peptides - CJC-1295 vs Sermorelin vs Tesamorelin. Which gives the best GH pulse profile for anti-aging purposes?', t:'comparison', s:81, sub:'longevity', url:'https://reddit.com/r/longevity/comments/jkl012' },
    { id:'reddit_r6', p:'reddit', u:'gym_bro_88', c:'Anyone tried ipamorelin + CJC-1295 no DAC? What was your experience? Looking to start a 12-week cycle.', t:'research_query', s:73, sub:'PEDs', url:'https://reddit.com/r/PEDs/comments/pqr678' },
    { id:'reddit_r7', p:'reddit', u:'recovery_quest', c:'What is the best source for research peptides in 2024? Need BPC-157, TB-500, and ipamorelin. Preferably with third-party testing.', t:'purchase_intent', s:90, sub:'Peptides', url:'https://reddit.com/r/Peptides/comments/stu901' },
    { id:'reddit_r8', p:'reddit', u:'fitness_guru22', c:'Stacking MK-677 with CJC-1295 and Ipamorelin. Thoughts on dosages and timing? First time trying this combo.', t:'research_query', s:68, sub:'SARMs', url:'https://reddit.com/r/SARMs/comments/vwx234' },
    { id:'reddit_r9', p:'reddit', u:'shoulder_pain_guy', c:'BPC-157 for rotator cuff injury - how long before you noticed results? Using 250mcg twice daily subQ near the injury site.', t:'review_request', s:76, sub:'Peptides', url:'https://reddit.com/r/Peptides/comments/yza567' },
    { id:'reddit_r10', p:'reddit', u:'lean_gainz', c:'Best peptide for lean muscle gain while cutting? Looking at GHRP-6, Ipamorelin, or CJC-1295. Any recommendations based on personal experience?', t:'research_query', s:83, sub:'bodybuilding', url:'https://reddit.com/r/bodybuilding/comments/bcd890' },
    { id:'reddit_r11', p:'reddit', u:'antiaging_mary', c:'Looking for a legit peptide source that ships to Europe. Want to try BPC-157 for joint pain and CJC-1295 for anti-aging. Any recommendations?', t:'purchase_intent', s:88, sub:'longevity', url:'https://reddit.com/r/longevity/comments/efg123' },
    { id:'reddit_r12', p:'reddit', u:'science_lifter', c:'The science behind BPC-157 and TB-500 synergy for injury recovery. Found this study and wanted to share my protocol and results after 8 weeks.', t:'review_request', s:72, sub:'Peptides', url:'https://reddit.com/r/Peptides/comments/ijk456' },
    { id:'tiktok_t1', p:'tiktok', u:'@fitnesswithsarah', c:'POV: you finally found a peptide source that actually ships fast and has lab results #peptides #fitness', t:'purchase_intent', s:85, sub:null, url:'https://tiktok.com/@fitnesswithsarah/video/123' },
    { id:'tiktok_t2', p:'tiktok', u:'@biohackertom', c:'Day 30 of BPC-157 protocol - the results are INSANE #peptide #recovery #fitnessjourney', t:'review_request', s:79, sub:null, url:'https://tiktok.com/@biohackertom/video/456' },
    { id:'tiktok_t3', p:'tiktok', u:'@research_chem_girl', c:'Where do you guys get your research peptides from? Looking for a reliable source with COAs #peptides #research', t:'purchase_intent', s:82, sub:null, url:'https://tiktok.com/@research_chem_girl/video/789' },
    { id:'instagram_i1', p:'instagram', u:'@ironandbiology', c:'New video up: Everything you need to know about BPC-157 vs TB-500 for injury recovery. Link in bio! Which one are you using?', t:'research_query', s:72, sub:null, url:'https://instagram.com/p/ABC123' },
    { id:'instagram_i2', p:'instagram', u:'@peptide.education', c:'DM me if you want my trusted source list for research peptides. I only vouch for companies with third-party testing. #peptides #transparency', t:'purchase_intent', s:91, sub:null, url:'https://instagram.com/p/DEF456' },
    { id:'twitter_tw1', p:'twitter', u:'@peptideguru', c:'Just tried a new peptide supplier and the quality is night and day compared to my old source. DM for details. #peptides #qualitymatters', t:'purchase_intent', s:86, sub:null, url:'https://twitter.com/peptideguru/status/123' },
    { id:'twitter_tw2', p:'twitter', u:'@sciencebro87', c:'Looking for peer-reviewed studies on CJC-1295 + Ipamorelin stack efficacy. Building a protocol and want evidence-based dosing. Any links appreciated!', t:'research_query', s:74, sub:null, url:'https://twitter.com/sciencebro87/status/456' },
    { id:'youtube_y1', p:'youtube', u:'MorePlatesMoreDates', c:'In this video we discuss the BEST peptide sources in 2024, how to identify fake COAs, and what to look for in a quality supplier.', t:'purchase_intent', s:89, sub:null, url:'https://youtube.com/watch?v=xyz789' },
  ];

  for (const o of ops) {
    await d.run(`INSERT OR IGNORE INTO opportunities (id, platform, username, content, intent_type, intent_score, subreddit, post_url, engaged, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'new')`,
      [o.id, o.p, o.u, o.c, o.t, o.s, o.sub, o.url]);
  }

  // Seed analytics
  for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    await d.run(`INSERT OR IGNORE INTO analytics_daily (date, platform, opportunities_found, avg_intent_score)
      VALUES (?, 'reddit', ?, ?)`,
      [date.toISOString().split('T')[0], Math.floor(Math.random() * 8) + 2, 70 + Math.random() * 15]);
  }

  console.log(`[DB] Seeded ${ops.length} opportunities`);
}

// ─── AI HELPERS ───────────────────────────────────────
async function generateAIResponses(content, username, platform) {
  if (!openai) return { error: 'OpenAI not configured' };

  const settings = await getDb().then(d => d.get('SELECT * FROM brand_settings WHERE id = 1'));
  const systemPrompt = `You are a senior brand engagement specialist for ${settings?.brand_name || 'our brand'}.
TONE: ${settings?.tone || 'professional, helpful'}
PRODUCTS: ${settings?.product_description || 'research peptides'}

RULES:
- Write 3 response variants (label A, B, C)
- Match the prospect's energy and communication style
- Lead with VALUE (helpful info, not sales pitch)
- Keep each response under 280 characters
- NEVER make medical claims
- NEVER include prices or promotional offers
- Sound like a knowledgeable peer, not a brand rep
- Include subtle brand mention only if natural

OUTPUT FORMAT: JSON with shape { "variants": [{ "label", "text", "strategy" }] }`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Platform: ${platform}\nUsername: ${username}\nPost: "${content}"\n\nGenerate 3 response variants.` }
    ],
    temperature: 0.7,
    max_tokens: 500
  });

  return JSON.parse(completion.choices[0].message.content);
}

// ─── ROUTES ───────────────────────────────────────────

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.1.0', service: 'peptideprospect-api', db: 'sqlite' });
});

// ─── Opportunities ────────────────────────────────────

// LIST
app.get('/api/opportunities', async (req, res) => {
  try {
    const d = await getDb();
    const platform = req.query.platform || null;
    const status = req.query.status || null;
    const minScore = req.query.minScore ? parseInt(req.query.minScore) : null;
    const limit = Math.min(req.query.limit ? parseInt(req.query.limit) : 50, 200);
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;
    const q = req.query.q || null;

    let sql = 'SELECT * FROM opportunities WHERE 1=1';
    const params = [];

    if (platform) { sql += ' AND platform = ?'; params.push(platform); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (minScore) { sql += ' AND intent_score >= ?'; params.push(minScore); }
    if (q) { sql += ' AND (username LIKE ? OR content LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

    const countResult = await d.get(`SELECT COUNT(*) as c FROM opportunities WHERE 1=1` +
      (platform ? ' AND platform = ?' : '') +
      (status ? ' AND status = ?' : '') +
      (minScore ? ' AND intent_score >= ?' : '') +
      (q ? ' AND (username LIKE ? OR content LIKE ?)' : ''),
      [...(platform ? [platform] : []), ...(status ? [status] : []), ...(minScore ? [minScore] : []), ...(q ? [`%${q}%`, `%${q}%`] : [])]);

    sql += ' ORDER BY intent_score DESC, discovered_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = await d.all(sql, params);
    res.json({ data: rows, total: countResult.c });
  } catch (err) {
    console.error('[Opportunities] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET ONE
app.get('/api/opportunities/:id', async (req, res) => {
  try {
    const d = await getDb();
    const row = await d.get('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.ai_responses) try { row.ai_responses = JSON.parse(row.ai_responses); } catch(e) {}
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE
app.post('/api/opportunities', async (req, res) => {
  try {
    const d = await getDb();
    const o = req.body;
    await d.run(`INSERT INTO opportunities (id, platform, username, content, intent_type, intent_score, subreddit, post_url, media_url, status, keywords_matched, discovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [o.id, o.platform, o.username, o.content, o.intent_type, o.intent_score, o.subreddit, o.post_url, o.media_url, o.status || 'new', JSON.stringify(o.keywords_matched || [])]);
    const row = await d.get('SELECT * FROM opportunities WHERE id = ?', [o.id]);
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE
app.patch('/api/opportunities/:id', async (req, res) => {
  try {
    const d = await getDb();
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (['content','intent_type','intent_score','status','engaged','ai_responses','keywords_matched'].includes(k)) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'No valid fields' });
    values.push(req.params.id);
    await d.run(`UPDATE opportunities SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`, values);
    const row = await d.get('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AI Response Generation ───────────────────────────

app.post('/api/opportunities/:id/respond', async (req, res) => {
  try {
    const d = await getDb();
    const opp = await d.get('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });

    const aiResult = await generateAIResponses(opp.content, opp.username, opp.platform);
    if (aiResult.error) return res.status(503).json({ error: aiResult.error });

    // Save AI responses to opportunity
    await d.run('UPDATE opportunities SET ai_responses = ? WHERE id = ?', [JSON.stringify(aiResult), opp.id]);

    // Create queue entry
    for (const variant of aiResult.variants || []) {
      await d.run(`INSERT INTO engagement_queue (opportunity_id, platform, response_text, post_url, status)
        VALUES (?, ?, ?, ?, 'pending')`,
        [opp.id, opp.platform, variant.text, opp.post_url]);
    }

    // Log activity
    await d.run(`INSERT INTO activities (entity_type, entity_id, activity_type, description)
      VALUES (?, ?, 'ai_response', ?)`,
      ['opportunity', opp.id, `Generated ${aiResult.variants?.length || 0} response variants`]);

    res.json(aiResult);
  } catch (err) {
    console.error('[Respond] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Queue / Approval ─────────────────────────────────

app.get('/api/queue', async (req, res) => {
  try {
    const d = await getDb();
    const status = req.query.status || null;
    let sql = `SELECT q.*, o.username, o.content as opportunity_content, o.intent_score, o.subreddit, o.post_url as opp_post_url
      FROM engagement_queue q LEFT JOIN opportunities o ON q.opportunity_id = o.id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND q.status = ?'; params.push(status); }
    sql += ' ORDER BY q.created_at DESC';

    const rows = await d.all(sql, params);
    const count = await d.get('SELECT COUNT(*) as c FROM engagement_queue');
    res.json({ data: rows, total: count.c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/:id/approve', async (req, res) => {
  try {
    const d = await getDb();
    await d.run("UPDATE engagement_queue SET status = 'approved' WHERE id = ?", [req.params.id]);
    const row = await d.get('SELECT * FROM engagement_queue WHERE id = ?', [req.params.id]);
    res.json({ success: true, item: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/:id/reject', async (req, res) => {
  try {
    const d = await getDb();
    await d.run("UPDATE engagement_queue SET status = 'rejected', error_message = ? WHERE id = ?",
      [req.body.reason || 'Rejected by user', req.params.id]);
    const row = await d.get('SELECT * FROM engagement_queue WHERE id = ?', [req.params.id]);
    res.json({ success: true, item: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk Operations ──────────────────────────────────

app.post('/api/bulk/approve', async (req, res) => {
  try {
    const d = await getDb();
    const ids = req.body.ids || [];
    for (const id of ids) {
      await d.run("UPDATE engagement_queue SET status = 'approved' WHERE id = ?", [id]);
    }
    res.json({ success: true, updated: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bulk/reject', async (req, res) => {
  try {
    const d = await getDb();
    const ids = req.body.ids || [];
    const reason = req.body.reason || 'Bulk rejected';
    for (const id of ids) {
      await d.run("UPDATE engagement_queue SET status = 'rejected', error_message = ? WHERE id = ?", [reason, id]);
    }
    res.json({ success: true, updated: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Analytics ────────────────────────────────────────

app.get('/api/analytics', async (req, res) => {
  try {
    const d = await getDb();
    const total = await d.get('SELECT COUNT(*) as c FROM opportunities');
    const avgScore = await d.get('SELECT AVG(intent_score) as avg FROM opportunities');
    const engaged = await d.get('SELECT COUNT(*) as c FROM opportunities WHERE engaged = 1');
    const engagementRate = total.c > 0 ? ((engaged.c / total.c) * 100).toFixed(1) : 0;

    const platformBreakdown = await d.all('SELECT platform, COUNT(*) as count FROM opportunities GROUP BY platform');

    const dailyDiscovery = await d.all(`SELECT date(discovered_at) as date, COUNT(*) as count FROM opportunities
      GROUP BY date ORDER BY date DESC LIMIT 7`);

    const scoreDistribution = [
      { range: '90-100', count: (await d.get('SELECT COUNT(*) as c FROM opportunities WHERE intent_score >= 90')).c },
      { range: '80-89', count: (await d.get('SELECT COUNT(*) as c FROM opportunities WHERE intent_score >= 80 AND intent_score < 90')).c },
      { range: '70-79', count: (await d.get('SELECT COUNT(*) as c FROM opportunities WHERE intent_score >= 70 AND intent_score < 80')).c },
      { range: '60-69', count: (await d.get('SELECT COUNT(*) as c FROM opportunities WHERE intent_score >= 60 AND intent_score < 70')).c },
      { range: '<60', count: (await d.get('SELECT COUNT(*) as c FROM opportunities WHERE intent_score < 60')).c },
    ];

    res.json({
      totalOpportunities: total.c,
      avgIntentScore: Math.round(avgScore.avg || 0),
      engagementRate: parseFloat(engagementRate),
      platformBreakdown,
      dailyDiscovery,
      scoreDistribution
    });
  } catch (err) {
    console.error('[Analytics] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings ─────────────────────────────────────────

app.get('/api/settings', async (req, res) => {
  try {
    const d = await getDb();
    const row = await d.get('SELECT * FROM brand_settings WHERE id = 1');
    if (row) {
      try { row.keywords = JSON.parse(row.keywords); } catch(e) {}
      try { row.platforms_enabled = JSON.parse(row.platforms_enabled); } catch(e) {}
    }
    res.json(row || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/settings', async (req, res) => {
  try {
    const d = await getDb();
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (['brand_name','tone','product_description','keywords','platforms_enabled','auto_engage_threshold'].includes(k)) {
        fields.push(`${k} = ?`);
        values.push(typeof v === 'object' ? JSON.stringify(v) : v);
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'No valid fields' });
    values.push(1); // WHERE id = 1
    await d.run(`UPDATE brand_settings SET ${fields.join(', ')} WHERE id = ?`, values);
    const row = await d.get('SELECT * FROM brand_settings WHERE id = 1');
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Activities ───────────────────────────────────────

app.get('/api/activities', async (req, res) => {
  try {
    const d = await getDb();
    const limit = req.query.limit ? parseInt(req.query.limit) : 20;
    const rows = await d.all('SELECT * FROM activities ORDER BY created_at DESC LIMIT ?', [limit]);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Error Handler ────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── START ────────────────────────────────────────────
async function start() {
  await initDb();
  await seedData();

  app.listen(PORT, () => {
    console.log(`[API] PeptideProspect backend on port ${PORT}`);
    console.log(`[API] SQLite: ${DB_PATH}`);
    console.log(`[API] OpenAI: ${openai ? 'configured' : 'NOT configured'}`);
  });
}

start().catch(err => {
  console.error('[Fatal] Could not start:', err);
  process.exit(1);
});
