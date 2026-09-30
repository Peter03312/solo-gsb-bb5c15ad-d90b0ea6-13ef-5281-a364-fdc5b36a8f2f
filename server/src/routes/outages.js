import { Router } from 'express';
import { getDb, getConfigVersion } from '../db.js';
import { listCircuits, listDevices, periodsByDevice } from '../state.js';
import { normalizeTime } from '../validators.js';
import { computeOutageImpact } from '../outage.js';
import HttpError from '../httpError.js';

const router = Router();

/**
 * 解析停电窗口数组：
 * - 必须是非空数组（空方案明确报错、不生成结果）；
 * - 每项必须指定存在的配电箱/回路 id（缺失回路明确报错）；
 * - 时间格式与“左闭右开、起点严格早于终点”沿用运行时段同一套校验；
 * - 同一节点重复窗口不在此报错：计算时按并集合并。
 */
function parseWindows(raw) {
  if (raw === undefined || raw === null) {
    throw new HttpError('停电方案不能为空：请至少填写一个停电窗口（windows 数组）', 'EMPTY_PLAN', 400);
  }
  if (!Array.isArray(raw)) {
    throw new HttpError('停电方案必须是 windows 数组，每项含 circuit_id、start、end', 'INVALID_WINDOWS', 400);
  }
  if (raw.length === 0) {
    throw new HttpError('停电方案不能为空：请至少为一个配电箱或末级回路填写停电起止时间', 'EMPTY_PLAN', 400);
  }

  const db = getDb();
  const windows = raw.map((item, i) => {
    const where = `第 ${i + 1} 个停电窗口`;
    if (!item || typeof item !== 'object') {
      throw new HttpError(`${where}必须是对象，需包含 circuit_id、start、end`, 'INVALID_WINDOW', 400);
    }
    const circuitId = Number(item.circuit_id);
    if (!Number.isInteger(circuitId) || circuitId <= 0) {
      throw new HttpError(`${where}缺少有效的 circuit_id（配电箱或末级回路 id）`, 'MISSING_CIRCUIT', 400);
    }
    const circuit = db.prepare(`SELECT id FROM circuits WHERE id = ?`).get(circuitId);
    if (!circuit) {
      throw new HttpError(`${where}指定的回路 ${circuitId} 不存在（缺失回路），请核对配电树`, 'MISSING_CIRCUIT', 400);
    }
    if (item.start === undefined || item.end === undefined || item.start === null || item.end === null) {
      throw new HttpError(`${where}必须填写停电起止时间（start、end，格式 YYYY-MM-DDTHH:MM）`, 'INVALID_WINDOW', 400);
    }
    const start = normalizeTime(item.start, `${where}停电起点`);
    const end = normalizeTime(item.end, `${where}停电终点`);
    if (!(start < end)) {
      throw new HttpError(`${where}起点必须早于终点（左闭右开，停电窗口不可为空）`, 'INVALID_WINDOW', 400);
    }
    return { circuit_id: circuitId, start, end };
  });

  return windows;
}

/**
 * 停电检修预演：不落库、不改树、不改接线与运行时段，
 * 只在当前配置上重算“原负载 / 剩余供电负载 / 失供负载”。
 * 因为不产生任何配置变化，不影响改接预演令牌，也不自增配置版本。
 */
router.post('/rehearse', (req, res) => {
  const body = req.body ?? {};
  const windows = parseWindows(body.windows);

  const circuits = listCircuits();
  const devices = listDevices();
  const periods = periodsByDevice();

  if (periods.size === 0) {
    throw new HttpError('当前没有任何设备运行时段，停电预演无法关联到负载时间线，请先录入设备运行时段', 'NO_TIMELINE', 422);
  }

  const result = computeOutageImpact(circuits, devices, periods, windows);
  res.status(201).json({
    config_version: getConfigVersion(),
    note: '停电预演为只读计算：不改变配电树、设备接线与运行时段',
    ...result,
  });
});

export default router;
