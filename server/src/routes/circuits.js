import { Router } from 'express';
import { getDb, bumpConfigVersion } from '../db.js';
import { listCircuits } from '../state.js';
import { requireName, requirePositivePower } from '../validators.js';
import HttpError from '../httpError.js';

const router = Router();

/** 校验 parent_id：可空（根/配电箱）；若非空必须存在 */
function resolveParent(parentId) {
  if (parentId === null || parentId === undefined) return null;
  if (!Number.isInteger(Number(parentId)) || Number(parentId) <= 0) {
    throw new HttpError('上级回路 id 非法', 'INVALID_PARENT', 400);
  }
  const parent = getDb().prepare(`SELECT id FROM circuits WHERE id = ?`).get(Number(parentId));
  if (!parent) throw new HttpError(`上级回路 ${parentId} 不存在（缺失回路）`, 'MISSING_CIRCUIT', 400);
  return Number(parentId);
}

/** 校验 kind，默认 circuit */
function resolveKind(kind) {
  if (kind === undefined) return 'circuit';
  if (kind !== 'box' && kind !== 'circuit') throw new HttpError('kind 只能是 box 或 circuit', 'INVALID_KIND', 400);
  return kind;
}

/** 沿 parent 链检测是否会形成环路（newParentId 是否位于 nodeId 的子树中） */
function wouldCreateCycle(nodeId, newParentId) {
  if (newParentId == null) return false;
  const db = getDb();
  let cur = newParentId;
  const seen = new Set();
  while (cur != null) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) return true; // 数据层已存在环路的兜底
    seen.add(cur);
    const row = db.prepare(`SELECT parent_id FROM circuits WHERE id = ?`).get(cur);
    if (!row) return false;
    cur = row.parent_id;
  }
  return false;
}

/** 设备只能接在末级回路（kind=circuit 且无子节点）上 */
function assertLeafCircuit(circuitId) {
  const c = getDb().prepare(`SELECT id, name, kind FROM circuits WHERE id = ?`).get(circuitId);
  if (!c) throw new HttpError(`回路 ${circuitId} 不存在（缺失回路）`, 'MISSING_CIRCUIT', 400);
  const child = getDb().prepare(`SELECT 1 FROM circuits WHERE parent_id = ? LIMIT 1`).get(circuitId);
  if (child) throw new HttpError(`回路「${c.name}」是上级配电箱，设备只能接入末级回路`, 'NOT_LEAF', 400);
}

/** 新增回路/配电箱 */
router.post('/', (req, res) => {
  const body = req.body ?? {};
  const name = requireName(body.name, '回路');
  const kind = resolveKind(body.kind);
  const ratedPower = requirePositivePower(body.rated_power, '额定功率');
  const parentId = resolveParent(body.parent_id ?? null);
  if (parentId != null) {
    // 父节点必须仍是“可用作上级”的节点；已挂设备的末级回路不允许再挂子节点
    const parent = getDb().prepare(`SELECT id, name FROM circuits WHERE id = ?`).get(parentId);
    const dev = getDb().prepare(`SELECT 1 FROM devices WHERE circuit_id = ? LIMIT 1`).get(parentId);
    if (dev) throw new HttpError(`「${parent.name}」上已接有设备，不能再作为上级配电箱`, 'NODE_HAS_DEVICES', 400);
  }

  const db = getDb();
  let id;
  const tx = db.transaction(() => {
    const pos = (db.prepare(`SELECT COALESCE(MAX(position),0)+1 AS p FROM circuits WHERE IFNULL(parent_id,0) = IFNULL(?,0)`).get(parentId)?.p) ?? 1;
    const info = db
      .prepare(`INSERT INTO circuits(name, kind, rated_power, parent_id, position) VALUES (?,?,?,?,?)`)
      .run(name, kind, ratedPower, parentId, pos);
    id = info.lastInsertRowid;
    bumpConfigVersion(db);
  });
  tx();
  res.status(201).json(db.prepare(`SELECT id, name, kind, rated_power, parent_id, position FROM circuits WHERE id = ?`).get(id));
});

/** 修改回路：改名/额定功率/改挂父节点（改父节点需做环路校验） */
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const circuit = getDb().prepare(`SELECT * FROM circuits WHERE id = ?`).get(id);
  if (!circuit) throw new HttpError(`回路 ${id} 不存在`, 'NOT_FOUND', 404);

  const body = req.body ?? {};
  const name = body.name !== undefined ? requireName(body.name, '回路') : circuit.name;
  const ratedPower = body.rated_power !== undefined ? requirePositivePower(body.rated_power, '额定功率') : circuit.rated_power;
  let parentId = circuit.parent_id;
  if (body.parent_id !== undefined) parentId = resolveParent(body.parent_id);
  const kind = body.kind !== undefined ? resolveKind(body.kind) : circuit.kind;

  if (parentId !== circuit.parent_id) {
    if (wouldCreateCycle(id, parentId)) {
      throw new HttpError('此次移动会使配电树形成环路，操作已拒绝', 'CYCLE', 400);
    }
    // 变为下级节点：目标父节点不能已挂设备
    if (parentId != null) {
      const dev = getDb().prepare(`SELECT 1 FROM devices WHERE circuit_id = ? LIMIT 1`).get(parentId);
      const parent = getDb().prepare(`SELECT name FROM circuits WHERE id = ?`).get(parentId);
      if (dev) throw new HttpError(`「${parent.name}」上已接有设备，不能再作为上级配电箱`, 'NODE_HAS_DEVICES', 400);
    }
  }
  // 降级为配电箱/升级为回路时，树结构不能自相矛盾
  if (kind === 'circuit') {
    const child = getDb().prepare(`SELECT 1 FROM circuits WHERE parent_id = ? LIMIT 1`).get(id);
    if (child) throw new HttpError('该节点下仍有子回路，不能标记为末级回路', 'HAS_CHILDREN', 400);
  }

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE circuits SET name=?, kind=?, rated_power=?, parent_id=? WHERE id=?`).run(
      name,
      kind,
      ratedPower,
      parentId,
      id,
    );
    bumpConfigVersion(db);
  });
  tx();
  res.json(db.prepare(`SELECT id, name, kind, rated_power, parent_id, position FROM circuits WHERE id = ?`).get(id));
});

/** 删除回路：其全部后代、挂接设备及设备时段随外键级联删除（整事务，无残留） */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const circuit = getDb().prepare(`SELECT id FROM circuits WHERE id = ?`).get(id);
  if (!circuit) throw new HttpError(`回路 ${id} 不存在`, 'NOT_FOUND', 404);

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM circuits WHERE id = ?`).run(id);
    bumpConfigVersion(db);
  });
  tx();
  res.status(204).end();
});

export default router;
export { assertLeafCircuit };
