/**
 * PeptideProspect AI - SQLite Backend
 * Complete REST API with better-sqlite3 for Render.com deployment
 * @version 2.1.0
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const DB_PATH = process.env.DB_PATH || '/tmp/peptide.db';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const VERSION = '2.1.0';

const app = express();
const startTime = Date.now();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip || 'unknown'}`);
  next();
});

// ─── OPENAI CLIENT ────────────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const database = getDb();

  // ── opportunities table ──────────────────────────────────────────────────
  database.exec(`
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
  `);

  // ── engagement_queue table ───────────────────────────────────────────────
  database.exec(`
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
  `);

  // ── brand_settings table ─────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS brand_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      brand_name TEXT DEFAULT 'My Brand',
      tone TEXT DEFAULT 'professional',
      product_description TEXT DEFAULT 'research peptides',
      keywords TEXT DEFAULT '["peptide","BPC-157","TB-500","CJC-1295","Ipamorelin"]',
      platforms_enabled TEXT DEFAULT '["reddit","tiktok","instagram","twitter","youtube"]',
      auto_engage_threshold INTEGER DEFAULT 85
    );
  `);

  // ── analytics_daily table ────────────────────────────────────────────────
  database.exec(`
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
  `);

  // ── activities table ─────────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      entity_type TEXT,
      entity_id TEXT,
      activity_type TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Create indexes for performance ───────────────────────────────────────
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_opportunities_platform ON opportunities(platform);
    CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status);
    CREATE INDEX IF NOT EXISTS idx_opportunities_intent_score ON opportunities(intent_score);
    CREATE INDEX IF NOT EXISTS idx_opportunities_discovered ON opportunities(discovered_at);
    CREATE INDEX IF NOT EXISTS idx_opportunities_username ON opportunities(username);
    CREATE INDEX IF NOT EXISTS idx_queue_status ON engagement_queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_opportunity ON engagement_queue(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_date ON analytics_daily(date);
    CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at);
  `);

  console.log('[DB] Schema initialized successfully');
}

// ─── SEED DATA ────────────────────────────────────────────────────────────────
function seedData() {
  const database = getDb();

  // Check if data already exists
  const count = database.prepare('SELECT COUNT(*) as c FROM opportunities').get();
  if (count.c > 0) {
    console.log('[DB] Data already exists, skipping seed');
    return;
  }

  console.log('[DB] Seeding database...');

  // ── Seed Opportunities (20 realistic peptide opportunities) ──────────────
  const opportunities = [
    {
      id: 'opp_reddit_001',
      platform: 'reddit', username: 'BioHackerMike', content: 'Just started my BPC-157 cycle for gut healing. Day 3 and already noticing reduced inflammation. Has anyone stacked this with TB-500 for enhanced recovery? Looking for the best source for research-grade peptides.',
      intent_type: 'purchase_intent', intent_score: 92, subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/abc123', media_url: '', engaged: 0,
      discovered_at: '2025-06-01T08:23:00Z', status: 'new',
      keywords_matched: '["BPC-157","TB-500","peptide","research"]',
      raw_data: '{"upvotes": 45, "comments": 12}'
    },
    {
      id: 'opp_reddit_002',
      platform: 'reddit', username: 'GymRat2024', content: 'Where can I buy legit CJC-1295 + Ipamorelin blend? Tired of sketchy vendors. Need lab-tested stuff for my research.',
      intent_type: 'purchase_intent', intent_score: 95, subreddit: 'PEDs',
      post_url: 'https://reddit.com/r/PEDs/comments/def456', media_url: '', engaged: 0,
      discovered_at: '2025-06-01T10:15:00Z', status: 'new',
      keywords_matched: '["CJC-1295","Ipamorelin","peptide","buy"]',
      raw_data: '{"upvotes": 78, "comments": 23}'
    },
    {
      id: 'opp_reddit_003',
      platform: 'reddit', username: 'LongevityLucy', content: 'Researching peptides for anti-aging. Currently looking at Epitalon and FOXO4-DRI. Any recommendations on reputable sources? Price isn\'t an issue, quality is.',
      intent_type: 'research_query', intent_score: 88, subreddit: 'longevity',
      post_url: 'https://reddit.com/r/longevity/comments/ghi789', media_url: '', engaged: 0,
      discovered_at: '2025-06-02T14:30:00Z', status: 'new',
      keywords_matched: '["peptide","Epitalon","research","anti-aging"]',
      raw_data: '{"upvotes": 32, "comments": 8}'
    },
    {
      id: 'opp_reddit_004',
      platform: 'reddit', username: 'PeptideNewbie', content: 'Complete beginner here. What\'s the difference between MOD-GRF and CJC-1295 with DAC? Which is better for research purposes?',
      intent_type: 'research_query', intent_score: 72, subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/jkl012', media_url: '', engaged: 0,
      discovered_at: '2025-06-02T16:45:00Z', status: 'new',
      keywords_matched: '["CJC-1295","peptide","research","MOD-GRF"]',
      raw_data: '{"upvotes": 15, "comments": 19}'
    },
    {
      id: 'opp_reddit_005',
      platform: 'reddit', username: 'IronChad92', content: 'Review request: Just received TB-500 from [vendor]. Vial looks clear, no particles. Planning to start research tomorrow. Will update with results.',
      intent_type: 'review_request', intent_score: 65, subreddit: 'bodybuilding',
      post_url: 'https://reddit.com/r/bodybuilding/comments/mno345', media_url: '', engaged: 0,
      discovered_at: '2025-06-03T09:10:00Z', status: 'new',
      keywords_matched: '["TB-500","peptide","review"]',
      raw_data: '{"upvotes": 22, "comments": 7}'
    },
    {
      id: 'opp_reddit_006',
      platform: 'reddit', username: 'ResearchDoc', content: 'Clinical comparison: BPC-157 vs TB-500 for tendon repair in rodent models. BPC showed faster initial healing, TB showed better long-term collagen organization. Full study in comments.',
      intent_type: 'comparison', intent_score: 85, subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/pqr678', media_url: '', engaged: 0,
      discovered_at: '2025-06-03T11:20:00Z', status: 'new',
      keywords_matched: '["BPC-157","TB-500","peptide","comparison"]',
      raw_data: '{"upvotes": 156, "comments": 34}'
    },
    {
      id: 'opp_reddit_007',
      platform: 'reddit', username: 'SARMsExplorer', content: 'Looking to compare peptide sources. Currently using X-Peptides but thinking about switching. Who has the best third-party testing?',
      intent_type: 'comparison', intent_score: 90, subreddit: 'SARMs',
      post_url: 'https://reddit.com/r/SARMs/comments/stu901', media_url: '', engaged: 0,
      discovered_at: '2025-06-04T07:55:00Z', status: 'new',
      keywords_matched: '["peptide","SARMs","third-party testing","compare"]',
      raw_data: '{"upvotes": 41, "comments": 15}'
    },
    {
      id: 'opp_reddit_008',
      platform: 'reddit', username: 'FitMomSarah', content: 'Need help finding a trustworthy peptide vendor for BPC-157. Using it for post-surgery recovery research. So many scam sites out there!',
      intent_type: 'purchase_intent', intent_score: 93, subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/vwx234', media_url: '', engaged: 0,
      discovered_at: '2025-06-04T13:40:00Z', status: 'new',
      keywords_matched: '["BPC-157","peptide","vendor","trustworthy"]',
      raw_data: '{"upvotes": 67, "comments": 28}'
    },
    {
      id: 'opp_reddit_009',
      platform: 'reddit', username: 'RecoveryRoad', content: 'Week 4 of TB-500 + BPC-157 stack for shoulder injury. Pain down 60%, ROM improved significantly. Will continue for 2 more weeks.',
      intent_type: 'review_request', intent_score: 78, subreddit: 'bodybuilding',
      post_url: 'https://reddit.com/r/bodybuilding/comments/yza567', media_url: '', engaged: 0,
      discovered_at: '2025-06-05T06:15:00Z', status: 'new',
      keywords_matched: '["TB-500","BPC-157","peptide","stack"]',
      raw_data: '{"upvotes": 89, "comments": 21}'
    },
    {
      id: 'opp_reddit_010',
      platform: 'reddit', username: 'PeptideScientist', content: 'Seeking high-purity Ipamorelin for ongoing research project. Need COA and HPLC data. Budget is $500/month. DM with verified sources only.',
      intent_type: 'purchase_intent', intent_score: 96, subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/bcd890', media_url: '', engaged: 0,
      discovered_at: '2025-06-05T18:25:00Z', status: 'new',
      keywords_matched: '["Ipamorelin","peptide","COA","research"]',
      raw_data: '{"upvotes": 34, "comments": 11}'
    },
    {
      id: 'opp_reddit_011',
      platform: 'reddit', username: 'TendonTrouble', content: 'Chronic Achilles tendinopathy - has anyone had success with BPC-157 injections? Looking for protocol and dosage for research purposes.',
      intent_type: 'research_query', intent_score: 82, subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/efg123', media_url: '', engaged: 0,
      discovered_at: '2025-06-06T08:50:00Z', status: 'new',
      keywords_matched: '["BPC-157","peptide","protocol","research"]',
      raw_data: '{"upvotes": 52, "comments": 17}'
    },
    {
      id: 'opp_reddit_012',
      platform: 'reddit', username: 'AntiAgingAndy', content: 'Comparison of major peptide vendors 2025 edition. Testing purity, shipping speed, customer service. Currently ranking Top 5.',
      intent_type: 'comparison', intent_score: 75, subreddit: 'longevity',
      post_url: 'https://reddit.com/r/longevity/comments/hij456', media_url: '', engaged: 0,
      discovered_at: '2025-06-06T15:35:00Z', status: 'new',
      keywords_matched: '["peptide","vendor","comparison","purity"]',
      raw_data: '{"upvotes": 203, "comments": 56}'
    },
    {
      id: 'opp_tiktok_001',
      platform: 'tiktok', username: '@peptideguru', content: 'Day 12 of my BPC-157 protocol and the results are INSANE. Comment below if you want my source list! #peptides #bpc157 #biohacking',
      intent_type: 'purchase_intent', intent_score: 87, subreddit: '',
      post_url: 'https://tiktok.com/@peptideguru/video/abc123', media_url: 'https://tiktok.com/video/abc123.mp4', engaged: 0,
      discovered_at: '2025-06-02T12:00:00Z', status: 'new',
      keywords_matched: '["BPC-157","peptide","biohacking"]',
      raw_data: '{"views": 45000, "likes": 3200, "shares": 180}'
    },
    {
      id: 'opp_tiktok_002',
      platform: 'tiktok', username: '@gymtokscientist', content: 'POV: You just found out about CJC-1295 Ipamorelin stack and your whole world changed. Link in bio for my research guide! #gymmotivation #peptides',
      intent_type: 'purchase_intent', intent_score: 91, subreddit: '',
      post_url: 'https://tiktok.com/@gymtokscientist/video/def456', media_url: 'https://tiktok.com/video/def456.mp4', engaged: 0,
      discovered_at: '2025-06-04T09:30:00Z', status: 'new',
      keywords_matched: '["CJC-1295","Ipamorelin","peptide","stack"]',
      raw_data: '{"views": 89000, "likes": 5400, "shares": 320}'
    },
    {
      id: 'opp_tiktok_003',
      platform: 'tiktok', username: '@biohackbeth', content: 'Testing 3 different peptide brands so you don\'t have to! Which one has the best purity? Results dropping tomorrow! #peptidereview #research',
      intent_type: 'comparison', intent_score: 80, subreddit: '',
      post_url: 'https://tiktok.com/@biohackbeth/video/ghi789', media_url: 'https://tiktok.com/video/ghi789.mp4', engaged: 0,
      discovered_at: '2025-06-06T11:15:00Z', status: 'new',
      keywords_matched: '["peptide","review","purity","research"]',
      raw_data: '{"views": 67000, "likes": 4100, "shares": 250}'
    },
    {
      id: 'opp_instagram_001',
      platform: 'instagram', username: '@fitness_dr_james', content: 'New blog post: Complete guide to research peptides for recovery. TB-500 and BPC-157 protocols explained. DM me for my trusted source list! #peptides #recovery',
      intent_type: 'purchase_intent', intent_score: 89, subreddit: '',
      post_url: 'https://instagram.com/p/abc123', media_url: 'https://instagram.com/p/abc123.jpg', engaged: 0,
      discovered_at: '2025-06-03T14:20:00Z', status: 'new',
      keywords_matched: '["TB-500","BPC-157","peptide","recovery"]',
      raw_data: '{"likes": 1200, "comments": 45, "saves": 89}'
    },
    {
      id: 'opp_instagram_002',
      platform: 'instagram', username: '@wellnesswithlisa', content: 'Looking for a peptide vendor with lab testing and fast shipping. Has anyone ordered from a good source recently? Please share! #peptidesearch',
      intent_type: 'purchase_intent', intent_score: 94, subreddit: '',
      post_url: 'https://instagram.com/p/def456', media_url: 'https://instagram.com/p/def456.jpg', engaged: 0,
      discovered_at: '2025-06-05T16:45:00Z', status: 'new',
      keywords_matched: '["peptide","vendor","lab testing","shipping"]',
      raw_data: '{"likes": 856, "comments": 67, "saves": 34}'
    },
    {
      id: 'opp_twitter_001',
      platform: 'twitter', username: '@BiohackerTech', content: 'Just ordered research-grade BPC-157 and TB-500. The peptide market is wild right now. Make sure you\'re buying from vendors with third-party COAs! Thread below on what to look for.',
      intent_type: 'purchase_intent', intent_score: 86, subreddit: '',
      post_url: 'https://twitter.com/BiohackerTech/status/abc123', media_url: '', engaged: 0,
      discovered_at: '2025-06-03T20:10:00Z', status: 'new',
      keywords_matched: '["BPC-157","TB-500","peptide","COA"]',
      raw_data: '{"likes": 234, "retweets": 45, "replies": 23}'
    },
    {
      id: 'opp_twitter_002',
      platform: 'twitter', username: '@DrPeptideMD', content: 'Question for the peptide community: What\'s your experience with Ipamorelin + CJC-1295 no DAC? Seeing promising results in my practice for sleep and recovery optimization.',
      intent_type: 'research_query', intent_score: 83, subreddit: '',
      post_url: 'https://twitter.com/DrPeptideMD/status/def456', media_url: '', engaged: 0,
      discovered_at: '2025-06-05T22:30:00Z', status: 'new',
      keywords_matched: '["Ipamorelin","CJC-1295","peptide","sleep","recovery"]',
      raw_data: '{"likes": 567, "retweets": 89, "replies": 56}'
    },
    {
      id: 'opp_youtube_001',
      platform: 'youtube', username: 'PeptideScienceChannel', content: 'Video: "My Top 5 Peptide Sources for 2025 - Lab Tested & Verified" - I tested peptides from 12 different vendors and these are the results. Links in description for discount codes.',
      intent_type: 'comparison', intent_score: 79, subreddit: '',
      post_url: 'https://youtube.com/watch?v=abc123', media_url: 'https://youtube.com/thumb/abc123.jpg', engaged: 0,
      discovered_at: '2025-06-06T10:00:00Z', status: 'new',
      keywords_matched: '["peptide","sources","lab tested","verified"]',
      raw_data: '{"views": 125000, "likes": 4500, "comments": 230}'
    },
  ];

  const insertOpp = database.prepare(`
    INSERT INTO opportunities (id, platform, username, content, intent_type, intent_score, subreddit, post_url, media_url, engaged, discovered_at, updated_at, ai_responses, status, keywords_matched, raw_data)
    VALUES (@id, @platform, @username, @content, @intent_type, @intent_score, @subreddit, @post_url, @media_url, @engaged, @discovered_at, datetime('now'), @ai_responses, @status, @keywords_matched, @raw_data)
  `);

  const insertMany = database.transaction((rows) => {
    for (const row of rows) {
      insertOpp.run(row);
    }
  });

  insertMany(opportunities);
  console.log(`[DB] Inserted ${opportunities.length} opportunities`);

  // ── Seed brand_settings ──────────────────────────────────────────────────
  const insertSettings = database.prepare(`
    INSERT OR IGNORE INTO brand_settings (id, brand_name, tone, product_description, keywords, platforms_enabled, auto_engage_threshold)
    VALUES (1, 'PeptideProspect AI', 'professional', 'research peptides',
            '["peptide","BPC-157","TB-500","CJC-1295","Ipamorelin","SARMs","research","biohacking"]',
            '["reddit","tiktok","instagram","twitter","youtube"]', 85)
  `);
  insertSettings.run();
  console.log('[DB] Inserted brand settings');

  // ── Seed analytics_daily (last 5 days) ───────────────────────────────────
  const analyticsData = [
    { date: '2025-06-06', platform: 'reddit', opportunities_found: 8, responses_generated: 6, responses_approved: 4, responses_sent: 3, avg_intent_score: 87.5 },
    { date: '2025-06-05', platform: 'all', opportunities_found: 12, responses_generated: 9, responses_approved: 6, responses_sent: 5, avg_intent_score: 84.2 },
    { date: '2025-06-04', platform: 'all', opportunities_found: 15, responses_generated: 11, responses_approved: 8, responses_sent: 7, avg_intent_score: 81.0 },
    { date: '2025-06-03', platform: 'all', opportunities_found: 10, responses_generated: 7, responses_approved: 5, responses_sent: 4, avg_intent_score: 88.3 },
    { date: '2025-06-02', platform: 'all', opportunities_found: 18, responses_generated: 14, responses_approved: 10, responses_sent: 8, avg_intent_score: 85.7 },
  ];

  const insertAnalytics = database.prepare(`
    INSERT INTO analytics_daily (id, date, platform, opportunities_found, responses_generated, responses_approved, responses_sent, avg_intent_score)
    VALUES (lower(hex(randomblob(16))), @date, @platform, @opportunities_found, @responses_generated, @responses_approved, @responses_sent, @avg_intent_score)
  `);

  const insertAnalyticsMany = database.transaction((rows) => {
    for (const row of rows) {
      insertAnalytics.run(row);
    }
  });

  insertAnalyticsMany(analyticsData);
  console.log(`[DB] Inserted ${analyticsData.length} analytics rows`);

  // ── Seed activities ──────────────────────────────────────────────────────
  const activities = [
    { entity_type: 'opportunity', entity_id: 'opp_reddit_001', activity_type: 'discovered', description: 'Discovered Reddit post by BioHackerMike about BPC-157 and TB-500 stack' },
    { entity_type: 'opportunity', entity_id: 'opp_reddit_002', activity_type: 'discovered', description: 'Discovered high-intent purchase query from GymRat2024 seeking CJC-1295 blend' },
    { entity_type: 'system', entity_id: 'seed', activity_type: 'database_initialized', description: 'Database seeded with 20 opportunities, brand settings, and analytics' },
  ];

  const insertActivity = database.prepare(`
    INSERT INTO activities (id, entity_type, entity_id, activity_type, description, created_at)
    VALUES (lower(hex(randomblob(16))), @entity_type, @entity_id, @activity_type, @description, datetime('now'))
  `);

  const insertActivitiesMany = database.transaction((rows) => {
    for (const row of rows) {
      insertActivity.run(row);
    }
  });

  insertActivitiesMany(activities);
  console.log(`[DB] Inserted ${activities.length} activities`);

  console.log('[DB] Seed complete!');
}

// ─── AI RESPONSE GENERATION ───────────────────────────────────────────────────
async function generateAIResponses(content, username, platform) {
  const systemPrompt = `You are a senior brand engagement specialist for a peptide research brand.
TONE: professional, helpful, knowledgeable
PRODUCTS: research peptides (BPC-157, TB-500, CJC-1295, Ipamorelin, etc.)
RULES:
- Write 3 response variants (A, B, C)
- Match the prospect's energy and context
- Lead with VALUE (helpful info, not sales pitch)
- Keep each response under 280 characters
- NEVER make medical claims or promises
- Sound like a knowledgeable peer, not a marketer
- Include a subtle CTA pointing to quality research peptides
OUTPUT FORMAT: JSON with the following structure:
{
  "variants": [
    { "label": "A", "text": "...", "strategy": "educational" },
    { "label": "B", "text": "...", "strategy": "peer-to-peer" },
    { "label": "C", "text": "...", "strategy": "value-first" }
  ]
}`;

  const userPrompt = `Platform: ${platform}
Username: ${username}
Post: "${content}"

Generate 3 response variants that engage this prospect professionally.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    const result = JSON.parse(completion.choices[0].message.content);
    return result;
  } catch (error) {
    console.error('[AI] Error generating responses:', error.message);
    // Return fallback variants so the API doesn't break
    return {
      variants: [
        { label: 'A', text: `Hey @${username}! Great question about peptides. Happy to share some research insights - DM me!`, strategy: 'fallback_engagement' },
        { label: 'B', text: `That's a solid point on peptide research! Would love to exchange findings. Feel free to reach out!`, strategy: 'fallback_peer' },
        { label: 'C', text: `Agreed - peptide quality varies a ton. We focus on lab-tested research-grade. Happy to help if you have questions!`, strategy: 'fallback_value' },
      ],
    };
  }
}

// ─── ACTIVITY LOGGING HELPER ──────────────────────────────────────────────────
function logActivity(entityType, entityId, activityType, description) {
  try {
    const database = getDb();
    database.prepare(`
      INSERT INTO activities (id, entity_type, entity_id, activity_type, description, created_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'))
    `).run(entityType, entityId, activityType, description);
  } catch (err) {
    console.error('[Activity] Failed to log activity:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  try {
    const dbCheck = getDb().prepare('SELECT 1').get();
    res.json({
      status: 'ok',
      version: VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      db: 'sqlite',
      db_connected: !!dbCheck,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── GET /api/opportunities ───────────────────────────────────────────────────
// Query params: ?platform=&status=&minScore=&limit=&offset=&q=
app.get('/api/opportunities', (req, res) => {
  try {
    const database = getDb();
    const { platform, status, minScore, limit = '50', offset = '0', q } = req.query;

    const conditions = [];
    const params = {};

    if (platform) {
      conditions.push('platform = @platform');
      params.platform = platform;
    }
    if (status) {
      conditions.push('status = @status');
      params.status = status;
    }
    if (minScore) {
      conditions.push('intent_score >= @minScore');
      params.minScore = parseInt(minScore, 10);
    }
    if (q) {
      conditions.push('(username LIKE @q OR content LIKE @q)');
      params.q = `%${q}%`;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countSql = `SELECT COUNT(*) as total FROM opportunities ${whereClause}`;
    const countResult = database.prepare(countSql).get(params);

    // Data query
    const dataSql = `
      SELECT * FROM opportunities
      ${whereClause}
      ORDER BY discovered_at DESC
      LIMIT @limit OFFSET @offset
    `;
    params.limit = parseInt(limit, 10);
    params.offset = parseInt(offset, 10);

    const rows = database.prepare(dataSql).all(params);

    // Parse JSON fields
    const parsedRows = rows.map((row) => ({
      ...row,
      ai_responses: safeJsonParse(row.ai_responses, null),
      keywords_matched: safeJsonParse(row.keywords_matched, []),
      raw_data: safeJsonParse(row.raw_data, {}),
    }));

    res.json({
      data: parsedRows,
      total: countResult.total,
      limit: params.limit,
      offset: params.offset,
    });
  } catch (error) {
    console.error('[API] GET /api/opportunities error:', error.message);
    res.status(500).json({ error: 'Failed to fetch opportunities', message: error.message });
  }
});

// ─── GET /api/opportunities/:id ───────────────────────────────────────────────
app.get('/api/opportunities/:id', (req, res) => {
  try {
    const database = getDb();
    const { id } = req.params;

    const row = database.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);

    if (!row) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    // Parse JSON fields
    const opportunity = {
      ...row,
      ai_responses: safeJsonParse(row.ai_responses, null),
      keywords_matched: safeJsonParse(row.keywords_matched, []),
      raw_data: safeJsonParse(row.raw_data, {}),
    };

    res.json(opportunity);
  } catch (error) {
    console.error('[API] GET /api/opportunities/:id error:', error.message);
    res.status(500).json({ error: 'Failed to fetch opportunity', message: error.message });
  }
});

// ─── POST /api/opportunities/:id/respond ──────────────────────────────────────
app.post('/api/opportunities/:id/respond', async (req, res) => {
  try {
    const database = getDb();
    const { id } = req.params;

    // Fetch the opportunity
    const opportunity = database.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
    if (!opportunity) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    // Check if responses already exist
    if (opportunity.ai_responses) {
      const existing = safeJsonParse(opportunity.ai_responses, null);
      if (existing && existing.variants && existing.variants.length > 0) {
        return res.json({
          message: 'Responses already generated',
          opportunity_id: id,
          variants: existing.variants,
        });
      }
    }

    // Check if API key is available
    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        error: 'OpenAI API key not configured',
        message: 'Please set the OPENAI_API_KEY environment variable',
      });
    }

    // Generate AI responses
    const aiResult = await generateAIResponses(
      opportunity.content,
      opportunity.username,
      opportunity.platform
    );

    // Save responses to opportunity
    const aiResponsesJson = JSON.stringify(aiResult);
    database.prepare(`
      UPDATE opportunities
      SET ai_responses = ?, status = 'responded', updated_at = datetime('now'), engaged = 1
      WHERE id = ?
    `).run(aiResponsesJson, id);

    // Create engagement queue entries for each variant
    if (aiResult.variants && Array.isArray(aiResult.variants)) {
      const insertQueue = database.prepare(`
        INSERT INTO engagement_queue (id, opportunity_id, platform, response_text, post_url, recipient_username, status, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, 'pending', datetime('now'))
      `);

      for (const variant of aiResult.variants) {
        insertQueue.run(
          id,
          opportunity.platform,
          variant.text,
          opportunity.post_url,
          opportunity.username
        );
      }
    }

    // Log activity
    logActivity('opportunity', id, 'ai_responses_generated', `Generated ${aiResult.variants?.length || 0} AI response variants for ${opportunity.username}`);

    res.json({
      message: 'AI responses generated successfully',
      opportunity_id: id,
      variants: aiResult.variants || [],
    });
  } catch (error) {
    console.error('[API] POST /api/opportunities/:id/respond error:', error.message);
    res.status(500).json({ error: 'Failed to generate responses', message: error.message });
  }
});

// ─── GET /api/queue ───────────────────────────────────────────────────────────
app.get('/api/queue', (req, res) => {
  try {
    const database = getDb();
    const { status, limit = '50', offset = '0' } = req.query;

    const conditions = [];
    const params = {};

    if (status) {
      conditions.push('q.status = @status');
      params.status = status;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countSql = `SELECT COUNT(*) as total FROM engagement_queue q ${whereClause}`;
    const countResult = database.prepare(countSql).get(params);

    // Data query with JOIN to opportunities
    const dataSql = `
      SELECT
        q.*,
        o.content as opportunity_content,
        o.username as opportunity_username,
        o.platform as opportunity_platform,
        o.intent_score as opportunity_intent_score,
        o.intent_type as opportunity_intent_type,
        o.subreddit as opportunity_subreddit,
        o.post_url as opportunity_post_url
      FROM engagement_queue q
      LEFT JOIN opportunities o ON q.opportunity_id = o.id
      ${whereClause}
      ORDER BY q.created_at DESC
      LIMIT @limit OFFSET @offset
    `;
    params.limit = parseInt(limit, 10);
    params.offset = parseInt(offset, 10);

    const rows = database.prepare(dataSql).all(params);

    res.json({
      data: rows,
      total: countResult.total,
      limit: params.limit,
      offset: params.offset,
    });
  } catch (error) {
    console.error('[API] GET /api/queue error:', error.message);
    res.status(500).json({ error: 'Failed to fetch queue', message: error.message });
  }
});

// ─── POST /api/queue/:id/approve ──────────────────────────────────────────────
app.post('/api/queue/:id/approve', (req, res) => {
  try {
    const database = getDb();
    const { id } = req.params;

    // Check if item exists
    const item = database.prepare('SELECT * FROM engagement_queue WHERE id = ?').get(id);
    if (!item) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    // Update status to approved
    database.prepare(`
      UPDATE engagement_queue
      SET status = 'approved', updated_at = datetime('now')
      WHERE id = ?
    `).run(id);

    // Update opportunity status too
    if (item.opportunity_id) {
      database.prepare(`
        UPDATE opportunities
        SET status = 'approved', updated_at = datetime('now')
        WHERE id = ?
      `).run(item.opportunity_id);
    }

    logActivity('engagement_queue', id, 'approved', `Approved queue item for ${item.recipient_username}`);

    res.json({ message: 'Queue item approved', id });
  } catch (error) {
    console.error('[API] POST /api/queue/:id/approve error:', error.message);
    res.status(500).json({ error: 'Failed to approve queue item', message: error.message });
  }
});

// ─── POST /api/queue/:id/reject ───────────────────────────────────────────────
app.post('/api/queue/:id/reject', (req, res) => {
  try {
    const database = getDb();
    const { id } = req.params;
    const { reason = 'No reason provided' } = req.body;

    // Check if item exists
    const item = database.prepare('SELECT * FROM engagement_queue WHERE id = ?').get(id);
    if (!item) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    // Update status to rejected
    database.prepare(`
      UPDATE engagement_queue
      SET status = 'rejected', error_message = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, id);

    logActivity('engagement_queue', id, 'rejected', `Rejected queue item for ${item.recipient_username}: ${reason}`);

    res.json({ message: 'Queue item rejected', id, reason });
  } catch (error) {
    console.error('[API] POST /api/queue/:id/reject error:', error.message);
    res.status(500).json({ error: 'Failed to reject queue item', message: error.message });
  }
});

// ─── GET /api/analytics ───────────────────────────────────────────────────────
app.get('/api/analytics', (req, res) => {
  try {
    const database = getDb();

    // Total opportunities
    const totalOpportunities = database.prepare('SELECT COUNT(*) as count FROM opportunities').get();

    // Average intent score
    const avgIntentScore = database.prepare('SELECT COALESCE(AVG(intent_score), 0) as avg FROM opportunities').get();

    // Engagement rate (engaged / total)
    const engagedCount = database.prepare('SELECT COUNT(*) as count FROM opportunities WHERE engaged = 1').get();
    const totalCount = totalOpportunities.count || 1;
    const engagementRate = Math.round((engagedCount.count / totalCount) * 100);

    // Platform breakdown
    const platformBreakdown = database.prepare(`
      SELECT platform, COUNT(*) as count FROM opportunities GROUP BY platform ORDER BY count DESC
    `).all();

    // Daily discovery (last 7 days)
    const dailyDiscovery = database.prepare(`
      SELECT date(discovered_at) as date, COUNT(*) as count
      FROM opportunities
      GROUP BY date(discovered_at)
      ORDER BY date DESC
      LIMIT 7
    `).all();

    // Score distribution
    const ranges = [
      { range: '90-100', min: 90, max: 100 },
      { range: '80-89', min: 80, max: 89 },
      { range: '70-79', min: 70, max: 79 },
      { range: '60-69', min: 60, max: 69 },
      { range: '0-59', min: 0, max: 59 },
    ];

    const scoreDistribution = ranges.map((r) => {
      const result = database.prepare(`
        SELECT COUNT(*) as count FROM opportunities WHERE intent_score >= ? AND intent_score <= ?
      `).get(r.min, r.max);
      return { range: r.range, count: result.count };
    });

    // Intent type breakdown
    const intentTypeBreakdown = database.prepare(`
      SELECT intent_type, COUNT(*) as count FROM opportunities WHERE intent_type IS NOT NULL GROUP BY intent_type
    `).all();

    // Subreddit breakdown (Reddit only)
    const subredditBreakdown = database.prepare(`
      SELECT subreddit, COUNT(*) as count FROM opportunities WHERE platform = 'reddit' AND subreddit IS NOT NULL GROUP BY subreddit ORDER BY count DESC
    `).all();

    // Queue status breakdown
    const queueBreakdown = database.prepare(`
      SELECT status, COUNT(*) as count FROM engagement_queue GROUP BY status
    `).all();

    // Recent activity
    const recentActivity = database.prepare(`
      SELECT * FROM activities ORDER BY created_at DESC LIMIT 20
    `).all();

    res.json({
      totalOpportunities: totalOpportunities.count || 0,
      avgIntentScore: Math.round(avgIntentScore.avg || 0),
      engagementRate,
      platformBreakdown,
      dailyDiscovery,
      scoreDistribution,
      intentTypeBreakdown,
      subredditBreakdown,
      queueBreakdown,
      recentActivity,
    });
  } catch (error) {
    console.error('[API] GET /api/analytics error:', error.message);
    res.status(500).json({ error: 'Failed to fetch analytics', message: error.message });
  }
});

// ─── GET /api/settings ────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  try {
    const database = getDb();
    const settings = database.prepare('SELECT * FROM brand_settings WHERE id = 1').get();

    if (!settings) {
      return res.status(404).json({ error: 'Settings not found' });
    }

    // Parse JSON fields
    const parsedSettings = {
      ...settings,
      keywords: safeJsonParse(settings.keywords, []),
      platforms_enabled: safeJsonParse(settings.platforms_enabled, []),
    };

    res.json(parsedSettings);
  } catch (error) {
    console.error('[API] GET /api/settings error:', error.message);
    res.status(500).json({ error: 'Failed to fetch settings', message: error.message });
  }
});

// ─── PATCH /api/settings ──────────────────────────────────────────────────────
app.patch('/api/settings', (req, res) => {
  try {
    const database = getDb();
    const updates = req.body;

    // Build dynamic update
    const allowedFields = ['brand_name', 'tone', 'product_description', 'keywords', 'platforms_enabled', 'auto_engage_threshold'];
    const setClauses = [];
    const values = [];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        // If it's an array field, stringify it
        if ((field === 'keywords' || field === 'platforms_enabled') && Array.isArray(updates[field])) {
          setClauses.push(`${field} = ?`);
          values.push(JSON.stringify(updates[field]));
        } else {
          setClauses.push(`${field} = ?`);
          values.push(updates[field]);
        }
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const sql = `UPDATE brand_settings SET ${setClauses.join(', ')} WHERE id = 1`;
    database.prepare(sql).run(...values);

    // Fetch updated settings
    const updated = database.prepare('SELECT * FROM brand_settings WHERE id = 1').get();
    const parsedUpdated = {
      ...updated,
      keywords: safeJsonParse(updated.keywords, []),
      platforms_enabled: safeJsonParse(updated.platforms_enabled, []),
    };

    logActivity('settings', '1', 'settings_updated', `Brand settings updated`);

    res.json({ message: 'Settings updated', settings: parsedUpdated });
  } catch (error) {
    console.error('[API] PATCH /api/settings error:', error.message);
    res.status(500).json({ error: 'Failed to update settings', message: error.message });
  }
});

// ─── POST /api/bulk/approve ───────────────────────────────────────────────────
app.post('/api/bulk/approve', (req, res) => {
  try {
    const database = getDb();
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }

    // Use transaction for bulk update
    const update = database.prepare('UPDATE engagement_queue SET status = \'approved\', updated_at = datetime(\'now\') WHERE id = ?');
    const updateOpp = database.prepare('UPDATE opportunities SET status = \'approved\', updated_at = datetime(\'now\') WHERE id = (SELECT opportunity_id FROM engagement_queue WHERE id = ?)');

    let updatedCount = 0;
    const updateMany = database.transaction((itemIds) => {
      for (const id of itemIds) {
        const result = update.run(id);
        if (result.changes > 0) {
          updatedCount++;
          try { updateOpp.run(id); } catch (e) { /* ignore opp update errors */ }
        }
      }
    });

    updateMany(ids);

    logActivity('engagement_queue', 'bulk', 'bulk_approved', `Bulk approved ${updatedCount} queue items`);

    res.json({ message: `Approved ${updatedCount} queue items`, updated: updatedCount });
  } catch (error) {
    console.error('[API] POST /api/bulk/approve error:', error.message);
    res.status(500).json({ error: 'Failed to bulk approve', message: error.message });
  }
});

// ─── POST /api/bulk/reject ────────────────────────────────────────────────────
app.post('/api/bulk/reject', (req, res) => {
  try {
    const database = getDb();
    const { ids, reason = 'Bulk rejection' } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }

    const update = database.prepare('UPDATE engagement_queue SET status = \'rejected\', error_message = ?, updated_at = datetime(\'now\') WHERE id = ?');

    let updatedCount = 0;
    const updateMany = database.transaction((itemIds) => {
      for (const id of itemIds) {
        const result = update.run(reason, id);
        if (result.changes > 0) {
          updatedCount++;
        }
      }
    });

    updateMany(ids);

    logActivity('engagement_queue', 'bulk', 'bulk_rejected', `Bulk rejected ${updatedCount} queue items: ${reason}`);

    res.json({ message: `Rejected ${updatedCount} queue items`, updated: updatedCount, reason });
  } catch (error) {
    console.error('[API] POST /api/bulk/reject error:', error.message);
    res.status(500).json({ error: 'Failed to bulk reject', message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  EXTRA UTILITY ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/activities ──────────────────────────────────────────────────────
app.get('/api/activities', (req, res) => {
  try {
    const database = getDb();
    const { limit = '20', offset = '0' } = req.query;

    const total = database.prepare('SELECT COUNT(*) as total FROM activities').get();
    const rows = database.prepare(`
      SELECT * FROM activities ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(parseInt(limit, 10), parseInt(offset, 10));

    res.json({
      data: rows,
      total: total.total,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });
  } catch (error) {
    console.error('[API] GET /api/activities error:', error.message);
    res.status(500).json({ error: 'Failed to fetch activities', message: error.message });
  }
});

// ─── POST /api/opportunities/:id/engage ───────────────────────────────────────
app.post('/api/opportunities/:id/engage', (req, res) => {
  try {
    const database = getDb();
    const { id } = req.params;
    const { responseText } = req.body;

    // Check if opportunity exists
    const opp = database.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
    if (!opp) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    // Create queue entry with the provided response text
    const insertQueue = database.prepare(`
      INSERT INTO engagement_queue (id, opportunity_id, platform, response_text, post_url, recipient_username, status, created_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `);

    const response = responseText || (opp.ai_responses ? safeJsonParse(opp.ai_responses, null)?.variants?.[0]?.text : null);

    if (!response) {
      return res.status(400).json({ error: 'No response text available. Generate AI responses first or provide responseText in body.' });
    }

    insertQueue.run(id, opp.platform, response, opp.post_url, opp.username);

    // Update opportunity status
    database.prepare(`
      UPDATE opportunities SET status = 'queued', updated_at = datetime('now') WHERE id = ?
    `).run(id);

    logActivity('opportunity', id, 'queued', `Manually queued engagement for ${opp.username}`);

    res.json({ message: 'Opportunity queued for engagement', opportunity_id: id, response });
  } catch (error) {
    console.error('[API] POST /api/opportunities/:id/engage error:', error.message);
    res.status(500).json({ error: 'Failed to queue engagement', message: error.message });
  }
});

// ─── GET /api/platforms ───────────────────────────────────────────────────────
app.get('/api/platforms', (req, res) => {
  try {
    const database = getDb();
    const platforms = database.prepare(`
      SELECT platform, COUNT(*) as opportunity_count,
             AVG(intent_score) as avg_intent_score
      FROM opportunities
      GROUP BY platform
      ORDER BY opportunity_count DESC
    `).all();

    res.json({ data: platforms });
  } catch (error) {
    console.error('[API] GET /api/platforms error:', error.message);
    res.status(500).json({ error: 'Failed to fetch platforms', message: error.message });
  }
});

// ─── POST /api/opportunities (manual creation) ────────────────────────────────
app.post('/api/opportunities', (req, res) => {
  try {
    const database = getDb();
    const {
      id,
      platform,
      username,
      content,
      intent_type,
      intent_score,
      subreddit,
      post_url,
      media_url,
      keywords_matched,
      raw_data,
    } = req.body;

    if (!platform || !username || !content) {
      return res.status(400).json({ error: 'platform, username, and content are required' });
    }

    const oppId = id || `opp_${platform}_${Date.now()}`;

    database.prepare(`
      INSERT INTO opportunities (id, platform, username, content, intent_type, intent_score, subreddit, post_url, media_url, keywords_matched, raw_data, discovered_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'new')
    `).run(
      oppId,
      platform,
      username,
      content,
      intent_type || null,
      intent_score || 0,
      subreddit || null,
      post_url || null,
      media_url || null,
      Array.isArray(keywords_matched) ? JSON.stringify(keywords_matched) : keywords_matched || null,
      typeof raw_data === 'object' ? JSON.stringify(raw_data) : raw_data || null
    );

    logActivity('opportunity', oppId, 'manual_created', `Manually created opportunity from ${platform} by ${username}`);

    res.status(201).json({ message: 'Opportunity created', id: oppId });
  } catch (error) {
    console.error('[API] POST /api/opportunities error:', error.message);
    res.status(500).json({ error: 'Failed to create opportunity', message: error.message });
  }
});

// ─── DELETE /api/opportunities/:id ────────────────────────────────────────────
app.delete('/api/opportunities/:id', (req, res) => {
  try {
    const database = getDb();
    const { id } = req.params;

    // Check if opportunity exists
    const opp = database.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
    if (!opp) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    // Delete related queue items first (foreign key handles this, but let's be explicit)
    database.prepare('DELETE FROM engagement_queue WHERE opportunity_id = ?').run(id);

    // Delete the opportunity
    database.prepare('DELETE FROM opportunities WHERE id = ?').run(id);

    logActivity('opportunity', id, 'deleted', `Deleted opportunity ${id} and related queue items`);

    res.json({ message: 'Opportunity deleted', id });
  } catch (error) {
    console.error('[API] DELETE /api/opportunities/:id error:', error.message);
    res.status(500).json({ error: 'Failed to delete opportunity', message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path, method: req.method });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[Server] Unhandled error:', err.message);
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

initDb();
seedData();

app.listen(PORT, () => {
  console.log(`═══════════════════════════════════════════`);
  console.log(`  PeptideProspect AI - SQLite Backend v${VERSION}`);
  console.log(`  Listening on port ${PORT}`);
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  OpenAI API: ${OPENAI_API_KEY ? 'Configured ✓' : 'NOT CONFIGURED ✗'}`);
  console.log(`═══════════════════════════════════════════`);
});

module.exports = app;
