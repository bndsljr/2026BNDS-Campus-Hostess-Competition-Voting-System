/**
 * 通用工具：时间（统一 UTC 存储 / 北京时间展示）、随机码、格式化、HTML 转义。
 * 北京时间固定 UTC+8 且无夏令时，故用固定偏移换算，避免 Intl 带来的不确定性。
 */

export const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 当前时间（UTC ISO），全库统一存储格式 */
export function nowIso() {
  return new Date().toISOString();
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

/** ISO(UTC) → 北京时间字符串 'YYYY-MM-DD HH:mm:ss' */
export function fmtLocal(iso, withSeconds = true) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + BJ_OFFSET_MS);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getUTCSeconds())}` : base;
}

/** 北京时间 'YYYY-MM-DD HH:mm' 字符串 → ISO(UTC) */
export function localToIso(local) {
  if (!local) return null;
  const m = String(local).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [_, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)) - BJ_OFFSET_MS;
  return new Date(ms).toISOString();
}

/** ISO(UTC) → <input type="datetime-local"> 可用的北京时间值 */
export function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + BJ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 距离某时刻还有多久，返回人类可读文本 */
export function humanRemain(targetIso, fromMs = Date.now()) {
  if (!targetIso) return '';
  let diff = new Date(targetIso).getTime() - fromMs;
  const past = diff < 0;
  diff = Math.abs(diff);
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const mi = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  const parts = [];
  if (d) parts.push(`${d}天`);
  if (h) parts.push(`${h}小时`);
  if (mi) parts.push(`${mi}分`);
  if (!d && !h) parts.push(`${s}秒`);
  return (past ? '已过去 ' : '剩余 ') + parts.join('');
}

/** 数值四舍五入到指定小数位 */
export function round(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 0;
  const f = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * f) / f;
}

/** 去掉浮点尾差后输出为数字（用于 Excel，避免 7.999999999） */
export function clean(value, decimals = 2) {
  return round(value, decimals);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1 等易混字符

/** 生成随机密码条片段 */
export function randomCode(length = 8) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** 展示用分组：ABCD1234 → ABCD-1234 */
export function formatCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length <= 4) return c;
  const half = Math.ceil(c.length / 2);
  return `${c.slice(0, half)}-${c.slice(half)}`;
}

/** 归一化用户输入的密码条（去空格、连字符，统一大写） */
export function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 生成会话 ID */
export function newSid() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 生成强随机密码（管理员初始密码等） */
export function randomPassword(length = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 安全解析 JSON，失败返回兜底值 */
export function safeJson(text, fallback = null) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

/** 把 0/1 或 '0'/'1' 统一成布尔 */
export function toBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}
