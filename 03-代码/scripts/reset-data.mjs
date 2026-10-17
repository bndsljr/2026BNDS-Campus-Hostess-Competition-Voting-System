/**
 * 数据重置：清空投票、打分、排名、日志等运行数据，使系统回到「可正式使用」的干净状态。
 * 选手名单与密码条默认保留，可用参数一并清空。
 *
 *   node scripts/reset-data.mjs --yes                     # 清空投票/打分/日志，保留选手与密码条
 *   node scripts/reset-data.mjs --yes --clear-codes       # 连密码条一起清空
 *   node scripts/reset-data.mjs --yes --clear-players     # 连选手一起清空
 *   node scripts/reset-data.mjs --yes --keep-audit        # 保留操作日志
 *
 * 注意：不可恢复。执行前请先备份（node scripts/backup.mjs）。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/loadenv.js';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_FILE = process.env.HV_DB || path.join(process.env.HV_DATA_DIR || path.join(ROOT, 'data'), 'hostvote.db');

const args = new Set(process.argv.slice(2));
const confirmed = args.has('--yes') || args.has('-y');
const clearCodes = args.has('--clear-codes');
const clearPlayers = args.has('--clear-players');
const keepAudit = args.has('--keep-audit');

if (!confirmed) {
  console.log('这是危险操作：将清空全部投票、打分与排名数据（不可恢复）。');
  console.log('确认后请追加 --yes 重新执行，例如：');
  console.log('  node scripts/reset-data.mjs --yes');
  process.exit(1);
}

if (!fs.existsSync(DB_FILE)) {
  console.error(`找不到数据库：${DB_FILE}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;

console.log('重置前统计：');
for (const t of ['votes', 'vote_items', 'scores', 'results', 'final_results', 'audit_logs', 'login_attempts', 'sessions', 'voting_codes', 'players']) {
  console.log(`  ${t.padEnd(16)} ${count(t)}`);
}

db.exec('BEGIN IMMEDIATE');
try {
  db.exec('DELETE FROM vote_items');
  db.exec('DELETE FROM votes');
  db.exec('DELETE FROM scores');
  db.exec('DELETE FROM results');
  db.exec('DELETE FROM final_results');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM login_attempts');
  if (!keepAudit) db.exec('DELETE FROM audit_logs');

  if (clearCodes) {
    db.exec('DELETE FROM voting_codes');
  } else {
    db.exec('UPDATE voting_codes SET login_count = 0, last_login_at = NULL');
  }
  if (clearPlayers) db.exec('DELETE FROM players');

  // 赛程回到「未开启」，避免带着测试用的开启状态上线
  for (const key of ['group_enabled', 'individual_enabled']) {
    db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?').run('0', new Date().toISOString(), key);
  }
  for (const key of ['group_start_at', 'group_end_at', 'individual_start_at', 'individual_end_at']) {
    db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?').run('', new Date().toISOString(), key);
  }
  db.exec('COMMIT');
  console.log('已清空运行数据，赛程开关已重置为「未开启」。');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('重置失败，已回滚：', err.message);
  db.close();
  process.exit(1);
} finally {
  // 清理 WAL，缩小文件体积
}

db.exec('VACUUM');
db.close();
console.log('数据库已整理（VACUUM）。请重启服务以重新计算空排名：systemctl restart hostvote');
