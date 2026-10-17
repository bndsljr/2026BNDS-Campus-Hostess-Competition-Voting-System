/**
 * 生成演示数据（用于开源/演示环境，不含任何真实活动数据）
 *
 *   node scripts/seed-demo.mjs [目标目录]
 *
 * 会在目标目录创建一个全新的 hostvote.db，并填充：
 *   · 10 位「选手01…选手10」（无照片）
 *   · 4 条专业评审密码条（评审席 1-4）+ 60 条大众评审密码条
 *   · 约 100 条随机大众投票、4×10×2 格随机打分
 *   · 已计算好的排名结果
 *
 * 注意：所有密码条、票数、分数均为随机生成，与任何真实活动无关。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const target = path.resolve(process.argv[2] || path.join(ROOT, 'demo-data'));

fs.mkdirSync(path.join(target, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(target, '..', 'demo-backup'), { recursive: true });

// 用独立的数据目录实例化一个仅用于造数据的应用配置
process.env.HV_DATA_DIR = target;
process.env.HV_BACKUP_DIR = path.join(path.dirname(target), 'demo-backup');
process.env.HV_LOG_DIR = path.join(path.dirname(target), 'demo-logs');
process.env.HV_ADMIN_USER = 'admin';
process.env.HV_ADMIN_PASS = 'demo123456';
process.env.HV_SEED_PUBLIC_CODES = '20';

const DB_FILE = path.join(target, 'hostvote.db');
if (fs.existsSync(DB_FILE)) {
  console.error(`目标已存在数据库：${DB_FILE}\n如确认要覆盖，请先删除该文件。`);
  process.exit(1);
}

const { getDb, getSettings } = await import('../src/db.js');
const { recomputeAll } = await import('../src/repo.js');
const { nowIso, randomCode } = await import('../src/util.js');

const db = getDb();
const settings = getSettings();
console.log(`初始化数据库：${DB_FILE}`);

const players = db.prepare('SELECT id, no, name FROM players WHERE active=1 ORDER BY sort_order, no').all();
const judgeCount = settings.judgeCount;

/* ---------------------------------------------- 再补一批大众评审密码条 ---- */
const pubStmt = db.prepare(
  `INSERT INTO voting_codes (code, role, label, judge_slot, enabled, note, created_at, updated_at)
   VALUES (?, 'public', ?, NULL, 1, '演示数据', ?, ?)`
);
const existing = db.prepare("SELECT COUNT(*) c FROM voting_codes WHERE role='public'").get().c;
for (let i = existing; i < 60; i++) {
  const ts = nowIso();
  const code = (() => {
    for (let t = 0; t < 50; t++) {
      const c = randomCode(8);
      if (!db.prepare('SELECT 1 FROM voting_codes WHERE code=?').get(c)) return c;
    }
    throw new Error('随机码冲突');
  })();
  pubStmt.run(code, `大众评审${String(i + 1).padStart(2, '0')}`, ts, ts);
}
const pubCodes = db.prepare("SELECT id FROM voting_codes WHERE role='public' AND enabled=1").all();
console.log(`  大众评审密码条：${pubCodes.length} 条`);

/* ------------------------------------------------------------ 随机投票 ---- */
const pickCount = settings.publicPickCount;
let voteCount = 0;
const insertVote = db.prepare(
  `INSERT INTO votes (competition, code_id, code_snapshot, role, ip, ua, created_at, source, invalid, note)
   VALUES (?, ?, NULL, 'public', ?, ?, ?, 'self', 0, NULL)`
);
const insertItem = db.prepare('INSERT INTO vote_items (vote_id, player_id) VALUES (?, ?)');
const pickSome = (n) => {
  const pool = [...players];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].id);
  return out;
};
// 每位大众评审随机决定投不投、投几个（1..pickCount，可少选），两个赛事各自独立
for (const code of pubCodes) {
  for (const comp of ['group', 'individual']) {
    if (Math.random() > 0.72) continue; // 约 72% 的人参与
    const picks = pickSome(1 + Math.floor(Math.random() * pickCount));
    const vid = Number(
      insertVote.run(comp, code.id, '10.0.0.' + (1 + Math.floor(Math.random() * 200)), 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', nowIso()).lastInsertRowid
    );
    for (const pid of picks) insertItem.run(vid, pid);
    voteCount++;
  }
}
console.log(`  随机投票：${voteCount} 条`);

/* ------------------------------------------------------------ 随机打分 ---- */
const scoreStmt = db.prepare(
  `INSERT INTO scores (competition, judge_slot, code_id, player_id, score, created_at, updated_at, source, operator, note)
   VALUES (?, ?, NULL, ?, ?, ?, ?, 'self', NULL, '演示数据')`
);
let scoreCount = 0;
for (const comp of ['group', 'individual']) {
  for (let slot = 1; slot <= judgeCount; slot++) {
    for (const p of players) {
      const base = 72 + Math.floor(Math.random() * 27); // 72-98
      scoreStmt.run(comp, slot, p.id, base, nowIso(), nowIso());
      scoreCount++;
    }
  }
}
console.log(`  随机打分：${scoreCount} 格`);

/* ---------------------------------------------------------------- 重算 ---- */
recomputeAll();
const finalTop = db
  .prepare('SELECT p.name, f.final_rank, f.total_score FROM final_results f JOIN players p ON p.id = f.player_id ORDER BY f.final_rank LIMIT 3')
  .all();
console.log('  已生成排名，示例前三名：' + finalTop.map((r) => `${r.final_rank}. ${r.name} ${r.total_score}`).join(' / '));

db.prepare("UPDATE settings SET value='演示数据（非真实活动）' WHERE key='event_subtitle'").run();
db.close();

console.log(`\n完成：${path.join(target, 'hostvote.db')}`);
console.log('演示管理员：admin / demo123456（仅演示环境使用）');
