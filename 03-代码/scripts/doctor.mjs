/**
 * 数据体检（doctor）：检查数据库完整性并给出可执行的修复建议。
 *
 *   node scripts/doctor.mjs            # 只检查
 *   node scripts/doctor.mjs --fix      # 检查并自动修复可安全修复的问题（孤儿行等）
 *
 * 可在本地或服务器上运行，默认只读。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/loadenv.js';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_FILE = process.env.HV_DB || path.join(process.env.HV_DATA_DIR || path.join(ROOT, 'data'), 'hostvote.db');
const FIX = process.argv.includes('--fix');

const db = new DatabaseSync(DB_FILE, { readOnly: !FIX });
const q = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

const judgeCount = Number(q("SELECT value FROM settings WHERE key='judge_count'")?.value || 4);

console.log(`\n=== 数据体检 ===`);
console.log(`数据库：${DB_FILE}${FIX ? '（修复模式）' : '（只读）'}\n`);

console.log('基础统计：');
console.log(`  选手 ${q('SELECT COUNT(*) c FROM players').c}（启用 ${q('SELECT COUNT(*) c FROM players WHERE active=1').c}）`);
console.log(`  密码条 ${q('SELECT COUNT(*) c FROM voting_codes').c}（大众 ${q("SELECT COUNT(*) c FROM voting_codes WHERE role='public'").c} / 专业 ${q("SELECT COUNT(*) c FROM voting_codes WHERE role='pro'").c}）`);
console.log(`  投票 ${q('SELECT COUNT(*) c FROM votes').c}（有效 ${q('SELECT COUNT(*) c FROM votes WHERE invalid=0').c}）`);
console.log(`  打分 ${q('SELECT COUNT(*) c FROM scores').c}`);
console.log(`  评审席位数设置 ${judgeCount}\n`);

const problems = [];
const fixable = [];
const add = (name, count, fix = null) => {
  if (count > 0) {
    problems.push(`${name}：${count}`);
    if (fix) fixable.push({ name, sql: fix });
  }
  console.log(`  ${count > 0 ? '✘' : '✔'} ${name}${count > 0 ? '：' + count : ''}`);
};

console.log('完整性检查：');
add('孤儿 vote_items（所属投票已不存在）', q('SELECT COUNT(*) c FROM vote_items WHERE vote_id NOT IN (SELECT id FROM votes)').c,
  'DELETE FROM vote_items WHERE vote_id NOT IN (SELECT id FROM votes)');
add('指向已不存在选手的 results', q('SELECT COUNT(*) c FROM results WHERE player_id NOT IN (SELECT id FROM players)').c,
  'DELETE FROM results WHERE player_id NOT IN (SELECT id FROM players)');
add('指向已不存在选手的 final_results', q('SELECT COUNT(*) c FROM final_results WHERE player_id NOT IN (SELECT id FROM players)').c,
  'DELETE FROM final_results WHERE player_id NOT IN (SELECT id FROM players)');
add('已停用选手仍留在 results', q('SELECT COUNT(*) c FROM results WHERE player_id IN (SELECT id FROM players WHERE active=0)').c,
  'DELETE FROM results WHERE player_id IN (SELECT id FROM players WHERE active=0)');
add('已停用选手仍留在 final_results', q('SELECT COUNT(*) c FROM final_results WHERE player_id IN (SELECT id FROM players WHERE active=0)').c,
  'DELETE FROM final_results WHERE player_id IN (SELECT id FROM players WHERE active=0)');
add(`评审席超出范围（有效范围 1-${judgeCount}）的密码条`,
  q('SELECT COUNT(*) c FROM voting_codes WHERE role=? AND (judge_slot IS NULL OR judge_slot<1 OR judge_slot>?)', 'pro', judgeCount).c,
  null);
add('越界评审席上的打分（不会被计入成绩）',
  q('SELECT COUNT(*) c FROM scores WHERE judge_slot<1 OR judge_slot>?', judgeCount).c, null);
add('同一密码条在同一赛事存在多条有效投票',
  q('SELECT COUNT(*) c FROM (SELECT code_id,competition FROM votes WHERE invalid=0 AND code_id IS NOT NULL GROUP BY code_id,competition HAVING COUNT(*)>1)').c, null);
add('同一评审席同一选手存在重复打分',
  q('SELECT COUNT(*) c FROM (SELECT competition,judge_slot,player_id FROM scores GROUP BY competition,judge_slot,player_id HAVING COUNT(*)>1)').c, null);
add('分数越界（不在 0-100）', q('SELECT COUNT(*) c FROM scores WHERE score<0 OR score>100').c, null);
add('落库票数与实际投票不一致的选手',
  q(`SELECT COUNT(*) c FROM results r WHERE r.public_votes != (
       SELECT COUNT(*) FROM vote_items vi JOIN votes v ON v.id=vi.vote_id
       WHERE v.competition=r.competition AND v.invalid=0 AND vi.player_id=r.player_id)`).c, null);
add('指向已不存在密码条的投票（记录仍在，仅显示为"已删除密码条"）',
  q('SELECT COUNT(*) c FROM votes WHERE code_id IS NOT NULL AND code_id NOT IN (SELECT id FROM voting_codes)').c, null);
add('投票选项引用了已不存在的选手',
  q('SELECT COUNT(*) c FROM vote_items WHERE player_id NOT IN (SELECT id FROM players)').c, null);

console.log(`\n数据库物理检查：`);
const integ = q('PRAGMA integrity_check');
console.log(`  ${String(Object.values(integ)[0]).toLowerCase() === 'ok' ? '✔' : '✘'} integrity_check = ${Object.values(integ)[0]}`);
const fk = all('PRAGMA foreign_key_check');
console.log(`  ${fk.length === 0 ? '✔' : '✘'} 外键检查（app 未启用外键约束，仅作参考）`);

if (problems.length === 0) {
  console.log('\n✅ 未发现数据问题。\n');
} else {
  console.log(`\n⚠️  发现 ${problems.length} 类问题：`);
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  const manual = problems.filter((p) => !fixable.some((f) => p.startsWith(f.name)));
  if (manual.length) {
    console.log('\n需人工处理（脚本不自动改）：');
    console.log('  · 评审席越界 → 后台「打分数数据」页点「🔧 一键修正评审席」');
    console.log('  · 重复投票/重复打分/分数越界 → 请先在后台导出数据备份，再人工核对');
    console.log('  · 落库票数不一致 → 后台点一次「手动重算排名」即可');
  }
  if (fixable.length) {
    if (FIX) {
      console.log('\n开始修复可自动处理的问题 ...');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const f of fixable) {
          const r = db.prepare(f.sql).run();
          console.log(`  ✔ 已清理：${f.name}（${r.changes} 行）`);
        }
        db.exec('COMMIT');
        console.log('修复完成，请重启服务或点一次「手动重算排名」。');
      } catch (e) {
        db.exec('ROLLBACK');
        console.error('  修复失败已回滚：', e.message);
      }
    } else {
      console.log('\n其中以下问题可用 --fix 自动清理：');
      fixable.forEach((f) => console.log(`  · ${f.name}`));
      console.log('  执行：node scripts/doctor.mjs --fix');
    }
  }
  console.log('');
}

db.close();
process.exit(problems.length && !FIX ? 1 : 0);
