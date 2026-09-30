import { Router } from 'express';
import crypto from 'node:crypto';
import { getDb, bumpConfigVersion, getConfigVersion } from '../db.js';
import { listCircuits, listDevices, periodsByDevice } from '../state.js';
import { computeLoads, selfAndAncestors } from '../load.js';
import HttpError from '../httpError.js';
import { assertLeafCircuit } from './circuits.js';

const router = Router();

/** 回路自顶向下的路径名，便于在报错中指认 */
function circuitPath(circuitId, byId) {
  const names = [];
  let cur = byId.get(circuitId);
  while (cur) {
    names.unshift(cur.name);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
  }
  return names.join(' / ');
}

/**
 * 预演设备改接：
 * 1. 校验设备与目标回路（存在、末级回路、非原地改接）；
 * 2. 在“假设改接后”的配置上重算全部负载；
 * 3. 沿目标回路及其全部祖先，只要任一回路上任一运行时段超额，
 *    即拒绝整次改接，逐一指出回路、时段与该时段峰值；
 * 4. 通过则签发一次性预演 token，配置变化后 token 立即失效。
 */
router.post('/', (req, res) => {
  const body = req.body ?? {};
  const deviceId = Number(body.device_id);
  const toCircuitId = Number(body.to_circuit_id);
  if (!Number.isInteger(deviceId) || deviceId <= 0) throw new HttpError('必须指定设备 id', 'MISSING_DEVICE', 400);
  if (!Number.isInteger(toCircuitId) || toCircuitId <= 0) throw new HttpError('必须指定目标回路 id', 'MISSING_CIRCUIT', 400);

  const db = getDb();
  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId);
  if (!device) throw new HttpError(`设备 ${deviceId} 不存在`, 'DEVICE_NOT_FOUND', 404);
  if (device.circuit_id === toCircuitId) {
    throw new HttpError('设备已在该回路上，无需改接', 'NO_MOVE', 400);
  }
  assertLeafCircuit(toCircuitId);

  const circuits = listCircuits();
  const devices = listDevices().map((d) => (d.id === deviceId ? { ...d, circuit_id: toCircuitId } : d));
  const periods = periodsByDevice();
  const { circuits: loads, byId } = computeLoads(circuits, devices, periods);

  // 新路径：目标回路自身 + 其全部祖先
  const affectedIds = selfAndAncestors(toCircuitId, byId);
  const affected = affectedIds.map((cid) => {
    const c = byId.get(cid);
    const r = loads.get(cid);
    return {
      circuit_id: cid,
      name: c.name,
      path: circuitPath(cid, byId),
      rated_power: c.rated_power,
      peak: r.peak,
      over: r.over,
    };
  });

  const violations = affected.filter((a) => a.over.length > 0);
  if (violations.length > 0) {
    // 拒绝：不落库任何预演记录，配置保持原样
    throw new HttpError('预演未通过：改接后将有回路在部分时段超额，整次改接被拒绝', 'OVERLOADED', 422, {
      device: { id: device.id, name: device.name, power_w: device.power_w },
      violations,
    });
  }

  const token = crypto.randomUUID();
  const version = getConfigVersion();
  db.prepare(
    `INSERT INTO rehearsals(token, device_id, from_circuit_id, to_circuit_id, config_version) VALUES (?,?,?,?,?)`,
  ).run(token, deviceId, device.circuit_id, toCircuitId, version);

  res.status(201).json({
    token,
    config_version: version,
    device_id: deviceId,
    from_circuit_id: device.circuit_id,
    to_circuit_id: toCircuitId,
    affected,
  });
});

/**
 * 确认改接：
 * - token 不存在/已使用 → 410；
 * - 预演后配置发生过任何变化（版本号已变）→ 410，要求重新预演；
 * - 全部成功才移动设备，失败不产生部分配置。
 */
router.post('/:token/confirm', (req, res) => {
  const token = String(req.params.token);
  const db = getDb();
  const rehearsal = db.prepare(`SELECT * FROM rehearsals WHERE token = ?`).get(token);
  if (!rehearsal) {
    throw new HttpError('预演不存在、已确认或已失效，请重新预演', 'REHEARSAL_NOT_FOUND', 410);
  }

  const version = getConfigVersion();
  if (version !== rehearsal.config_version) {
    db.prepare(`DELETE FROM rehearsals WHERE id = ?`).run(rehearsal.id);
    throw new HttpError('预演后配置已发生变化，确认已失效，请重新预演后再确认', 'STALE', 410, {
      rehearsal_version: rehearsal.config_version,
      current_version: version,
    });
  }

  // 预演未失效意味着配置未变，这里仍做防御性检查
  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(rehearsal.device_id);
  if (!device || device.circuit_id !== rehearsal.from_circuit_id) {
    db.prepare(`DELETE FROM rehearsals WHERE id = ?`).run(rehearsal.id);
    throw new HttpError('设备状态已变化，确认已失效，请重新预演', 'STALE', 410);
  }
  const target = db.prepare(`SELECT id FROM circuits WHERE id = ?`).get(rehearsal.to_circuit_id);
  if (!target) {
    db.prepare(`DELETE FROM rehearsals WHERE id = ?`).run(rehearsal.id);
    throw new HttpError('目标回路已不存在，确认已失效，请重新预演', 'STALE', 410);
  }

  let updated;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE devices SET circuit_id = ? WHERE id = ?`).run(rehearsal.to_circuit_id, rehearsal.device_id);
    db.prepare(`DELETE FROM rehearsals WHERE id = ?`).run(rehearsal.id);
    bumpConfigVersion(db);
    updated = db
      .prepare(`SELECT id, name, power_w, circuit_id, position FROM devices WHERE id = ?`)
      .get(rehearsal.device_id);
  });
  tx();
  res.json({ ok: true, device: updated, config_version: getConfigVersion() });
});

/** 放弃预演 */
router.delete('/:token', (req, res) => {
  const info = getDb().prepare(`DELETE FROM rehearsals WHERE token = ?`).run(String(req.params.token));
  if (info.changes === 0) throw new HttpError('预演不存在或已失效', 'REHEARSAL_NOT_FOUND', 404);
  res.status(204).end();
});

export default router;
