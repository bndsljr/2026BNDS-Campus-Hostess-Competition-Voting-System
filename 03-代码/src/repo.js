/**
 * 数据访问 + 结果落库。所有写操作走事务；所有业务修改都会写审计日志。
 */
import { getDb, getSettings, setSetting } from './db.js';
import { computeCompetition, computeFinal } from './scoring.js';
import { nowIso, round } from './util.js';

/* ------------------------------------------------------------ 事务帮助 ---- */

export function tx(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/* -------------------------------------------------------------- 选手 ---- */

export function listPlayers({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM players WHERE active = 1 ORDER BY sort_order ASC, no ASC, id ASC'
    : 'SELECT * FROM players ORDER BY sort_order ASC, no ASC, id ASC';
  return getDb().prepare(sql).all();
}

export function getPlayer(id) {
  return getDb().prepare('SELECT * FROM players WHERE id = ?').get(Number(id));
}

export function createPlayer({ no, name, photo = null, tag = null, intro = null, active = 1 }) {
  const ts = nowIso();
  const maxOrder = getDb().prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM players').get().m;
  const info = getDb()
    .prepare(
      `INSERT INTO players (no, name, photo, tag, intro, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(Number(no) || 0, String(name || '').trim(), photo, tag, intro, active ? 1 : 0, maxOrder + 1, ts, ts);
  return Number(info.lastInsertRowid);
}

export function updatePlayer(id, fields) {
  const cur = getPlayer(id);
  if (!cur) return null;
  const next = {
    no: fields.no !== undefined ? Number(fields.no) || 0 : cur.no,
    name: fields.name !== undefined ? String(fields.name).trim() : cur.name,
    photo: fields.photo !== undefined ? fields.photo : cur.photo,
    tag: fields.tag !== undefined ? fields.tag : cur.tag,
    intro: fields.intro !== undefined ? fields.intro : cur.intro,
    active: fields.active !== undefined ? (fields.active ? 1 : 0) : cur.active,
    sort_order: fields.sort_order !== undefined ? Number(fields.sort_order) : cur.sort_order,
  };
  getDb()
    .prepare(
      `UPDATE players SET no = ?, name = ?, photo = ?, tag = ?, intro = ?, active = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(next.no, next.name, next.photo, next.tag, next.intro, next.active, next.sort_order, nowIso(), Number(id));
  return { before: cur, after: getPlayer(id) };
}

export function deletePlayer(id) {
  const cur = getPlayer(id);
  const used = getDb().prepare('SELECT COUNT(*) AS c FROM vote_items WHERE player_id = ?').get(Number(id)).c;
  const scored = getDb().prepare('SELECT COUNT(*) AS c FROM scores WHERE player_id = ?').get(Number(id)).c;
  if (used > 0 || scored > 0) {
    const err = new Error('该选手已存在投票或打分数据，无法删除；如需停用请使用「停用」功能。');
    err.code = 'IN_USE';
    throw err;
  }
  getDb().prepare('DELETE FROM players WHERE id = ?').run(Number(id));
  return cur;
}

export function reorderPlayers(ids) {
  const stmt = getDb().prepare('UPDATE players SET sort_order = ?, updated_at = ? WHERE id = ?');
  const ts = nowIso();
  tx((db) => {
    ids.forEach((id, idx) => stmt.run(idx + 1, ts, Number(id)));
  });
}

/* ------------------------------------------------------------ 密码条 ---- */

export function listCodes({ role = null, q = null, enabled = null } = {}) {
  const where = [];
  const args = [];
  if (role) {
    where.push('role = ?');
    args.push(role);
  }
  if (enabled !== null) {
    where.push('enabled = ?');
    args.push(enabled ? 1 : 0);
  }
  if (q) {
    where.push('(code LIKE ? OR label LIKE ? OR note LIKE ?)');
    const like = `%${String(q).toUpperCase()}%`;
    args.push(like, `%${q}%`, `%${q}%`);
  }
  const sql = `SELECT * FROM voting_codes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY role ASC, judge_slot ASC, id ASC`;
  return getDb().prepare(sql).all(...args);
}

export function getCode(id) {
  return getDb().prepare('SELECT * FROM voting_codes WHERE id = ?').get(Number(id));
}

export function getCodeByValue(code) {
  return getDb().prepare('SELECT * FROM voting_codes WHERE code = ?').get(String(code || '').toUpperCase());
}

export function createCode({ code, role, label = null, judge_slot = null, enabled = 1, note = null }) {
  const ts = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO voting_codes (code, role, label, judge_slot, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(String(code).toUpperCase(), role, label, judge_slot === null ? null : Number(judge_slot), enabled ? 1 : 0, note, ts, ts);
  return Number(info.lastInsertRowid);
}

export function updateCode(id, fields) {
  const cur = getCode(id);
  if (!cur) return null;
  const next = {
    code: fields.code !== undefined ? String(fields.code).toUpperCase().trim() : cur.code,
    role: fields.role !== undefined ? fields.role : cur.role,
    label: fields.label !== undefined ? fields.label : cur.label,
    judge_slot:
      fields.judge_slot !== undefined ? (fields.judge_slot === '' || fields.judge_slot === null ? null : Number(fields.judge_slot)) : cur.judge_slot,
    enabled: fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : cur.enabled,
    note: fields.note !== undefined ? fields.note : cur.note,
  };
  getDb()
    .prepare(
      `UPDATE voting_codes SET code = ?, role = ?, label = ?, judge_slot = ?, enabled = ?, note = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(next.code, next.role, next.label, next.judge_slot, next.enabled, next.note, nowIso(), Number(id));
  return { before: cur, after: getCode(id) };
}

export function deleteCode(id) {
  const cur = getCode(id);
  getDb().prepare('DELETE FROM voting_codes WHERE id = ?').run(Number(id));
  return cur;
}

export function setCodeEnabled(id, enabled) {
  getDb().prepare('UPDATE voting_codes SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowIso(), Number(id));
}

export function touchCodeLogin(id) {
  getDb()
    .prepare('UPDATE voting_codes SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?')
    .run(nowIso(), Number(id));
}

/** 某密码条在各赛事的有效投票状态 */
export function codeVoteState(codeId) {
  const rows = getDb()
    .prepare(
      `SELECT competition, COUNT(*) AS c FROM votes
       WHERE code_id = ? AND invalid = 0 GROUP BY competition`
    )
    .all(Number(codeId));
  const out = { group: 0, individual: 0 };
  for (const r of rows) out[r.competition] = r.c;
  return out;
}

/** 批量查询所有密码条的投票状态：codeId → {group, individual} */
export function codeVoteStates() {
  const rows = getDb()
    .prepare(
      `SELECT code_id, competition, COUNT(*) AS c FROM votes
       WHERE invalid = 0 AND code_id IS NOT NULL GROUP BY code_id, competition`
    )
    .all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.code_id)) map.set(r.code_id, { group: 0, individual: 0 });
    map.get(r.code_id)[r.competition] = r.c;
  }
  return map;
}

/* -------------------------------------------------------------- 会话 ---- */

export function createSession({ sid, role, codeId = null, adminId = null, label = null, hours = 12, ip = null, ua = null }) {
  const now = Date.now();
  const expires = new Date(now + hours * 3600 * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (sid, role, code_id, admin_id, label, created_at, expires_at, ip, ua)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sid, role, codeId, adminId, label, nowIso(), expires, ip, ua);
  return expires;
}

export function getSession(sid) {
  if (!sid) return null;
  const row = getDb().prepare('SELECT * FROM sessions WHERE sid = ?').get(String(sid));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
    return null;
  }
  return row;
}

export function deleteSession(sid) {
  getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(String(sid));
}

export function purgeExpiredSessions() {
  const info = getDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
  return Number(info.changes || 0);
}

/* -------------------------------------------------------------- 投票 ---- */

export function validVotes(competition) {
  return getDb()
    .prepare('SELECT * FROM votes WHERE competition = ? AND invalid = 0 ORDER BY id ASC')
    .all(competition);
}

export function votesWithItems(competition) {
  const votes = getDb()
    .prepare('SELECT * FROM votes WHERE competition = ? ORDER BY id ASC')
    .all(competition);
  if (!votes.length) return [];
  const ids = votes.map((v) => v.id);
  const placeholders = ids.map(() => '?').join(',');
  const items = getDb()
    .prepare(`SELECT * FROM vote_items WHERE vote_id IN (${placeholders})`)
    .all(...ids);
  const byVote = new Map();
  for (const it of items) {
    if (!byVote.has(it.vote_id)) byVote.set(it.vote_id, []);
    byVote.get(it.vote_id).push(it.player_id);
  }
  for (const v of votes) v.playerIds = byVote.get(v.id) || [];
  return votes;
}

/** 选手ID → 有效票数 */
export function publicVotesByPlayer(competition) {
  const rows = getDb()
    .prepare(
      `SELECT vi.player_id, COUNT(*) AS c
       FROM vote_items vi JOIN votes v ON v.id = vi.vote_id
       WHERE v.competition = ? AND v.invalid = 0
       GROUP BY vi.player_id`
    )
    .all(competition);
  const map = new Map();
  for (const r of rows) map.set(r.player_id, r.c);
  return map;
}

/* -------------------------------------------------------------- 打分 ---- */

/** 评审席 → (选手ID → 分数) */
export function judgeScoresBySlot(competition) {
  const rows = getDb()
    .prepare('SELECT * FROM scores WHERE competition = ? ORDER BY judge_slot ASC, player_id ASC')
    .all(competition);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.judge_slot)) map.set(r.judge_slot, new Map());
    map.get(r.judge_slot).set(r.player_id, Number(r.score));
  }
  return map;
}

export function listScores(competition) {
  return getDb()
    .prepare('SELECT * FROM scores WHERE competition = ? ORDER BY judge_slot ASC, player_id ASC')
    .all(competition);
}

export function upsertScore({ competition, judgeSlot, playerId, score, codeId = null, source = 'self', operator = null, note = null }) {
  const ts = nowIso();
  const before = getDb()
    .prepare('SELECT * FROM scores WHERE competition = ? AND judge_slot = ? AND player_id = ?')
    .get(competition, Number(judgeSlot), Number(playerId));
  getDb()
    .prepare(
      `INSERT INTO scores (competition, judge_slot, code_id, player_id, score, created_at, updated_at, source, operator, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(competition, judge_slot, player_id) DO UPDATE SET
         score = excluded.score, updated_at = excluded.updated_at,
         source = excluded.source, operator = excluded.operator, note = excluded.note,
         code_id = COALESCE(excluded.code_id, scores.code_id)`
    )
    .run(competition, Number(judgeSlot), codeId, Number(playerId), Number(score), before?.created_at || ts, ts, source, operator, note);
  const after = getDb()
    .prepare('SELECT * FROM scores WHERE competition = ? AND judge_slot = ? AND player_id = ?')
    .get(competition, Number(judgeSlot), Number(playerId));
  return { before: before || null, after };
}

export function deleteScore(id) {
  const row = getDb().prepare('SELECT * FROM scores WHERE id = ?').get(Number(id));
  getDb().prepare('DELETE FROM scores WHERE id = ?').run(Number(id));
  return row;
}

/* ---------------------------------------------------------- 审计日志 ---- */

export function logAudit({ actorType = 'system', actor = null, action, target = null, before = null, after = null, ip = null, note = null }) {
  getDb()
    .prepare(
      `INSERT INTO audit_logs (at, actor_type, actor, action, target, before_json, after_json, ip, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nowIso(),
      actorType,
      actor,
      action,
      target,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      ip,
      note
    );
}

export function listAudit({ limit = 200, offset = 0, action = null, q = null } = {}) {
  const where = [];
  const args = [];
  if (action) {
    where.push('action = ?');
    args.push(action);
  }
  if (q) {
    where.push('(actor LIKE ? OR target LIKE ? OR note LIKE ? OR action LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sql = `SELECT * FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`;
  return getDb().prepare(sql).all(...args, Number(limit), Number(offset));
}

export function countAudit() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c;
}

export function logLoginAttempt({ kind, identifier, ip, ua, success }) {
  getDb()
    .prepare('INSERT INTO login_attempts (at, kind, identifier, ip, ua, success) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nowIso(), kind, identifier, ip, ua, success ? 1 : 0);
}

/* -------------------------------------------------------------- 管理员 ---- */

export function getAdminByUsername(username) {
  return getDb().prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim());
}

export function getAdmin(id) {
  return getDb().prepare('SELECT * FROM admins WHERE id = ?').get(Number(id));
}

export function listAdmins() {
  return getDb().prepare('SELECT id, username, created_at, last_login_at, failed_count, locked_until, note FROM admins ORDER BY id ASC').all();
}

export function createAdmin({ username, passwordHash, note = null }) {
  const info = getDb()
    .prepare('INSERT INTO admins (username, password_hash, created_at, note) VALUES (?, ?, ?, ?)')
    .run(String(username).trim(), passwordHash, nowIso(), note);
  return Number(info.lastInsertRowid);
}

export function updateAdminPassword(id, passwordHash) {
  getDb().prepare('UPDATE admins SET password_hash = ?, failed_count = 0, locked_until = NULL WHERE id = ?').run(passwordHash, Number(id));
}

export function deleteAdmin(id) {
  getDb().prepare('DELETE FROM admins WHERE id = ?').run(Number(id));
}

export function registerAdminFailure(id, maxFails, lockMinutes) {
  const row = getAdmin(id);
  if (!row) return null;
  const fails = Number(row.failed_count || 0) + 1;
  let lockedUntil = null;
  if (fails >= maxFails) lockedUntil = new Date(Date.now() + lockMinutes * 60000).toISOString();
  getDb().prepare('UPDATE admins SET failed_count = ?, locked_until = ? WHERE id = ?').run(fails, lockedUntil, Number(id));
  return { fails, lockedUntil };
}

export function resetAdminFailure(id) {
  getDb().prepare('UPDATE admins SET failed_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso(), Number(id));
}

export function unlockAdmin(id) {
  getDb().prepare('UPDATE admins SET failed_count = 0, locked_until = NULL WHERE id = ?').run(Number(id));
}

/* ---------------------------------------------------------- 结果计算 ---- */

/** 只计算不落库：从当前数据库状态推导某赛事的完整结果（含全部中间量） */
export function computeOnly(competition, settings = getSettings()) {
  const s = settings;
  const players = listPlayers({ activeOnly: true });
  const votes = publicVotesByPlayer(competition);
  const scores = judgeScoresBySlot(competition);
  return computeCompetition({
    players,
    votesByPlayer: votes,
    judgeScores: scores,
    opts: {
      topPoints: s.topPoints,
      zeroVotePoints: s.zeroVotePoints,
      judgeCount: s.judgeCount,
      missingJudgeRule: s.missing_judge_rule,
      scoreCap: s.scoreCap,
      decimals: s.decimals,
      tieRankRule: s.tie_rank_rule,
    },
  });
}

/** 只计算不落库：两个赛事 + 最终总成绩 */
export function computeAllOnly(settings = getSettings()) {
  const s = settings;
  const group = computeOnly('group', s);
  const individual = computeOnly('individual', s);
  const players = listPlayers({ activeOnly: true });
  const final = computeFinal({
    group,
    individual,
    players,
    opts: {
      weightGroup: s.weightGroup,
      weightIndividual: s.weightIndividual,
      decimals: s.decimals,
      tieBreak: s.final_tie_break,
    },
  });
  return { group, individual, final };
}

/**
 * 干跑：在事务中执行 fn 造成的变更 → 计算新结果 → 回滚，用于「改前/改后」对比预览。
 * fn 内部的写操作必须具备事务安全性（只做 INSERT/UPDATE/DELETE）。
 */
export function dryRun(fn) {
  const db = getDb();
  const before = computeAllOnly();
  db.exec('BEGIN IMMEDIATE');
  let after;
  try {
    fn(db);
    after = computeAllOnly();
  } finally {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
  }
  return { before, after };
}

/** 重算某赛事并落库，返回完整计算结果（含全部中间量） */
export function recomputeCompetition(competition) {
  const result = computeOnly(competition);
  persistResults(competition, result);
  return result;
}

function persistResults(competition, result) {
  const ts = nowIso();
  tx((db) => {
    const stmt = db.prepare(
      `INSERT INTO results (competition, player_id, public_votes, public_rank, public_points, pro_judges, pro_sum, pro_avg, raw_score, final_score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(competition, player_id) DO UPDATE SET
         public_votes = excluded.public_votes, public_rank = excluded.public_rank,
         public_points = excluded.public_points, pro_judges = excluded.pro_judges,
         pro_sum = excluded.pro_sum, pro_avg = excluded.pro_avg,
         raw_score = excluded.raw_score, final_score = excluded.final_score,
         updated_at = excluded.updated_at`
    );
    for (const r of result.rows) {
      stmt.run(competition, r.playerId, r.publicVotes, r.publicRank, r.publicPoints, r.judgeSubmitted, r.judgeSum, r.proAvg, r.rawScore, r.finalScore, ts);
    }
    // 清理不再参赛（已停用或已删除）选手的残留行，避免结果页/公示榜显示已退出比赛的选手
    db.prepare(
      `DELETE FROM results WHERE competition = ? AND player_id NOT IN (SELECT id FROM players WHERE active = 1)`
    ).run(competition);
  });
}

/** 重算两个赛事 + 最终总成绩，返回 { group, individual, final } */
export function recomputeAll() {
  const { group, individual, final } = computeAllOnly();
  persistResults('group', group);
  persistResults('individual', individual);

  const ts = nowIso();
  tx((db) => {
    const stmt = db.prepare(
      `INSERT INTO final_results (player_id, group_score, individual_score, total_score, final_rank, tie_note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         group_score = excluded.group_score, individual_score = excluded.individual_score,
         total_score = excluded.total_score, final_rank = excluded.final_rank,
         tie_note = excluded.tie_note, updated_at = excluded.updated_at`
    );
    for (const r of final.rows) {
      stmt.run(r.playerId, r.groupScore, r.individualScore, r.totalScore, r.finalRank, r.tieNote || null, ts);
    }
    db.prepare('DELETE FROM final_results WHERE player_id NOT IN (SELECT id FROM players WHERE active = 1)').run();
  });

  return { group, individual, final };
}

export function getStoredResults(competition) {
  return getDb()
    .prepare(
      `SELECT r.*, p.name, p.no, p.photo FROM results r
       JOIN players p ON p.id = r.player_id
       WHERE r.competition = ? ORDER BY r.public_rank ASC, p.no ASC`
    )
    .all(competition);
}

export function getStoredFinal() {
  return getDb()
    .prepare(
      `SELECT f.*, p.name, p.no, p.photo FROM final_results f
       JOIN players p ON p.id = f.player_id
       ORDER BY f.final_rank ASC, p.no ASC`
    )
    .all();
}

/* ---------------------------------------------------------- 统计概览 ---- */

export function dashboardStats() {
  const db = getDb();
  const s = getSettings();
  const players = listPlayers({ activeOnly: true });
  const codes = db
    .prepare(
      `SELECT role, COUNT(*) AS total, SUM(enabled) AS enabled FROM voting_codes GROUP BY role`
    )
    .all();
  const codeStats = { public: { total: 0, enabled: 0 }, pro: { total: 0, enabled: 0 } };
  for (const c of codes) codeStats[c.role] = { total: c.total, enabled: c.enabled || 0 };

  const ballot = (comp) =>
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM votes WHERE competition = ? AND invalid = 0) AS votes,
           (SELECT COUNT(*) FROM votes WHERE competition = ? AND source = 'manual' AND invalid = 0) AS manual,
           (SELECT COUNT(*) FROM votes WHERE competition = ? AND invalid = 1) AS invalid,
           (SELECT COUNT(DISTINCT judge_slot) FROM scores WHERE competition = ?) AS judgeSlots,
           (SELECT COUNT(*) FROM scores WHERE competition = ?) AS scoreRows`
      )
      .get(comp, comp, comp, comp, comp);

  return {
    settings: s,
    playerCount: players.length,
    activePlayers: players.length,
    codeStats,
    group: ballot('group'),
    individual: ballot('individual'),
    publicSubmitted: {
      group: db.prepare("SELECT COUNT(*) AS c FROM votes WHERE competition='group' AND invalid=0 AND role='public'").get().c,
      individual: db.prepare("SELECT COUNT(*) AS c FROM votes WHERE competition='individual' AND invalid=0 AND role='public'").get().c,
    },
    lastRecalc: db.prepare("SELECT MAX(updated_at) AS t FROM results").get().t,
  };
}

/** 赛事当前状态：closed / pending / open / manual */
export function competitionStatus(competition, settings = getSettings()) {
  const enabled = competition === 'group' ? settings.groupEnabled : settings.individualEnabled;
  const startAt = competition === 'group' ? settings.group_start_at : settings.individual_start_at;
  const endAt = competition === 'group' ? settings.group_end_at : settings.individual_end_at;
  const now = Date.now();
  if (!enabled) return { open: false, reason: 'closed', label: '未开启', startAt, endAt, enabled: false };
  if (startAt && now < new Date(startAt).getTime()) return { open: false, reason: 'pending', label: '尚未开始', startAt, endAt, enabled: true };
  if (endAt && now > new Date(endAt).getTime()) return { open: false, reason: 'ended', label: '已截止', startAt, endAt, enabled: true };
  return { open: true, reason: 'open', label: '进行中', startAt, endAt, enabled: true };
}

export { setSetting, round };
