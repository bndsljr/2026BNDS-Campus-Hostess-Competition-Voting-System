/**
 * 数据层：SQLite（Node 内置 node:sqlite，零原生依赖），建表、种子数据、系统设置读写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { DB_FILE, DATA_DIR, ADMIN_MAX_FAILS, ADMIN_LOCK_MINUTES, SESSION_HOURS } from './config.js';
import { nowIso, randomCode, randomPassword, formatCode } from './util.js';

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  note          TEXT
);

CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  no         INTEGER NOT NULL DEFAULT 0,
  name       TEXT NOT NULL,
  photo      TEXT,
  tag        TEXT,
  intro      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voting_codes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL,
  label         TEXT,
  judge_slot    INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT,
  login_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_codes_role ON voting_codes(role);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  code_id    INTEGER,
  admin_id   INTEGER,
  label      TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  ua         TEXT
);

CREATE TABLE IF NOT EXISTS votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  competition   TEXT NOT NULL,
  code_id       INTEGER,
  code_snapshot TEXT,
  role          TEXT NOT NULL DEFAULT 'public',
  ip            TEXT,
  ua            TEXT,
  created_at    TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'self',
  invalid       INTEGER NOT NULL DEFAULT 0,
  operator      TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_votes_comp ON votes(competition, invalid);
CREATE INDEX IF NOT EXISTS idx_votes_code ON votes(code_id, competition);

CREATE TABLE IF NOT EXISTS vote_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  vote_id   INTEGER NOT NULL,
  player_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_vote ON vote_items(vote_id);
CREATE INDEX IF NOT EXISTS idx_items_player ON vote_items(player_id);

CREATE TABLE IF NOT EXISTS scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  competition TEXT NOT NULL,
  judge_slot  INTEGER NOT NULL,
  code_id     INTEGER,
  player_id   INTEGER NOT NULL,
  score       REAL NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'self',
  operator    TEXT,
  note        TEXT,
  UNIQUE (competition, judge_slot, player_id)
);

CREATE TABLE IF NOT EXISTS results (
  competition   TEXT NOT NULL,
  player_id     INTEGER NOT NULL,
  public_votes  INTEGER NOT NULL DEFAULT 0,
  public_rank   INTEGER,
  public_points REAL NOT NULL DEFAULT 0,
  pro_judges    INTEGER NOT NULL DEFAULT 0,
  pro_sum       REAL NOT NULL DEFAULT 0,
  pro_avg       REAL NOT NULL DEFAULT 0,
  raw_score     REAL NOT NULL DEFAULT 0,
  final_score   REAL NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (competition, player_id)
);

CREATE TABLE IF NOT EXISTS final_results (
  player_id        INTEGER PRIMARY KEY,
  group_score      REAL NOT NULL DEFAULT 0,
  individual_score REAL NOT NULL DEFAULT 0,
  total_score      REAL NOT NULL DEFAULT 0,
  final_rank       INTEGER,
  tie_note         TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor_type  TEXT NOT NULL,
  actor       TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  before_json TEXT,
  after_json  TEXT,
  ip          TEXT,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  identifier TEXT,
  ip         TEXT,
  ua         TEXT,
  success    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_at ON login_attempts(at DESC);
`;

/** 系统设置默认值（后台可改） */
export const DEFAULT_SETTINGS = {
  event_title: '2026 主持人大赛',
  event_subtitle: '投票系统',
  footer_note: '',

  // 赛程开关
  group_enabled: '0',
  group_start_at: '',
  group_end_at: '',
  individual_enabled: '0',
  individual_start_at: '',
  individual_end_at: '',

  // 投票规则（以下均为示例默认值，实际规则在后台「系统设置」中配置）
  public_pick_count: '2',
  top_points: '5',
  zero_vote_points: '0',
  tie_rank_rule: 'best', // 并列取最优名次，后续名次跳过
  judge_count: '3',
  missing_judge_rule: 'submitted', // submitted=按实际提交人数平均 / all=缺评记 0 分后除以总人数
  pro_can_edit: '1',
  auto_recalc: '1',

  // 计分与总成绩
  weight_group: '0.5',
  weight_individual: '0.5',
  score_cap: '105',
  score_decimals: '2',
  final_tie_break: 'individual', // individual | group | pro_avg

  // 界面
  theme_color: '#1b3a6b',
  accent_color: '#c8a45c',
  board_public: '0',

  // 安全
  login_rate_max: '5000',          // 同一 IP 在窗口期内允许的密码条登录次数
  login_rate_window_minutes: '5',
  admin_max_fails: String(ADMIN_MAX_FAILS),
  admin_lock_minutes: String(ADMIN_LOCK_MINUTES),
  session_hours: String(SESSION_HOURS),
};

let db = null;

export function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_FILE);
    db.exec(SCHEMA);
    seedSettings();
    seedPlayers();
    seedCodes();
    seedAdmin();
  }
  return db;
}

/* ------------------------------------------------------------------ 设置 ---- */

function seedSettings() {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    stmt.run(key, String(value), nowIso());
  }
}

export function getSetting(key, fallback = undefined) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback !== undefined ? fallback : DEFAULT_SETTINGS[key];
  return row.value;
}

export function getSettingsObject() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function getSettings() {
  const raw = getSettingsObject();
  return {
    ...raw,
    publicPickCount: Number(raw.public_pick_count || 2),
    topPoints: Number(raw.top_points || 5),
    zeroVotePoints: Number(raw.zero_vote_points || 0),
    judgeCount: Number(raw.judge_count || 3),
    weightGroup: Number(raw.weight_group || 0.5),
    weightIndividual: Number(raw.weight_individual || 0.5),
    scoreCap: Number(raw.score_cap || 105),
    decimals: Number(raw.score_decimals || 2),
    loginRateMax: Number(raw.login_rate_max || 5000),
    loginRateWindowMs: Number(raw.login_rate_window_minutes || 5) * 60 * 1000,
    adminMaxFails: Number(raw.admin_max_fails || ADMIN_MAX_FAILS),
    adminLockMinutes: Number(raw.admin_lock_minutes || ADMIN_LOCK_MINUTES),
    sessionHours: Number(raw.session_hours || SESSION_HOURS),
    groupEnabled: raw.group_enabled === '1',
    individualEnabled: raw.individual_enabled === '1',
    boardPublic: raw.board_public === '1',
    proCanEdit: raw.pro_can_edit === '1',
    autoRecalc: raw.auto_recalc === '1',
  };
}

export function setSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, String(value ?? ''), nowIso());
}

/* ------------------------------------------------------------ 种子数据 ---- */

function seedPlayers() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM players').get().c;
  if (count > 0) return;
  const stmt = db.prepare(
    `INSERT INTO players (no, name, photo, tag, intro, active, sort_order, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, 1, ?, ?, ?)`
  );
  const ts = nowIso();
  for (let i = 1; i <= 10; i++) stmt.run(i, `选手${String(i).padStart(2, '0')}`, i, ts, ts);
  console.log('[db] 已创建 10 位选手占位数据（请在后台改为真实姓名与照片）');
}

function seedCodes() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM voting_codes').get().c;
  if (count > 0) return;
  const ts = nowIso();
  const insert = db.prepare(
    `INSERT INTO voting_codes (code, role, label, judge_slot, enabled, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  );
  const created = [];
  // 4 位专业评审：绑定评审席 1-4
  const judgeCount = Number(getSetting('judge_count', '4'));
  for (let slot = 1; slot <= judgeCount; slot++) {
    const code = randomCode(8);
    insert.run(code, 'pro', `专业评审${slot}`, slot, '初始自动生成', ts, ts);
    created.push({ code, role: 'pro', label: `专业评审${slot}` });
  }
  // 大众评审：默认生成 20 条，可在后台按实际人数重新生成
  const publicCount = Number(process.env.HV_SEED_PUBLIC_CODES || 20);
  for (let i = 1; i <= publicCount; i++) {
    const code = randomCode(8);
    insert.run(code, 'public', `大众评审${String(i).padStart(2, '0')}`, null, '初始自动生成', ts, ts);
    created.push({ code, role: 'public', label: `大众评审${String(i).padStart(2, '0')}` });
  }
  writeInitialCodes(created);
}

function writeInitialCodes(created) {
  try {
    const file = path.join(DATA_DIR, 'INITIAL_CODES.txt');
    const lines = [
      '=== 2026 主持人大赛投票系统 · 初始密码条 ===',
      `生成时间：${nowIso()}`,
      '密码条用于投票入口登录；两类权限已绑定。可在后台 /manage/codes 重新生成或修改。',
      '',
      ...created.map((c) => `${formatCode(c.code)}\t${c.label}\t(${c.role === 'pro' ? '专业评审-百分制打分' : '大众评审-勾选3人投票'})`),
      '',
    ];
    fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
    console.log(`[db] 初始密码条已写入 ${file}`);
  } catch (err) {
    console.error('[db] 写入初始密码条失败', err.message);
  }
}

function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  if (count > 0) return;
  const username = process.env.HV_ADMIN_USER || 'admin';
  const password = process.env.HV_ADMIN_PASS || randomPassword(14);
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO admins (username, password_hash, created_at, note) VALUES (?, ?, ?, ?)').run(
    username,
    hash,
    nowIso(),
    '初始超级管理员'
  );
  const file = path.join(DATA_DIR, 'INITIAL_ADMIN.txt');
  fs.writeFileSync(
    file,
    [
      '=== 后台管理账号 ===',
      `后台地址：http://<服务器IP>/manage`,
      `账号：${username}`,
      `密码：${password}`,
      `生成时间：${nowIso()}`,
      '请登录后立即在【系统设置】中修改密码；此文件仅保留初始凭据。',
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  console.log(`[db] 已创建管理员账号 ${username}，初始密码见 ${file}`);
}

export function closeDb() {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}
