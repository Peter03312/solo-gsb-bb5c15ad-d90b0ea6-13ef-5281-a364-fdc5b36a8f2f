import HttpError from './httpError.js';

function fail(message, code = 'BAD_REQUEST') {
  return new HttpError(message, code, 400);
}

/**
 * 校验名称：必填、去首尾空格后非空，长度不超过 100。
 */
export function requireName(value, label) {
  if (typeof value !== 'string') throw fail(`${label}名称必须是字符串`, 'INVALID_NAME');
  const name = value.trim();
  if (!name) throw fail(`${label}名称不能为空`, 'INVALID_NAME');
  if (name.length > 100) throw fail(`${label}名称长度不能超过 100 个字符`, 'INVALID_NAME');
  return name;
}

/**
 * 校验正功率（瓦），返回数值。
 */
export function requirePositivePower(value, label) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) {
    throw fail(`${label}必须是数字`, 'INVALID_POWER');
  }
  if (n <= 0) throw fail(`${label}必须为正数`, 'INVALID_POWER');
  return n;
}

/**
 * 规范化时间字符串。支持分钟精度 "YYYY-MM-DDTHH:MM" 与秒精度。
 * 统一输出秒精度（秒补 00），按字典序即可比较先后（定长格式）。
 */
export function normalizeTime(value, label) {
  if (typeof value !== 'string') throw fail(`${label}必须是字符串`, 'INVALID_TIME');
  const s = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw fail(`${label}格式非法，应为 YYYY-MM-DDTHH:MM`, 'INVALID_TIME');
  const [, y, mo, d, h, mi, se] = m;
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (month < 1 || month > 12) throw fail(`${label}月份非法`, 'INVALID_TIME');
  const daysInMonth = new Date(Number(y), month, 0).getDate();
  if (day < 1 || day > daysInMonth) throw fail(`${label}日期非法`, 'INVALID_TIME');
  if (hour > 23 || minute > 59 || (se !== undefined && Number(se) > 59)) {
    throw fail(`${label}时间非法`, 'INVALID_TIME');
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${se ?? '00'}`;
}

/**
 * 校验一个运行时段：返回规范化的 {start,end}。
 * 要求起点严格早于终点（左闭右开）。
 */
export function normalizePeriod(raw) {
  if (!raw || typeof raw !== 'object') throw fail('运行时段必须包含 start 与 end', 'INVALID_PERIOD');
  const start = normalizeTime(raw.start, '时段起点');
  const end = normalizeTime(raw.end, '时段终点');
  if (!(start < end)) throw fail('时段起点必须早于终点（左闭右开，区间不可为空）', 'INVALID_PERIOD');
  return { start, end };
}

/**
 * 规范化并校验时段数组：
 * - 每个时段自身必须合法且起点早于终点；
 * - 重叠（或首尾相接）的时段合并 —— 同一设备重叠时段只计一次。
 */
export function normalizePeriods(rawPeriods) {
  if (!Array.isArray(rawPeriods)) throw fail('运行时段必须是数组', 'INVALID_PERIOD');
  const periods = rawPeriods.map(normalizePeriod).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged = [];
  for (const p of periods) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) {
      if (p.end > last.end) last.end = p.end;
    } else {
      merged.push({ ...p });
    }
  }
  return merged;
}
