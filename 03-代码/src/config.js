/**
 * 运行期配置：路径、端口、环境变量。
 * 所有可变数据集中放在 DATA_DIR，便于备份与升级（代码目录可随时覆盖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './loadenv.js';

// 先加载 .env（systemd 已注入的环境变量优先），再读取配置
loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.HV_DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const BACKUP_DIR = process.env.HV_BACKUP_DIR || path.join(ROOT, 'backup');
export const LOG_DIR = process.env.HV_LOG_DIR || path.join(ROOT, 'logs');
export const DB_FILE = process.env.HV_DB || path.join(DATA_DIR, 'hostvote.db');
export const VIEWS_DIR = path.join(ROOT, 'views');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const PORT = Number(process.env.HV_PORT || 3000);
export const HOST = process.env.HV_HOST || '127.0.0.1';
export const NODE_ENV = process.env.HV_ENV || 'production';

/** 后台连续登录失败阈值 / 锁定时长（分钟）——需求：5 次错误锁定 1 小时 */
export const ADMIN_MAX_FAILS = Number(process.env.HV_ADMIN_MAX_FAILS || 5);
export const ADMIN_LOCK_MINUTES = Number(process.env.HV_ADMIN_LOCK_MINUTES || 60);

/** 会话默认有效期（小时） */
export const SESSION_HOURS = Number(process.env.HV_SESSION_HOURS || 12);

/** 单文件上传上限 */
export const MAX_UPLOAD_BYTES = Number(process.env.HV_MAX_UPLOAD || 8 * 1024 * 1024);

export const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

for (const dir of [DATA_DIR, UPLOAD_DIR, BACKUP_DIR, LOG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const COMPETITIONS = {
  group: { key: 'group', name: '小组赛', short: '小组赛' },
  individual: { key: 'individual', name: '个人赛', short: '个人赛' },
};

export function isCompetition(value) {
  return value === 'group' || value === 'individual';
}
