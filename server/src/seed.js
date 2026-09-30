import { getDb } from './db.js';

/**
 * 首次启动且数据库为空时写入演示数据：
 * 主配电箱 → 灯光分箱 / 音响分箱 → 末级回路 → 设备。
 * 「舞台灯回路」上的三台灯具在 19:30–21:00 重叠运行，
 * 合计 13kW 超过 12kW 额定，构成一个可见的超限区间。
 */
export function seedDemo() {
  const db = getDb();
  const count = db.prepare(`SELECT COUNT(*) AS n FROM circuits`).get().n;
  if (count > 0) return false;

  const insCircuit = db.prepare(
    `INSERT INTO circuits(name, kind, rated_power, parent_id, position) VALUES (?,?,?,?,?)`,
  );
  const insDevice = db.prepare(
    `INSERT INTO devices(name, power_w, circuit_id, position) VALUES (?,?,?,?)`,
  );
  const insPeriod = db.prepare(`INSERT INTO device_periods(device_id, start, end) VALUES (?,?,?)`);

  const tx = db.transaction(() => {
    const main = insCircuit.run('主配电箱 AP', 'box', 60000, null, 1).lastInsertRowid;
    const lightBox = insCircuit.run('灯光分箱 LP', 'box', 30000, main, 1).lastInsertRowid;
    const soundBox = insCircuit.run('音响分箱 SP', 'box', 20000, main, 2).lastInsertRowid;

    const stageLights = insCircuit.run('舞台灯回路 L1', 'circuit', 12000, lightBox, 1).lastInsertRowid;
    const ambient = insCircuit.run('环境灯回路 L2', 'circuit', 8000, lightBox, 2).lastInsertRowid;
    const front = insCircuit.run('主扩声回路 S1', 'circuit', 10000, soundBox, 1).lastInsertRowid;
    const monitor = insCircuit.run('监听回路 S2', 'circuit', 6000, soundBox, 2).lastInsertRowid;

    const devices = [
      // 舞台灯回路：19:30–21:00 三台重叠 → 13kW > 12kW
      ['摇头灯 A', 5000, stageLights, [['2026-10-01T18:00', '2026-10-01T21:30']]],
      ['帕灯组 B', 4000, stageLights, [['2026-10-01T19:30', '2026-10-01T22:00']]],
      ['追光灯 C', 4000, stageLights, [['2026-10-01T19:00', '2026-10-01T21:00']]],
      // 环境灯：两个时段
      ['观众席灯带', 3000, ambient, [['2026-10-01T17:00', '2026-10-01T19:00'], ['2026-10-01T21:30', '2026-10-01T23:00']]],
      // 音响
      ['主扩音箱', 6000, front, [['2026-10-01T18:30', '2026-10-01T22:30']]],
      ['数字调音台', 800, front, [['2026-10-01T16:00', '2026-10-01T23:00']]],
      ['舞台返听', 2500, monitor, [['2026-10-01T18:30', '2026-10-01T22:30']]],
    ];

    for (const [name, power, cid, periods] of devices) {
      const did = insDevice.run(name, power, cid, 0).lastInsertRowid;
      for (const [start, end] of periods) insPeriod.run(did, `${start}:00`, `${end}:00`);
    }
  });
  tx();
  return true;
}
