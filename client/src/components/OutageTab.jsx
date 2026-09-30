import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { buildTree, circuitPath, kW, mdhm } from '../utils.js';

const emptyRow = () => ({ circuit_id: '', start: '', end: '' });

/**
 * 停电检修预演：为多个配电箱/末级回路填写停电起止窗口，
 * 服务端只读重算各时间段“原负载 / 剩余供电负载 / 失供负载”，
 * 并给出受影响设备与累计失供时长。不改变配电树、接线与运行时段。
 */
export default function OutageTab({ state }) {
  const tree = useMemo(() => buildTree(state.circuits), [state.circuits]);
  const ordered = useMemo(() => {
    const out = [];
    const walk = (pid, depth) => {
      for (const id of tree.children.get(pid) ?? []) {
        out.push({ c: tree.byId.get(id), depth });
        walk(id, depth + 1);
      }
    };
    walk(0, 0);
    return out;
  }, [tree]);

  const [rows, setRows] = useState([emptyRow()]);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const setRow = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const run = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const windows = rows.filter((r) => r.circuit_id || r.start || r.end);
      // 前端先做一轮明确校验，最终以后端为准
      if (windows.length === 0) throw new Error('停电方案不能为空：请至少填写一个停电窗口');
      for (const [i, w] of windows.entries()) {
        if (!w.circuit_id) throw new Error(`第 ${i + 1} 个窗口未选择配电箱或回路`);
        if (!w.start || !w.end) throw new Error(`第 ${i + 1} 个窗口必须填写停电起止时间`);
        if (!(w.start < w.end)) throw new Error(`第 ${i + 1} 个窗口起点必须早于终点（左闭右开）`);
      }
      const r = await api.outageRehearse(
        windows.map((w) => ({ circuit_id: Number(w.circuit_id), start: w.start, end: w.end })),
      );
      setResult(r);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const hasTimeline = Object.keys(state.periods).length > 0;

  return (
    <div>
      <div className="section-head">
        <h2>停电检修预演</h2>
        <span className="muted small">基于配置 v{state.version} · 预演不落库、不改变任何配置</span>
      </div>

      <div className="card">
        <p className="muted small">
          为一个或多个配电箱 / 末级回路填写停电起止时间。停电作用于所选节点及其全部后代设备，
          只统计设备原运行时段与停电窗口的交集（左闭右开）；祖先、子节点或互相重叠的窗口会先合并，
          同一设备不重复计入。
        </p>

        <div className="outage-rows">
          <div className="outage-row head">
            <span>停电节点（配电箱或末级回路）</span>
            <span>停电起</span>
            <span>停电止</span>
            <span></span>
          </div>
          {rows.map((r, i) => (
            <div className="outage-row" key={i}>
              <select value={r.circuit_id} onChange={(e) => setRow(i, { circuit_id: e.target.value })}>
                <option value="">（请选择节点）</option>
                {ordered.map(({ c, depth }) => (
                  <option key={c.id} value={c.id}>
                    {'　'.repeat(depth)}
                    {c.kind === 'box' ? '▦ ' : '● '}
                    {c.name}
                  </option>
                ))}
              </select>
              <input
                type="datetime-local"
                value={r.start}
                onChange={(e) => setRow(i, { start: e.target.value })}
              />
              <input
                type="datetime-local"
                value={r.end}
                onChange={(e) => setRow(i, { end: e.target.value })}
              />
              <button
                className="btn-mini danger"
                disabled={rows.length === 1}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                移除
              </button>
            </div>
          ))}
        </div>

        <div className="rehearse-actions">
          <button className="btn" onClick={() => setRows([...rows, emptyRow()])}>+ 增加停电节点</button>
          <button className="btn primary" onClick={run} disabled={busy || !hasTimeline}>
            {busy ? '预演中…' : '预演供电影响'}
          </button>
          {result && <button className="btn ghost" onClick={() => setResult(null)}>清除结果</button>}
        </div>

        {!hasTimeline && (
          <div className="banner-warn">当前没有任何设备运行时段，无法预演；请先到「设备与时段」页录入。</div>
        )}
        {err && <div className="inline-error">{err}</div>}
      </div>

      {result && <OutageResult result={result} tree={tree} />}
    </div>
  );
}

function OutageResult({ result, tree }) {
  const { totals, windows, circuits, affected_devices: devs } = result;
  const affectedCircuits = circuits.filter((c) => c.affected);
  const unaffectedCircuits = circuits.filter((c) => !c.affected);

  return (
    <>
      <div className={`card ${totals.affected_devices > 0 ? 'reject' : 'pass'}`}>
        <h3 className={totals.affected_devices > 0 ? 'danger-text' : 'ok-text'}>
          {totals.affected_devices > 0
            ? `⚠ 预演结果：${totals.affected_circuits} 个回路、${totals.affected_devices} 台设备将受影响`
            : '✓ 该停电方案不影响任何运行中的设备'}
        </h3>
        <div className="summary-line">
          <span>失供负载峰值：<b className={totals.peak_lost_load > 0 ? 'danger-text' : ''}>{kW(totals.peak_lost_load)} kW</b></span>
          <span className="muted small">合并后的停电窗口：</span>
          {windows.map((w) => (
            <span key={w.circuit_id} className="chip-danger">
              {w.path}
              {w.periods.map((p, i) => (
                <span key={i}> {mdhm(p.start)}–{mdhm(p.end)}（{p.duration_text}）</span>
              ))}
            </span>
          ))}
        </div>
        <p className="muted small">本次预演为只读计算：配电树、设备接线与运行时段均未改变。</p>
      </div>

      {devs.length > 0 && (
        <div className="card">
          <h3>受影响设备与累计失供时长</h3>
          <table className="grid compact">
            <thead>
              <tr>
                <th>设备</th><th>功率</th><th>接入回路</th><th>失供区间（左闭右开，已合并去重）</th><th>累计失供</th>
              </tr>
            </thead>
            <tbody>
              {devs.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{kW(d.power_w)} kW</td>
                  <td className="muted">{tree.byId.has(d.circuit_id) ? circuitPath(d.circuit_id, tree.byId) : `#${d.circuit_id}`}</td>
                  <td>
                    {d.outage_periods.map((p, i) => (
                      <span key={i} className="chip-danger">{mdhm(p.start)} – {mdhm(p.end)}（{p.duration_text}）</span>
                    ))}
                  </td>
                  <td><b className="danger-text">{d.total_lost_text}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>各回路时间段负载（原负载 / 剩余供电 / 失供）</h3>
        {affectedCircuits.map((c) => (
          <CircuitSegments key={c.id} c={c} affected />
        ))}
        {unaffectedCircuits.length > 0 && (
          <details className="unaffected">
            <summary className="muted">未受影响分支（{unaffectedCircuits.length} 个回路，保持原负载）</summary>
            {unaffectedCircuits.map((c) => (
              <CircuitSegments key={c.id} c={c} />
            ))}
          </details>
        )}
      </div>
    </>
  );
}

function CircuitSegments({ c, affected = false }) {
  const active = c.timeline.filter((s) => s.load > 0 || s.lost_load > 0);
  return (
    <div className={`circuit-segs ${affected ? 'affected' : ''}`}>
      <div className="segs-head">
        <span className={c.kind === 'box' ? 'icon-box' : 'icon-cct'}>{c.kind === 'box' ? '▦' : '●'}</span>
        <b>{c.name}</b>
        {affected && <span className="tag-danger">受影响</span>}
        <span className="muted small">
          额定 {kW(c.rated_power)} kW · 原峰值 {kW(c.peak)} kW
          {affected && <> · 失供峰值 <b className="danger-text">{kW(c.peak_lost)} kW</b></>}
        </span>
      </div>
      {active.length === 0 ? (
        <div className="muted small seg-empty">该回路下无运行设备，负载始终为 0。</div>
      ) : (
        <table className="grid compact seg-table">
          <thead>
            <tr><th>时间段（左闭右开）</th><th>原负载 kW</th><th>剩余供电 kW</th><th>失供 kW</th></tr>
          </thead>
          <tbody>
            {active.map((s, i) => (
              <tr key={i} className={s.lost_load > 0 ? 'seg-lost' : ''}>
                <td>{mdhm(s.start)} – {mdhm(s.end)}</td>
                <td>{kW(s.load)}</td>
                <td className={s.lost_load > 0 ? 'ok-text' : ''}>{kW(s.remaining_load)}</td>
                <td className={s.lost_load > 0 ? 'danger-text' : 'muted'}>{s.lost_load > 0 ? kW(s.lost_load) : '0'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
