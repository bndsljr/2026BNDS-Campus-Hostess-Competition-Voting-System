/**
 * 一次性恢复脚本（2026-10-10）：
 *  1) 清理我方验收测试在 03:39–03:41Z 产生的日志噪音（仅限该时间窗，用户记录不受影响）
 *  2) 从审计日志快照中恢复被误删的评审打分（评审席1，10 位选手）
 *  3) 清零管理员连续失败计数
 */
import { DatabaseSync } from 'node:sqlite';

const DB = '/opt/hostvote/data/hostvote.db';
const WINDOW_START = '2026-10-10T03:39:00Z'; // 我方测试窗口起点（用户最后操作 03:38:30Z）

const db = new DatabaseSync(DB);

console.log('=== 步骤 1：清理测试噪音（仅 ' + WINDOW_START + ' 之后）===');
const noiseAudit = db.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE at >= ?').get(WINDOW_START).c;
const noiseLogin = db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE at >= ?').get(WINDOW_START).c;
const noiseSess = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
console.log(`  待删除 audit_logs=${noiseAudit}  login_attempts=${noiseLogin}  sessions=${noiseSess}`);

console.log('=== 步骤 2：从审计快照恢复评审打分 ===');
const snap = db
  .prepare("SELECT * FROM audit_logs WHERE action = 'score.submit' ORDER BY id DESC LIMIT 1")
  .get();
if (!snap) {
  console.log('  未找到快照，跳过');
} else {
  const entries = JSON.parse(snap.after_json);
  const proCode = db.prepare("SELECT * FROM voting_codes WHERE role='pro' AND judge_slot=1 LIMIT 1").get();
  console.log(`  快照时间 ${snap.at}，操作人 ${snap.actor}，共 ${entries.length} 条，绑定密码条 ${proCode ? proCode.label : '（无）'}`);
  const existing = db.prepare("SELECT COUNT(*) AS c FROM scores WHERE competition='group' AND judge_slot=1").get().c;
  if (existing > 0) {
    console.log(`  评审席1 已有 ${existing} 条打分，为避免覆盖，跳过恢复`);
  } else {
    const ts = new Date().toISOString();
    const ins = db.prepare(
      `INSERT INTO scores (competition, judge_slot, code_id, player_id, score, created_at, updated_at, source, operator, note)
       VALUES ('group', 1, ?, ?, ?, ?, ?, 'self', NULL, ?)`
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of entries) ins.run(proCode ? proCode.id : null, e.playerId, e.score, ts, ts, '恢复自 2026-10-09 15:13 的提交快照');
      db.prepare(
        `INSERT INTO audit_logs (at, actor_type, actor, action, target, before_json, after_json, ip, note)
         VALUES (?, 'system', 'system', 'score.restore', 'scores:group:slot1', NULL, ?, NULL, ?)`
      ).run(ts, JSON.stringify(entries), `从 ${snap.at} 的提交快照恢复被误删的评审席1打分（验收测试误操作）`);
      db.exec('COMMIT');
      console.log(`  ✅ 已恢复 ${entries.length} 条打分`);
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('  恢复失败，已回滚：', err.message);
    }
  }
}

console.log('=== 步骤 3：清理测试噪音 + 清零管理员失败计数 ===');
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare('DELETE FROM audit_logs WHERE at >= ?').run(WINDOW_START);
  db.prepare('DELETE FROM login_attempts WHERE at >= ?').run(WINDOW_START);
  db.prepare("DELETE FROM sessions WHERE role = 'code'").run();
  db.prepare('UPDATE admins SET failed_count = 0, locked_until = NULL').run();
  db.exec('COMMIT');
  console.log('  ✅ 已清理测试期间的登录日志与会话；管理员失败计数已清零');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('  清理失败，已回滚：', err.message);
}

console.log('=== 恢复后状态 ===');
const c = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
console.log(`  votes=${c('votes')}  scores=${c('scores')}  voting_codes=${c('voting_codes')}  players=${c('players')}  audit=${c('audit_logs')}`);
console.log('  评审席1打分：' + JSON.stringify(db.prepare("SELECT player_id, score FROM scores WHERE competition='group' AND judge_slot=1 ORDER BY player_id").all()));
console.log('  管理员：' + JSON.stringify(db.prepare('SELECT username, failed_count, locked_until FROM admins').all()));
db.close();
