/**
 * 管理员密码重置 / 应急解锁（忘记密码或账号被锁定时使用）。
 * 用法（在服务器上）：
 *   cd /opt/hostvote/app
 *   HV_ADMIN_USER=admin HV_ADMIN_PASS='新密码' node scripts/reset-admin.mjs
 *   # 或只解锁不换密码：
 *   HV_ADMIN_USER=admin node scripts/reset-admin.mjs --unlock-only
 */
import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/loadenv.js';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_FILE = process.env.HV_DB || path.join(process.env.HV_DATA_DIR || path.join(ROOT, 'data'), 'hostvote.db');
const USERNAME = process.env.HV_ADMIN_USER || 'admin';
const PASSWORD = process.env.HV_ADMIN_PASS;
const unlockOnly = process.argv.includes('--unlock-only');

if (!fs.existsSync(DB_FILE)) {
  console.error(`找不到数据库：${DB_FILE}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(USERNAME);
if (!admin) {
  console.error(`找不到管理员账号：${USERNAME}`);
  console.error('现有账号：' + db.prepare('SELECT username FROM admins').all().map((a) => a.username).join(', '));
  db.close();
  process.exit(1);
}

if (unlockOnly) {
  db.prepare('UPDATE admins SET failed_count = 0, locked_until = NULL WHERE id = ?').run(admin.id);
  console.log(`✅ 已解除账号「${USERNAME}」的锁定并清零失败次数。`);
} else {
  if (!PASSWORD || PASSWORD.length < 6) {
    console.error('请通过 HV_ADMIN_PASS 提供至少 6 位的新密码。');
    db.close();
    process.exit(1);
  }
  const hash = bcrypt.hashSync(PASSWORD, 10);
  db.prepare('UPDATE admins SET password_hash = ?, failed_count = 0, locked_until = NULL WHERE id = ?').run(hash, admin.id);
  console.log(`✅ 已重置账号「${USERNAME}」的密码，并解除锁定。`);
  console.log('   同时作废全部后台登录会话，请用新密码重新登录。');
}
db.prepare("DELETE FROM sessions WHERE role = 'admin'").run();
db.close();
