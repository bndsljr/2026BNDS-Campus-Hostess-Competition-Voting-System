/**
 * 数据备份：SQLite 一致性快照 + 选手照片打包，并自动清理过期备份。
 * 用法：node scripts/backup.mjs [保留份数]
 * 建议 cron：0 2 * * * /usr/local/bin/node /opt/hostvote/app/scripts/backup.mjs >> /opt/hostvote/logs/backup.log 2>&1
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/loadenv.js';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.HV_DATA_DIR || path.join(ROOT, 'data');
const BACKUP_DIR = process.env.HV_BACKUP_DIR || path.join(ROOT, 'backup');
const DB_FILE = process.env.HV_DB || path.join(DATA_DIR, 'hostvote.db');
const KEEP = Number(process.argv[2] || process.env.HV_BACKUP_KEEP || 14);

const pad = (n) => String(n).padStart(2, '0');
const now = new Date(Date.now() + 8 * 3600 * 1000);
const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) {
  console.error(`[backup] 数据库不存在：${DB_FILE}`);
  process.exit(1);
}

const dbTarget = path.join(BACKUP_DIR, `hostvote-${stamp}.db`);
const db = new DatabaseSync(DB_FILE, { readOnly: true });
try {
  // VACUUM INTO 生成一致性快照（无需 sqlite3 命令行工具）
  db.exec(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);
  const size = fs.statSync(dbTarget).size;
  console.log(`[backup] 数据库快照：${dbTarget}（${(size / 1024).toFixed(0)} KB）`);
} finally {
  db.close();
}

// 上传目录打包
const uploadDir = path.join(DATA_DIR, 'uploads');
if (fs.existsSync(uploadDir) && fs.readdirSync(uploadDir).length) {
  const tarTarget = path.join(BACKUP_DIR, `uploads-${stamp}.tar.gz`);
  try {
    execFileSync('tar', ['-czf', tarTarget, '-C', DATA_DIR, 'uploads'], { stdio: 'ignore' });
    console.log(`[backup] 照片打包：${tarTarget}（${(fs.statSync(tarTarget).size / 1024).toFixed(0)} KB）`);
  } catch (err) {
    console.warn(`[backup] 照片打包失败（可忽略）：${err.message}`);
  }
}

// 清理过期备份
const files = fs
  .readdirSync(BACKUP_DIR)
  .filter((f) => /^hostvote-.*\.db$/.test(f))
  .sort();
if (files.length > KEEP) {
  for (const f of files.slice(0, files.length - KEEP)) {
    const full = path.join(BACKUP_DIR, f);
    fs.unlinkSync(full);
    const tar = path.join(BACKUP_DIR, f.replace(/^hostvote-/, 'uploads-').replace(/\.db$/, '.tar.gz'));
    if (fs.existsSync(tar)) fs.unlinkSync(tar);
    console.log(`[backup] 已清理过期备份：${f}`);
  }
}

const total = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('hostvote-')).length;
console.log(`[backup] 完成，当前保留 ${total} 份数据库备份（上限 ${KEEP}）`);
