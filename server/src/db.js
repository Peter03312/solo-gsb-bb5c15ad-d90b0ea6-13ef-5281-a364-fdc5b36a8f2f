import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db;

export function getDb() {
  return db;
}

/**
 * 打开（必要时新建）SQLite 数据库并完成表结构初始化。
 * 数据文件目录不存在会自动创建，保证挂载卷首次启动即可用。
 */
export function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- 配置版本：任何结构性变更都自增 version，用于使未确认的预演失效
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 配电回路树：根节点为配电箱，末级为回路；kind 仅用于展示
    CREATE TABLE IF NOT EXISTS circuits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'circuit' CHECK (kind IN ('box','circuit')),
      rated_power REAL NOT NULL CHECK (rated_power > 0),
      parent_id  INTEGER REFERENCES circuits(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 用电设备
    CREATE TABLE IF NOT EXISTS devices (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      power_w    REAL NOT NULL CHECK (power_w > 0),
      circuit_id INTEGER NOT NULL REFERENCES circuits(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 设备运行时段（左闭右开，存储前已合并重叠区间）
    CREATE TABLE IF NOT EXISTS device_periods (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      start     TEXT NOT NULL,
      end       TEXT NOT NULL
    );

    -- 设备改接预演：确认后删除；配置变化时未使用的预演整体失效
    CREATE TABLE IF NOT EXISTS rehearsals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      token           TEXT NOT NULL UNIQUE,
      device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      from_circuit_id INTEGER NOT NULL REFERENCES circuits(id) ON DELETE CASCADE,
      to_circuit_id   INTEGER NOT NULL REFERENCES circuits(id) ON DELETE CASCADE,
      config_version  INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_circuits_parent ON circuits(parent_id);
    CREATE INDEX IF NOT EXISTS idx_devices_circuit ON devices(circuit_id);
    CREATE INDEX IF NOT EXISTS idx_periods_device ON device_periods(device_id);
  `);

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'config_version'`).get();
  if (!row) db.prepare(`INSERT INTO meta(key, value) VALUES ('config_version', '1')`).run();

  return db;
}

/** 读取当前配置版本 */
export function getConfigVersion() {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'config_version'`).get();
  return Number(row.value);
}

/**
 * 配置发生变化：版本号自增，同时令所有尚未确认的预演立即失效。
 * 必须在调用方事务内执行。
 */
export function bumpConfigVersion(txDb = db) {
  txDb.prepare(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'config_version'`).run();
  txDb.prepare(`DELETE FROM rehearsals`).run();
  return Number(txDb.prepare(`SELECT value FROM meta WHERE key = 'config_version'`).get().value);
}
