import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { buildTree, circuitPath, kW, mdhm } from '../utils.js';

/**
 * 设备改接：先预演（服务器在假设配置上重算并检查全部祖先），
 * 通过后拿到一次性 token；确认时若配置版本已变化则被拒绝，必须重新预演。
 */
export default function RehearseTab({ state, load, refresh, setError, rehearsal, setRehearsal }) {
  const tree = useMemo(() => buildTree(state.circuits), [state.circuits]);
  const leafIds = state.circuits.filter((c) => (tree.children.get(c.id)?.length ?? 0) === 0).map((c) => c.id);

  const [deviceId, setDeviceId] = useState(state.devices[0] ? String(state.devices[0].id) : '');
  const [toCircuit, setToCircuit] = useState(leafIds[0] ? String(leafIds[0]) : '');
  const [err, setErr] = useState(null);
  const [violations, setViolations] = useState(null);
  const [busy, setBusy] = useState(false);

  const device = state.devices.find((d) => String(d.id) === deviceId);
  const stale = rehearsal && rehearsal.config_version !== state.version;

  const runRehearsal = async () => {
    setBusy(true);
    setErr(null);
    setViolations(null);
    try {
      if (!deviceId || !toCircuit) throw new Error('请选择设备与目标回路');
      const r = await api.rehearse(Number(deviceId), Number(toCircuit));
      setRehearsal(r);
    } catch (e) {
      setRehearsal(null);
      if (e.code === 'OVERLOADED') {
        setViolations(e.details);
      } else {
        setErr(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.confirmRehearsal(rehearsal.token);
      setRehearsal(null);
      setViolations(null);
      await refresh();
    } catch (e) {
      if (e.code === 'STALE' || e.status === 410) {
        setRehearsal(null);
        setErr(`确认失败：${e.message}`);
      } else {
        setErr(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    try {
      if (rehearsal) await api.discardRehearsal(rehearsal.token);
    } catch {
      /* 放弃失败不阻塞界面 */
    }
    setRehearsal(null);
    setViolations(null);
    setErr(null);
  };

  const targetMatchesRehearsal =
    rehearsal && String(rehearsal.device_id) === deviceId && String(rehearsal.to_circuit_id) === toCircuit;

  return (
    <div>
      <div className="section-head"><h2>设备改接预演</h2></div>

      <div className="card">
        <div className="form-row">
          <label className="field grow">
            <span>设备</span>
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {state.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}（{kW(d.power_w)} kW，当前：{tree.byId.has(d.circuit_id) ? circuitPath(d.circuit_id, tree.byId) : `#${d.circuit_id}`}）
                </option>
              ))}
            </select>
          </label>
          <span className="arrow">改接 →</span>
          <label className="field grow">
            <span>目标末级回路</span>
            <select value={toCircuit} onChange={(e) => setToCircuit(e.target.value)}>
              {leafIds
                .filter((id) => !device || id !== device.circuit_id)
                .map((id) => (
                  <option key={id} value={id}>{circuitPath(id, tree.byId)}</option>
                ))}
            </select>
          </label>
        </div>

        {device && (
          <p className="muted small">
            当前接入：{circuitPath(device.circuit_id, tree.byId)}；设备运行时段：
            {(state.periods[device.id] ?? []).map((p, i) => (
              <span key={i} className="chip">{mdhm(p.start)} – {mdhm(p.end)}</span>
            ))}
            {(state.periods[device.id] ?? []).length === 0 && '不运行'}
          </p>
        )}

        <div className="rehearse-actions">
          <button className="btn" onClick={runRehearsal} disabled={busy || !deviceId || !toCircuit}>
            {busy ? '预演中…' : '① 预演'}
          </button>
          <button
            className="btn primary"
            onClick={confirm}
            disabled={busy || !rehearsal || stale || !targetMatchesRehearsal}
            title={!rehearsal ? '请先预演' : stale ? '配置已变化，需重新预演' : !targetMatchesRehearsal ? '选项已修改，需重新预演' : ''}
          >
            ② 确认改接
          </button>
          {rehearsal && (
            <button className="btn ghost" onClick={discard} disabled={busy}>放弃预演</button>
          )}
        </div>

        {err && <div className="inline-error">{err}</div>}
      </div>

      {/* 预演拒绝：列出每个超额祖先回路、时段与峰值 */}
      {violations && (
        <div className="card reject">
          <h3 className="danger-text">✕ 预演未通过 —— 整次改接被拒绝，未改动任何配置</h3>
          <p className="muted">
            设备「{violations.device.name}」（{kW(violations.device.power_w)} kW）改接后，
            以下回路在部分时段的汇总负载超过额定：
          </p>
          {violations.violations.map((v) => (
            <div key={v.circuit_id} className="violation-block">
              <div>
                <strong>{v.path}</strong>
                <span className="muted">（额定 {kW(v.rated_power)} kW，时段峰值 {kW(v.peak)} kW）</span>
              </div>
              <ul>
                {v.over.map((o, i) => (
                  <li key={i}>
                    超额时段 <b>{mdhm(o.start)} – {mdhm(o.end)}</b>，
                    峰值 <b className="danger-text">{kW(o.peak)} kW</b>，
                    超出 {kW(o.peak - v.rated_power)} kW
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* 预演通过 */}
      {rehearsal && (
        <div className={`card ${stale ? 'reject' : 'pass'}`}>
          <h3 className={stale ? 'danger-text' : 'ok-text'}>
            {stale ? '✕ 预演已失效' : '✓ 预演通过，可以确认改接'}
          </h3>
          {stale ? (
            <p>预演后配置发生过变化（当前为 v{state.version}，预演基于 v{rehearsal.config_version}），请重新预演。</p>
          ) : (
            <>
              <p>
                基于配置 v{rehearsal.config_version}：
                {circuitPath(rehearsal.from_circuit_id, tree.byId)} →{' '}
                {circuitPath(rehearsal.to_circuit_id, tree.byId)}
              </p>
              <table className="grid compact">
                <thead>
                  <tr><th>受影响回路（目标及其全部祖先）</th><th>额定 kW</th><th>改接后峰值 kW</th><th>结果</th></tr>
                </thead>
                <tbody>
                  {rehearsal.affected.map((a) => (
                    <tr key={a.circuit_id}>
                      <td>{a.path}</td>
                      <td>{kW(a.rated_power)}</td>
                      <td>{kW(a.peak)}</td>
                      <td className="ok-text">有裕量 {kW(a.rated_power - a.peak)} kW</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">在点击「确认改接」前若修改了任何配置（回路、设备、时段或做了其它改接），本预演会立即失效。</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
