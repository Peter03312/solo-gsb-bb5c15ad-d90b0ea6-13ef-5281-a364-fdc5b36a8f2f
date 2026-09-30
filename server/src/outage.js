/**
 * 停电检修预演核心（纯计算，不写库、不改配置）。
 *
 * 规则：
 * - 停电作用于所选节点及其全部后代设备；
 * - 只统计设备原运行时段与停电窗口的交集，时段一律左闭右开 [start,end)；
 * - 同一设备受到祖先节点、子节点或多个重叠窗口影响时，先合并失供区间，
 *   任一时刻该设备至多计一次失供功率；
 * - 输出按时间段给出每个回路的原负载 load、剩余供电负载 remaining_load
 *   与失供负载 lost_load（remaining = load - lost）；
 * - 未受影响分支的 lost_load 恒为 0，即保持原负载。
 *
 * 与 load.js 的事件扫描保持同一套时间点语义，因此结果天然与现有负载时间线对齐。
 */

import { dfsOrder, selfAndAncestors } from './load.js';

/** 合并重叠/首尾相接的区间（输入/输出均为 {start,end}，按定长字符串比较） */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged = [];
  for (const p of sorted) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) {
      if (p.end > last.end) last.end = p.end;
    } else {
      merged.push({ ...p });
    }
  }
  return merged;
}

/** 两组各自无重叠、已排序区间的交集（左闭右开，空交集不产生区间） */
export function intersectIntervals(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = a[i].start < b[j].start ? b[j].start : a[i].start;
    const end = a[i].end < b[j].end ? a[i].end : b[j].end;
    if (start < end) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

/** 区间累计秒数（时间串为定长 ISO，本地解析差值不受时区影响） */
export function totalSeconds(intervals) {
  let sec = 0;
  for (const p of intervals) sec += (Date.parse(`${p.end.replace(' ', 'T')}`) - Date.parse(`${p.start.replace(' ', 'T')}`)) / 1000;
  return sec;
}

/**
 * 计算停电预演方案。
 *
 * @param circuits 回路数组（含 id、parent_id、rated_power）
 * @param devices  设备数组（含 id、power_w、circuit_id、name）
 * @param periodsByDevice Map<deviceId, [{start,end}]>，已合并
 * @param outageInputs [{circuit_id, windows:[{start,end}]}]，已校验且按节点归并
 * @returns {{
 *   range, windows, circuits: Map, affectedDevices, affectedCircuitIds, byId
 * }}
 */
export function computeOutagePlan(circuits, devices, periodsByDevice, outageInputs) {
  const byId = new Map(circuits.map((c) => [c.id, c]));

  // 子树集合（含自身）：DFS 前序的逆序保证处理父节点时子节点已聚合
  const subtree = new Map(circuits.map((c) => [c.id, new Set([c.id])]));
  for (const c of [...dfsOrder(circuits)].reverse()) {
    if (c.parent_id != null && subtree.has(c.parent_id)) {
      for (const id of subtree.get(c.id)) subtree.get(c.parent_id).add(id);
    }
  }

  // 每个停电节点：子树设备集合 + 合并后的停电窗口
  const targets = outageInputs.map((t) => ({
    circuitId: t.circuit_id,
    members: subtree.get(t.circuit_id) ?? new Set([t.circuit_id]),
    windows: mergeIntervals(t.windows),
  }));
  // 回显用：各节点合并后的停电窗口，按起点排序（跨节点窗口保持各自独立）
  const windowsOut = targets
    .flatMap((t) => t.windows.map((w) => ({ circuit_id: t.circuitId, start: w.start, end: w.end })))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.circuit_id - b.circuit_id));

  // 事件点：设备运行时段边界 + 每个设备失供区间的边界
  const pointsSet = new Set();
  for (const periods of periodsByDevice.values()) {
    for (const p of periods) {
      pointsSet.add(p.start);
      pointsSet.add(p.end);
    }
  }

  // 事件表：t -> Map<circuitId, 功率增量>。设备功率沿自身回路及全部祖先累加。
  const atLoad = new Map();
  const atLost = new Map();
  function addEvent(map, t, chain, w) {
    let m = map.get(t);
    if (!m) {
      m = new Map();
      map.set(t, m);
    }
    for (const cid of chain) m.set(cid, (m.get(cid) ?? 0) + w);
  }

  const affectedDevices = [];
  for (const dev of devices) {
    const periods = periodsByDevice.get(dev.id) ?? [];
    if (periods.length === 0 || !byId.has(dev.circuit_id)) continue;
    const chain = selfAndAncestors(dev.circuit_id, byId);

    // 原运行事件
    for (const p of periods) {
      addEvent(atLoad, p.start, chain, dev.power_w);
      addEvent(atLoad, p.end, chain, -dev.power_w);
    }

    // 汇集所有覆盖该设备的停电窗口（祖先节点 / 子节点 / 重叠窗口都在这里），先合并再求交
    const covering = [];
    for (const t of targets) {
      if (t.members.has(dev.circuit_id)) covering.push(...t.windows);
    }
    if (covering.length === 0) continue;
    const outageUnion = mergeIntervals(covering);
    const lostPeriods = intersectIntervals(periods, outageUnion);
    if (lostPeriods.length === 0) continue;

    for (const p of lostPeriods) {
      pointsSet.add(p.start);
      pointsSet.add(p.end);
      addEvent(atLost, p.start, chain, dev.power_w);
      addEvent(atLost, p.end, chain, -dev.power_w);
    }
    affectedDevices.push({
      device_id: dev.id,
      name: dev.name,
      power_w: dev.power_w,
      circuit_id: dev.circuit_id,
      lost_periods: lostPeriods,
      lost_seconds: totalSeconds(lostPeriods),
    });
  }

  // 扫描事件点，得到分段常值时间线
  const points = [...pointsSet].sort();
  const segments = [];
  const curLoad = new Map(circuits.map((c) => [c.id, 0]));
  const curLost = new Map(circuits.map((c) => [c.id, 0]));
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i];
    const end = points[i + 1];
    const dl = atLoad.get(start);
    if (dl) for (const [cid, w] of dl) curLoad.set(cid, curLoad.get(cid) + w);
    const doff = atLost.get(start);
    if (doff) for (const [cid, w] of doff) curLost.set(cid, curLost.get(cid) + w);
    segments.push({
      start,
      end,
      loads: new Map(curLoad),
      lost: new Map(curLost),
    });
  }

  // 逐回路组装时间线（相邻且原负载/失供负载都相等的分段合并）与峰值
  const result = new Map();
  for (const c of circuits) {
    const compact = [];
    let peak = 0;
    let remainingPeak = 0;
    let lostPeak = 0;
    for (const s of segments) {
      const load = s.loads.get(c.id) ?? 0;
      const lost = Math.min(s.lost.get(c.id) ?? 0, load); // 失供不可能超过原负载
      const remaining = load - lost;
      peak = Math.max(peak, load);
      remainingPeak = Math.max(remainingPeak, remaining);
      lostPeak = Math.max(lostPeak, lost);
      const last = compact[compact.length - 1];
      if (last && last.load === load && last.lost_load === lost && last.end === s.start) {
        last.end = s.end;
      } else {
        compact.push({ start: s.start, end: s.end, load, remaining_load: remaining, lost_load: lost });
      }
    }
    result.set(c.id, { timeline: compact, peak, remaining_peak: remainingPeak, lost_peak: lostPeak });
  }

  const affectedCircuitIds = dfsOrder(circuits)
    .filter((c) => (result.get(c.id).lost_peak ?? 0) > 0)
    .map((c) => c.id);

  affectedDevices.sort((a, b) => {
    const sa = a.lost_periods[0]?.start ?? '';
    const sb = b.lost_periods[0]?.start ?? '';
    return sa < sb ? -1 : sa > sb ? 1 : a.device_id - b.device_id;
  });

  const range = points.length ? { start: points[0], end: points[points.length - 1] } : null;

  return { range, windows: windowsOut, circuits: result, affectedDevices, affectedCircuitIds, byId };
}
