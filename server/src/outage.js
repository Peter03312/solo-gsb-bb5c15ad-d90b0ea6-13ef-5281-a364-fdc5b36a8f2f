/**
 * 停电检修影响预演（纯计算，不读取也不修改任何配置）。
 *
 * 规则：
 * - 停电作用于“所选节点 + 其全部后代设备”：设备挂在末级回路 L 上，
 *   L 自身或 L 的任一祖先上配置的停电窗口都会使该设备失供；
 * - 只统计设备原运行时段与停电窗口的交集，时段一律左闭右开 [start,end)；
 * - 同一设备受祖先/子节点/互相重叠的多个窗口影响时，先合并窗口并集，
 *   再与各运行时段求交；失供区间合并后输出，不重复计入；
 * - 事件扫描在“现有负载时间线”的事件点上追加停电边界点，
 *   原负载分段只会被切得更细，切分点处数值与 /api/load 完全一致；
 * - 未受影响的回路/分段 remaining_load = load、lost_load = 0。
 */

import { dfsOrder } from './load.js';

/** 合并互相重叠或首尾相接的左闭右开区间（输入需已按起点排序） */
export function mergeIntervals(intervals) {
  const merged = [];
  for (const p of intervals) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) {
      if (p.end > last.end) last.end = p.end;
    } else {
      merged.push({ ...p });
    }
  }
  return merged;
}

/** 两个左闭右开区间求交，无交集（含仅端点相接）返回 null */
function intersect(aStart, aEnd, bStart, bEnd) {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return start < end ? { start, end } : null;
}

/** 定长时间串（YYYY-MM-DDTHH:MM:SS）→ 秒数（按 UTC 解释，仅用于求时长/差值） */
function toSeconds(t) {
  return (
    Date.UTC(
      Number(t.slice(0, 4)),
      Number(t.slice(5, 7)) - 1,
      Number(t.slice(8, 10)),
      Number(t.slice(11, 13)),
      Number(t.slice(14, 16)),
      Number(t.slice(17, 19) || 0),
    ) / 1000
  );
}

/** 区间秒数（左闭右开，非负整数） */
export function intervalSeconds(start, end) {
  return Math.max(0, Math.round(toSeconds(end) - toSeconds(start)));
}

/** 分钟数：整分返回整数，否则保留最多两位小数 */
export function durationMinutes(seconds) {
  const m = seconds / 60;
  return Number.isInteger(m) ? m : Number(m.toFixed(2));
}

/** 中文时长文案，如 “2小时30分钟”、“45分钟”、“1分30秒” */
export function formatDurationText(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h) parts.push(`${h}小时`);
  if (m) parts.push(`${m}分钟`);
  if (s || parts.length === 0) parts.push(`${s}秒`);
  return parts.join('');
}

function withDuration(p) {
  const seconds = intervalSeconds(p.start, p.end);
  return { start: p.start, end: p.end, duration_minutes: durationMinutes(seconds), duration_text: formatDurationText(seconds) };
}

/** 回路自顶向下的路径名 */
function circuitPath(circuitId, byId) {
  const names = [];
  let cur = byId.get(circuitId);
  while (cur) {
    names.unshift(cur.name);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
  }
  return names.join(' / ');
}

const byStart = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

/**
 * 计算停电方案的供电影响。
 *
 * @param circuits 回路数组（含 rated_power、parent_id）
 * @param devices  设备数组（含 id、name、power_w、circuit_id）
 * @param periodsByDevice Map<deviceId, [{start,end}]>，已合并、无重叠
 * @param windows  已校验规范化的停电窗口 [{circuit_id,start,end}]
 * @returns 见 POST /api/outages/rehearse 的响应结构
 */
export function computeOutageImpact(circuits, devices, periodsByDevice, windows) {
  const byId = new Map(circuits.map((c) => [c.id, c]));

  // 1) 同一节点上的多个窗口先按节点归并
  const windowsByNode = new Map();
  for (const w of windows) {
    if (!windowsByNode.has(w.circuit_id)) windowsByNode.set(w.circuit_id, []);
    windowsByNode.get(w.circuit_id).push({ start: w.start, end: w.end });
  }
  const mergedByNode = new Map();
  for (const [cid, list] of windowsByNode) {
    mergedByNode.set(cid, mergeIntervals(list.slice().sort(byStart)));
  }

  // 2) 每台设备：沿接入回路向上收集祖先（含自身）上的全部停电窗口，
  //    合并后与“原运行时段”求交 —— 只统计交集，多窗口不重复计入。
  const outageByDevice = new Map();
  const pointsSet = new Set();
  for (const periods of periodsByDevice.values()) {
    for (const p of periods) {
      pointsSet.add(p.start);
      pointsSet.add(p.end);
    }
  }

  for (const dev of devices) {
    const periods = periodsByDevice.get(dev.id) ?? [];
    if (periods.length === 0) continue;

    const collected = [];
    let node = dev.circuit_id;
    const guard = new Set();
    while (node != null && !guard.has(node)) {
      guard.add(node);
      const ws = mergedByNode.get(node);
      if (ws) collected.push(...ws);
      const c = byId.get(node);
      node = c ? c.parent_id : null;
    }
    if (collected.length === 0) continue;

    const union = mergeIntervals(collected.sort(byStart));
    const lost = [];
    for (const p of periods) {
      for (const u of union) {
        const hit = intersect(p.start, p.end, u.start, u.end);
        if (hit) lost.push(hit);
      }
    }
    const mergedLost = mergeIntervals(lost.sort(byStart));
    if (mergedLost.length > 0) {
      outageByDevice.set(dev.id, mergedLost);
      for (const p of mergedLost) {
        pointsSet.add(p.start);
        pointsSet.add(p.end);
      }
    }
  }

  // 3) 事件扫描：在原负载时间线的事件点上追加停电边界点，
  //    每个分段内设备“是否运行 / 是否失供”均为常量。
  let timeline = [];
  if (pointsSet.size > 0) {
    const points = [...pointsSet].sort();
    timeline = [];
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      const load = new Map(circuits.map((c) => [c.id, 0]));
      const lostLoad = new Map(circuits.map((c) => [c.id, 0]));
      for (const dev of devices) {
        const periods = periodsByDevice.get(dev.id) ?? [];
        let running = false;
        for (const p of periods) {
          if (p.end <= start) continue;
          if (p.start >= end) break; // 时段已按起点排序
          running = true;
          break;
        }
        if (!running) continue;

        const outages = outageByDevice.get(dev.id) ?? [];
        let lost = false;
        for (const o of outages) {
          if (o.end <= start) continue;
          if (o.start >= end) break;
          lost = true;
          break;
        }

        let node = dev.circuit_id;
        while (node != null) {
          if (load.has(node)) {
            load.set(node, load.get(node) + dev.power_w);
            if (lost) lostLoad.set(node, lostLoad.get(node) + dev.power_w);
          }
          const c = byId.get(node);
          node = c ? c.parent_id : null;
        }
      }
      timeline.push({ start, end, load, lostLoad });
    }
  }

  // 4) 逐回路整理分段（相邻且三值全等的分段合并）与峰值
  const ordered = dfsOrder(circuits);
  const outCircuits = ordered.map((c) => {
    const segs = timeline.map((s) => ({
      start: s.start,
      end: s.end,
      load: s.load.get(c.id) ?? 0,
      remaining_load: (s.load.get(c.id) ?? 0) - (s.lostLoad.get(c.id) ?? 0),
      lost_load: s.lostLoad.get(c.id) ?? 0,
    }));
    const compact = [];
    for (const s of segs) {
      const last = compact[compact.length - 1];
      if (last && last.end === s.start && last.load === s.load && last.remaining_load === s.remaining_load && last.lost_load === s.lost_load) {
        last.end = s.end;
      } else {
        compact.push(s);
      }
    }
    let peak = 0;
    let peakLost = 0;
    for (const s of segs) {
      peak = Math.max(peak, s.load);
      peakLost = Math.max(peakLost, s.lost_load);
    }
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      parent_id: c.parent_id,
      rated_power: c.rated_power,
      peak,
      peak_lost: peakLost,
      affected: peakLost > 0,
      timeline: compact,
    };
  });

  // 5) 受影响设备清单（按回路树顺序、设备 id 排序）及累计失供时长
  const orderIndex = new Map(ordered.map((c, i) => [c.id, i]));
  const affectedDevices = devices
    .filter((d) => outageByDevice.has(d.id))
    .sort((a, b) => {
      const da = orderIndex.get(a.circuit_id) ?? Number.MAX_SAFE_INTEGER;
      const db2 = orderIndex.get(b.circuit_id) ?? Number.MAX_SAFE_INTEGER;
      return da - db2 || a.id - b.id;
    })
    .map((d) => {
      const outagePeriods = outageByDevice.get(d.id).map(withDuration);
      const seconds = outagePeriods.reduce((acc, p) => acc + intervalSeconds(p.start, p.end), 0);
      const c = byId.get(d.circuit_id);
      return {
        id: d.id,
        name: d.name,
        power_w: d.power_w,
        circuit_id: d.circuit_id,
        circuit_name: c ? c.name : null,
        path: byId.has(d.circuit_id) ? circuitPath(d.circuit_id, byId) : null,
        outage_periods: outagePeriods,
        total_lost_minutes: durationMinutes(seconds),
        total_lost_text: formatDurationText(seconds),
      };
    });

  // 6) 回显归并后的停电窗口（带时长），便于页面/调用方核对
  const echoWindows = [...mergedByNode.entries()]
    .sort((a, b) => (orderIndex.get(a[0]) ?? 0) - (orderIndex.get(b[0]) ?? 0))
    .map(([cid, periods]) => ({
      circuit_id: cid,
      name: byId.get(cid)?.name ?? null,
      path: byId.has(cid) ? circuitPath(cid, byId) : null,
      periods: periods.map(withDuration),
    }));

  const allPoints = [...pointsSet].sort();
  const range = allPoints.length ? { start: allPoints[0], end: allPoints[allPoints.length - 1] } : null;

  return {
    range,
    windows: echoWindows,
    circuits: outCircuits,
    affected_devices: affectedDevices,
    totals: {
      affected_circuits: outCircuits.filter((c) => c.affected).length,
      affected_devices: affectedDevices.length,
      peak_lost_load: outCircuits.reduce((m, c) => Math.max(m, c.peak_lost), 0),
    },
  };
}
