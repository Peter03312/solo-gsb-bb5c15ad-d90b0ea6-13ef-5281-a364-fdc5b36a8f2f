/**
 * 负载计算核心。
 *
 * 规则：
 * - 每个回路的负载 = 接入该回路、在该时刻运行的全部设备功率之和
 *   （上级配电箱汇总其全部后代设备，沿 parent 链自然累加）；
 * - 时段左闭右开 [start,end)；
 * - 同一设备的重叠时段存储时已合并，因此每个设备在任一时刻至多计一次；
 * - 输出按事件点压缩为分段常值（step）时间线，并给出超限区间与峰值。
 */

/** 取某回路祖先链（不含自身），自顶向下 */
export function ancestorChain(circuitId, byId) {
  const chain = [];
  let cur = byId.get(circuitId);
  while (cur && cur.parent_id != null) {
    cur = byId.get(cur.parent_id);
    if (!cur) break;
    chain.push(cur.id);
  }
  return chain.reverse();
}

/** 取某回路及其全部祖先（自顶向下，末尾为自身） */
export function selfAndAncestors(circuitId, byId) {
  return [...ancestorChain(circuitId, byId), circuitId];
}

/** 深度优先顺序返回回路（与树上的展示顺序一致） */
export function dfsOrder(circuits) {
  const byId = new Map(circuits.map((c) => [c.id, c]));
  const children = new Map();
  for (const c of circuits) {
    if (!children.has(c.parent_id ?? 0)) children.set(c.parent_id ?? 0, []);
    children.get(c.parent_id ?? 0).push(c.id);
  }
  const order = [];
  const visit = (pid) => {
    for (const id of children.get(pid) ?? []) {
      order.push(id);
      visit(id);
    }
  };
  visit(0);
  return order.map((id) => byId.get(id));
}

/**
 * 计算全树负载。
 *
 * @param circuits 回路数组（含 rated_power、parent_id）
 * @param devices  设备数组（含 id、power_w、circuit_id）
 * @param periodsByDevice Map<deviceId, [{start,end}]>，已合并、无重叠
 * @param overrides 可选 { deviceOverrides: Map<deviceId, {circuit_id, power_w}>,
 *                          extraPeriods: ... }（预演用，当前仅改接，只需 circuit_id）
 * @returns {{ timeline: [{start,end,loads:Map<id,w>}], circuits: Map<id, {timeline, over, peak}> , range }}
 */
export function computeLoads(circuits, devices, periodsByDevice) {
  const byId = new Map(circuits.map((c) => [c.id, c]));

  // 收集全部事件点
  const pointsSet = new Set();
  for (const periods of periodsByDevice.values()) {
    for (const p of periods) {
      pointsSet.add(p.start);
      pointsSet.add(p.end);
    }
  }

  let timeline;
  if (pointsSet.size === 0) {
    timeline = [];
  } else {
    const points = [...pointsSet].sort();
    timeline = [];
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      const loads = new Map(circuits.map((c) => [c.id, 0]));
      for (const dev of devices) {
        const periods = periodsByDevice.get(dev.id) ?? [];
        // 左闭右开：start <= t < end
        for (const p of periods) {
          if (p.end <= start) continue;
          if (p.start >= end) break; // 时段已按起点排序
          const cid = dev.circuit_id;
          if (!loads.has(cid)) break; // 接入了不存在的回路（数据异常）
          // 累加到自身及全部祖先
          let node = cid;
          while (node != null) {
            loads.set(node, (loads.get(node) ?? 0) + dev.power_w);
            const c = byId.get(node);
            node = c ? c.parent_id : null;
          }
          break; // 同一设备的重叠时段已合并，一个分段内至多命中一次
        }
      }
      timeline.push({ start, end, loads });
    }
  }

  const result = new Map();
  for (const c of circuits) {
    const segs = timeline.map((s) => ({ start: s.start, end: s.end, load: s.loads.get(c.id) ?? 0 }));
    // 相邻等值分段合并，便于展示
    const compact = [];
    for (const s of segs) {
      const last = compact[compact.length - 1];
      if (last && last.load === s.load && last.end === s.start) {
        last.end = s.end;
      } else {
        compact.push({ ...s });
      }
    }
    // 超限区间：把相邻的超限分段合并，记录该合并区间内的峰值
    const over = [];
    let peak = 0;
    for (const s of segs) {
      peak = Math.max(peak, s.load);
      if (s.load > c.rated_power) {
        const last = over[over.length - 1];
        if (last && last.end === s.start) {
          last.end = s.end;
          last.peak = Math.max(last.peak, s.load);
        } else {
          over.push({ start: s.start, end: s.end, peak: s.load });
        }
      }
    }
    result.set(c.id, { timeline: compact, over, peak });
  }

  const allPoints = [...pointsSet].sort();
  const range = allPoints.length ? { start: allPoints[0], end: allPoints[allPoints.length - 1] } : null;

  return { timeline, circuits: result, range, byId };
}
