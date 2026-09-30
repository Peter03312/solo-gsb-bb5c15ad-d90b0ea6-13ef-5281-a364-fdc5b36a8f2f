import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { buildTree, circuitPath, kW, mdhm, toLocalInput } from '../utils.js';

export default function DevicesTab({ state, refresh, setError }) {
  const tree = useMemo(() => buildTree(state.circuits), [state.circuits]);
  // 只有末级回路可以接设备
  const leafIds = state.circuits.filter((c) => (tree.children.get(c.id)?.length ?? 0) === 0).map((c) => c.id);

  const [dialog, setDialog] = useState(null); // {mode, device?}
  const [name, setName] = useState('');
  const [power, setPower] = useState('');
  const [circuitId, setCircuitId] = useState('');
  const [periods, setPeriods] = useState([{ start: '', end: '' }]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const openCreate = () => {
    setDialog({ mode: 'create' });
    setName('');
    setPower('');
    setCircuitId(leafIds[0] ? String(leafIds[0]) : '');
    setPeriods([{ start: '', end: '' }]);
    setErr(null);
  };

  const openEdit = (d) => {
    setDialog({ mode: 'edit', device: d });
    setName(d.name);
    setPower(String(d.power_w / 1000));
    setCircuitId(String(d.circuit_id));
    const ps = (state.periods[d.id] ?? []).map((p) => ({ start: toLocalInput(p.start), end: toLocalInput(p.end) }));
    setPeriods(ps.length ? ps : [{ start: '', end: '' }]);
    setErr(null);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const cleanPeriods = periods
        .filter((p) => p.start || p.end)
        .map((p) => ({ start: p.start, end: p.end }));
      // 起早于终、左闭右开、重叠合并由后端最终校验，前端先给出基本错误
      for (const p of cleanPeriods) {
        if (!p.start || !p.end) throw new Error('每个运行时段都必须填写起点和终点');
        if (!(p.start < p.end)) throw new Error('存在起点不早于终点的时段（时段左闭右开）');
      }
      const payload = {
        name,
        power_w: Math.round(Number(power) * 1000),
        circuit_id: Number(circuitId),
        periods: cleanPeriods,
      };
      if (dialog.mode === 'create') await api.createDevice(payload);
      else await api.updateDevice(dialog.device.id, payload);
      setDialog(null);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d) => {
    if (!window.confirm(`确定删除设备「${d.name}」？其运行时段一并删除。`)) return;
    try {
      await api.deleteDevice(d.id);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div>
      <div className="section-head">
        <h2>设备与运行时段</h2>
        <button className="btn primary" onClick={openCreate} disabled={leafIds.length === 0}>
          + 新增设备
        </button>
      </div>
      {leafIds.length === 0 && (
        <div className="banner-warn">当前没有末级回路，请先到「配电树」页创建回路。</div>
      )}

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>设备</th><th>功率</th><th>接入回路</th><th>运行时段（左闭右开）</th><th></th>
            </tr>
          </thead>
          <tbody>
            {state.devices.map((d) => {
              const ps = state.periods[d.id] ?? [];
              return (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{kW(d.power_w)} kW</td>
                  <td className="muted">{tree.byId.has(d.circuit_id) ? circuitPath(d.circuit_id, tree.byId) : `回路#${d.circuit_id}（缺失）`}</td>
                  <td>
                    {ps.length === 0 && <span className="muted">不运行</span>}
                    {ps.map((p, i) => (
                      <span key={i} className="chip">{mdhm(p.start)} – {mdhm(p.end)}</span>
                    ))}
                  </td>
                  <td className="nowrap">
                    <button className="btn-mini" onClick={() => openEdit(d)}>编辑</button>
                    <button className="btn-mini danger" onClick={() => remove(d)}>删除</button>
                  </td>
                </tr>
              );
            })}
            {state.devices.length === 0 && (
              <tr><td colSpan={5} className="muted center">还没有设备</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {dialog && (
        <div className="modal-mask" onClick={() => setDialog(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>{dialog.mode === 'create' ? '新增设备' : `编辑设备「${dialog.device.name}」`}</h3>
            <div className="form-row">
              <label className="field">
                <span>设备名称</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span>功率 (kW，须为正数)</span>
                <input type="number" step="0.001" min="0" value={power} onChange={(e) => setPower(e.target.value)} />
              </label>
              <label className="field grow">
                <span>接入末级回路</span>
                <select value={circuitId} onChange={(e) => setCircuitId(e.target.value)}>
                  {leafIds.map((id) => (
                    <option key={id} value={id}>{circuitPath(id, tree.byId)}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="period-head">
              <span>运行时段（重叠或相邻时段会自动合并，同一设备只计一次）</span>
              <button className="btn-mini" onClick={() => setPeriods([...periods, { start: '', end: '' }])}>+ 时段</button>
            </div>
            {periods.map((p, i) => (
              <div className="period-row" key={i}>
                <input
                  type="datetime-local"
                  value={p.start}
                  onChange={(e) => setPeriods(periods.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
                />
                <span className="muted">至</span>
                <input
                  type="datetime-local"
                  value={p.end}
                  onChange={(e) => setPeriods(periods.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
                />
                <button
                  className="btn-mini danger"
                  disabled={periods.length === 1}
                  onClick={() => setPeriods(periods.filter((_, j) => j !== i))}
                >
                  移除
                </button>
              </div>
            ))}

            {err && <div className="inline-error">{err}</div>}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDialog(null)}>取消</button>
              <button className="btn primary" disabled={busy} onClick={submit}>
                {busy ? '提交中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
