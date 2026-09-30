import { Router } from 'express';
import { getDb, bumpConfigVersion } from '../db.js';
import { requireName, requirePositivePower, normalizePeriods } from '../validators.js';
import HttpError from '../httpError.js';
import { assertLeafCircuit } from './circuits.js';

const router = Router();

/** 读取设备完整信息（含已合并的运行时段） */
function loadDevice(id) {
  const device = getDb().prepare(`SELECT id, name, power_w, circuit_id, position FROM devices WHERE id = ?`).get(id);
  if (!device) return null;
  device.periods = getDb()
    .prepare(`SELECT start, end FROM device_periods WHERE device_id = ? ORDER BY start, end`)
    .all(id);
  return device;
}

/** 用给定时段整体替换设备时段（调用方事务内执行） */
function replacePeriods(txDb, deviceId, periods) {
  txDb.prepare(`DELETE FROM device_periods WHERE device_id = ?`).run(deviceId);
  const stmt = txDb.prepare(`INSERT INTO device_periods(device_id, start, end) VALUES (?,?,?)`);
  for (const p of periods) stmt.run(deviceId, p.start, p.end);
}

/** 新增设备：名称、正功率、必须接入已存在的末级回路、时段合法 */
router.post('/', (req, res) => {
  const body = req.body ?? {};
  const name = requireName(body.name, '设备');
  const power = requirePositivePower(body.power_w, '设备功率');
  if (!Number.isInteger(Number(body.circuit_id)) || Number(body.circuit_id) <= 0) {
    throw new HttpError('必须指定接入回路', 'MISSING_CIRCUIT', 400);
  }
  const circuitId = Number(body.circuit_id);
  assertLeafCircuit(circuitId);
  const periods = normalizePeriods(body.periods ?? []);

  const db = getDb();
  let id;
  const tx = db.transaction(() => {
    const pos = (db.prepare(`SELECT COALESCE(MAX(position),0)+1 AS p FROM devices WHERE circuit_id = ?`).get(circuitId)?.p) ?? 1;
    const info = db.prepare(`INSERT INTO devices(name, power_w, circuit_id, position) VALUES (?,?,?,?)`).run(name, power, circuitId, pos);
    id = info.lastInsertRowid;
    replacePeriods(db, id, periods);
    bumpConfigVersion(db);
  });
  tx();
  res.status(201).json(loadDevice(id));
});

/** 修改设备：可改名、改功率、改时段；改回路请走 /rehearsals 预演流程 */
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const device = getDb().prepare(`SELECT * FROM devices WHERE id = ?`).get(id);
  if (!device) throw new HttpError(`设备 ${id} 不存在`, 'NOT_FOUND', 404);

  const body = req.body ?? {};
  if (body.circuit_id !== undefined && Number(body.circuit_id) !== device.circuit_id) {
    throw new HttpError('设备改接回路必须先预演再确认，请调用 /api/rehearsals', 'REHEARSAL_REQUIRED', 400);
  }
  const name = body.name !== undefined ? requireName(body.name, '设备') : device.name;
  const power = body.power_w !== undefined ? requirePositivePower(body.power_w, '设备功率') : device.power_w;
  const periods = body.periods !== undefined ? normalizePeriods(body.periods) : null;

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE devices SET name=?, power_w=? WHERE id=?`).run(name, power, id);
    if (periods) replacePeriods(db, id, periods);
    bumpConfigVersion(db);
  });
  tx();
  res.json(loadDevice(id));
});

/** 删除设备（含时段，整事务） */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const device = getDb().prepare(`SELECT id FROM devices WHERE id = ?`).get(id);
  if (!device) throw new HttpError(`设备 ${id} 不存在`, 'NOT_FOUND', 404);

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
    bumpConfigVersion(db);
  });
  tx();
  res.status(204).end();
});

export default router;
