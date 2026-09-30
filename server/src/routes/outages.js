import { Router } from 'express';
import { getDb } from '../db.js';
import { listCircuits, listDevices, periodsByDevice } from '../state.js';
import { computeOutagePlan } from '../outage.js';
import { normalizeTime } from '../validators.js';
import { dfsOrder } from '../load.js';
import HttpError from '../httpError.js';

const router = Router();

/** 回路自顶向下的路径名，便于在结果中指认 */
function circuitPath(circuitId, byId) {
  const names = [];
  let cur = byId.get(circuitId);
  while (cur) {
    names.unshift(cur.name);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
  }
  return names.join(' / ');
}

/** 秒数格式化为中文时长，如「2小时30分钟」「45分钟」 */
function formatDurationZh(totalSeconds) {
  let s = Math.round(totalSeconds);
  if (s <= 0) return '0分钟';
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = [];
  if (h) parts.push(`${h}小时`);
  if (m) parts.push(`${m}分钟`);
  if (s) parts.push(`${s}秒`);
  return parts.join('') || '0分钟';
}

/**
 * 停电检修预演（纯读操作，不写库、不改变配电树/接线/运行时段）。
 *
 * 请求体：
 *   { "outages": [ { "circuit_id": 3, "start": "...", "end": "..." }, ... ] }
 * 可为多个配电箱或末级回路分别填写停电窗口；窗口左闭右开、起点须严格早于终点。
 *
 * 错误一律在任何结果生成前抛出：
 * - 空方案（缺 outages / 非数组 / 空数组）→ 400 EMPTY_PLAN；
 * - 缺失回路 → 400 MISSING_CIRCUIT；
 * - 起止时间缺失/格式错/起点不早于终点 → 400 INVALID_TIME / INVALID_PERIOD。
 */
router.post('/preview', (req, res) => {
  const body = req.body ?? {};
  const rawOutages = body.outages;
  if (!Array.isArray(rawOutages) || rawOutages.length === 0) {
    throw new HttpError('停电方案不能为空：请至少提供一个停电节点及其起止时间', 'EMPTY_PLAN', 400);
  }

  const db = getDb();
  // 同一节点可携带多个窗口，先按节点归并，再逐行校验（报错信息带序号，便于定位）
  const windowsByCircuit = new Map();
  rawOutages.forEach((raw, idx) => {
    const pos = `第 ${idx + 1} 个停电节点`;
    if (!raw || typeof raw !== 'object') {
      throw new HttpError(`${pos}格式非法，应包含 circuit_id、start、end`, 'INVALID_OUTAGE', 400);
    }
    const circuitId = Number(raw.circuit_id);
    if (!Number.isInteger(circuitId) || circuitId <= 0) {
      throw new HttpError(`${pos}缺少有效的 circuit_id`, 'MISSING_CIRCUIT', 400);
    }
    const circuit = db.prepare(`SELECT id, name FROM circuits WHERE id = ?`).get(circuitId);
    if (!circuit) {
      throw new HttpError(`${pos}指定的回路 ${raw.circuit_id} 不存在（缺失回路）`, 'MISSING_CIRCUIT', 400);
    }
    // 起止时间非法（缺失/格式错/起点不早于终点）直接抛中文错误，并指出是第几个节点
    const start = normalizeTime(raw.start, `${pos}停电起点`);
    const end = normalizeTime(raw.end, `${pos}停电终点`);
    if (!(start < end)) {
      throw new HttpError(`${pos}停电起点必须早于终点（左闭右开，区间不可为空）`, 'INVALID_PERIOD', 400);
    }
    if (!windowsByCircuit.has(circuitId)) windowsByCircuit.set(circuitId, []);
    windowsByCircuit.get(circuitId).push({ start, end });
  });

  const outageInputs = [...windowsByCircuit.entries()].map(([circuit_id, windows]) => ({ circuit_id, windows }));

  const circuits = listCircuits();
  const devices = listDevices();
  const periods = periodsByDevice();
  const plan = computeOutagePlan(circuits, devices, periods, outageInputs);

  const version = Number(db.prepare(`SELECT value FROM meta WHERE key = 'config_version'`).get().value);

  const outageWindows = plan.windows.map((w) => {
    const c = plan.byId.get(w.circuit_id);
    return {
      circuit_id: w.circuit_id,
      name: c?.name ?? `#${w.circuit_id}`,
      path: circuitPath(w.circuit_id, plan.byId),
      start: w.start,
      end: w.end,
    };
  });

  const circuitsOut = dfsOrder(circuits).map((c) => {
    const r = plan.circuits.get(c.id);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      parent_id: c.parent_id,
      rated_power: c.rated_power,
      affected: (r.lost_peak ?? 0) > 0,
      peak: r.peak,
      remaining_peak: r.remaining_peak,
      lost_peak: r.lost_peak,
      timeline: r.timeline,
    };
  });

  const affectedCircuits = plan.affectedCircuitIds.map((cid) => {
    const c = plan.byId.get(cid);
    const r = plan.circuits.get(cid);
    return {
      circuit_id: cid,
      name: c.name,
      path: circuitPath(cid, plan.byId),
      lost_peak: r.lost_peak,
    };
  });

  const affectedDevices = plan.affectedDevices.map((d) => {
    const c = plan.byId.get(d.circuit_id);
    return {
      device_id: d.device_id,
      name: d.name,
      power_w: d.power_w,
      circuit_id: d.circuit_id,
      circuit_name: c?.name ?? `#${d.circuit_id}`,
      path: circuitPath(d.circuit_id, plan.byId),
      lost_periods: d.lost_periods,
      lost_seconds: d.lost_seconds,
      lost_duration: formatDurationZh(d.lost_seconds),
    };
  });

  res.json({
    config_version: version,
    range: plan.range,
    outage_windows: outageWindows,
    circuits: circuitsOut,
    affected_circuits: affectedCircuits,
    affected_devices: affectedDevices,
  });
});

export default router;
