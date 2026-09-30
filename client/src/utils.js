/** 功率展示：统一用 kW（输入与存储均为瓦） */
export function kW(w) {
  if (w === 0) return '0';
  const n = w / 1000;
  return (Math.round(n * 100) / 100).toString();
}

/** 2026-10-01T18:30:00 -> 06:30（x 轴短标签） */
export function hm(t) {
  return t.slice(11, 16);
}

/** 2026-10-01T18:30:00 -> 10-01 18:30 */
export function mdhm(t) {
  return `${t.slice(5, 10)} ${t.slice(11, 16)}`;
}

/** datetime-local 输入值：2026-10-01T18:30（截掉秒） */
export function toLocalInput(t) {
  return t.slice(0, 16);
}

/** 把定长时间串换算为分钟数，用于像素定位 */
export function toMinutes(t) {
  const y = Number(t.slice(0, 4));
  const mo = Number(t.slice(5, 7));
  const d = Number(t.slice(8, 10));
  const h = Number(t.slice(11, 13));
  const mi = Number(t.slice(14, 16));
  // 用 UTC 构造避免时区偏移；只需要相对差值
  return Date.UTC(y, mo - 1, d, h, mi) / 60000;
}

/** 建立 id -> 回路 映射与子节点表 */
export function buildTree(circuits) {
  const byId = new Map(circuits.map((c) => [c.id, c]));
  const children = new Map();
  for (const c of circuits) {
    const key = c.parent_id ?? 0;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(c.id);
  }
  return { byId, children };
}

/** 回路自顶向下路径名 */
export function circuitPath(id, byId) {
  const names = [];
  let cur = byId.get(id);
  while (cur) {
    names.unshift(cur.name);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
  }
  return names.join(' / ');
}

/** 是否末级回路（无子节点） */
export function isLeaf(id, children) {
  return (children.get(id)?.length ?? 0) === 0;
}
