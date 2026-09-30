import { getDb } from './db.js';

/** 读取全部回路 */
export function listCircuits() {
  return getDb()
    .prepare(`SELECT id, name, kind, rated_power, parent_id, position FROM circuits ORDER BY id`)
    .all();
}

/** 读取全部设备（不含时段） */
export function listDevices() {
  return getDb()
    .prepare(`SELECT id, name, power_w, circuit_id, position FROM devices ORDER BY id`)
    .all();
}

/** 按设备汇总其运行时段，起点升序 */
export function periodsByDevice() {
  const rows = getDb()
    .prepare(`SELECT device_id, start, end FROM device_periods ORDER BY start, end`)
    .all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.device_id)) map.set(r.device_id, []);
    map.get(r.device_id).push({ start: r.start, end: r.end });
  }
  return map;
}

/** 读取单个设备（含时段） */
export function getDevice(id) {
  const device = getDb().prepare(`SELECT id, name, power_w, circuit_id, position FROM devices WHERE id = ?`).get(id);
  if (!device) return null;
  device.periods = getDb()
    .prepare(`SELECT start, end FROM device_periods WHERE device_id = ? ORDER BY start, end`)
    .all(id);
  return device;
}

/**
 * 组装当前完整配置：回路树、设备、每设备时段、配置版本。
 */
export function currentState() {
  const circuits = listCircuits();
  const devices = listDevices();
  return {
    version: Number(getDb().prepare(`SELECT value FROM meta WHERE key = 'config_version'`).get().value),
    circuits,
    devices,
    periods: Object.fromEntries(periodsByDevice()),
  };
}
