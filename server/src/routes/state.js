import { Router } from 'express';
import { currentState, listCircuits, listDevices, periodsByDevice } from '../state.js';
import { computeLoads, dfsOrder } from '../load.js';

const router = Router();

/** 当前完整配置（回路、设备、时段、版本号） */
router.get('/state', (req, res) => {
  res.json(currentState());
});

/**
 * 当前负载视图：
 * - circuits：按树的深度优先顺序输出每个回路的分段负载、峰值与超限区间；
 * - range：所有时段覆盖的全局时间范围。
 */
router.get('/load', (req, res) => {
  const circuits = listCircuits();
  const devices = listDevices();
  const periods = periodsByDevice();
  const { circuits: loads, range } = computeLoads(circuits, devices, periods);

  const out = dfsOrder(circuits).map((c) => {
    const r = loads.get(c.id);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      parent_id: c.parent_id,
      rated_power: c.rated_power,
      peak: r.peak,
      timeline: r.timeline,
      overloads: r.over,
    };
  });
  res.json({ range, circuits: out });
});

export default router;
