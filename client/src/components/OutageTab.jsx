import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { buildTree, circuitPath, kW, mdhm, toMinutes } from '../utils.js';

const LABEL_W = 232;
const ROW_H = 64;
const PLOT_W = 1080;
const PAD_T = 10;
const PAD_B = 18;
const PLOT_H = ROW_H - PAD_T - PAD_B;

/** 秒数 → 中文时长 */
function durationZh(totalSeconds) {
  let s = Math.round(totalSeconds);
  if (s <= 0) return '0分钟';
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = [];
  if (h) parts.push(`${h}小时`);
  if (m) parts.push(`${m}分钟`);
  if (s) parts.push(`${s}秒`);
  return parts.join('');
}

const blankRow = () => ({ circuit_id: '', start: '', end: '' });

/**
 * 停电检修预演：为多个配电箱/末级回路分别填写停电起止时间，
 * 预演供电影响（失供负载、受影响设备及累计失供时长）。
 * 纯预演：不改配电树、接线与运行时段。
 */
export default function OutageTab({ state }) {
  const tree = useMemo(() => buildTree(state.circuits), [state.circuits]);
  const ordered = useMemo(() => {
    // 深度优先排列，与负载时间线一致
    const out = [];
    const visit = (pid) => {
      for (const id of tree.children.get(pid) ?? []) {
        out.push(tree.byId.get(id));
        visit(id);
      }
    };
    visit(0);
    return out;
  }, [tree]);

  const [rows, setRows] = useState([blankRow()]);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const updateRow = (i, patch) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setResult(null);
  };

  const runPreview = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const outages = rows.map((r) => ({
        circuit_id: Number(r.circuit_id),
        start: r.start,
        end: r.end,
      }));
      const r = await api.outagePreview(outages);
      setResult(r);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="section-head"><h2>停电检修预演</h2></div>

      <div className="card">
        <p className="muted small">
          为配电箱或末级回路填写停电起止时间（可多行、可重叠），停电作用于所选节点及全部后代设备。
          系统只统计设备原运行时段与停电窗口的交集（左闭右开），同一设备受祖先/子节点/重叠窗口影响时合并失供区间、不重复计入。
          预演不会改变配电树、设备接线与运行时段。
        </p>
        <table className="grid compact outage-form">
          <thead>
            <tr><th style={{ width: 40 }}>#</th><th>停电节点（配电箱 / 末级回路）</th><th style={{ width: 220 }}>停电起</th><th style={{ width: 220 }}>停电止</th><th style={{ width: 80 }}></th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="muted">{i + 1}</td>
                <td>
                  <select value={r.circuit_id} onChange={(e) => updateRow(i, { circuit_id: e.target.value })}>
                    <option value="">（请选择回路）</option>
                    {ordered.map((c) => (
                      <option key={c.id} value={c.id}>
                        {circuitPath(c.id, tree.byId)}{c.kind === 'box' ? '（配电箱）' : '（末级回路）'}
                      </option>
                    ))}
                  </select>
                </td>
                <td><input type="datetime-local" step="60" value={r.start} onChange={(e) => updateRow(i, { start: e.target.value })} /></td>
                <td><input type="datetime-local" step="60" value={r.end} onChange={(e) => updateRow(i, { end: e.target.value })} /></td>
                <td>
                  {rows.length > 1 && (
                    <button className="btn-mini danger" onClick={() => { setRows((rs) => rs.filter((_, j) => j !== i)); setResult(null); }}>删除</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="rehearse-actions">
          <button className="btn ghost" onClick={() => setRows((rs) => [...rs, blankRow()])}>+ 增加停电节点</button>
          <button
            className="btn primary"
            disabled={busy || rows.some((r) => !r.circuit_id || !r.start || !r.end)}
            onClick={runPreview}
          >
            {busy ? '预演中…' : '预演供电影响'}
          </button>
        </div>
        {err && <div className="inline-error">{err}</div>}
      </div>

      {result && (
        <OutageResult result={result} />
      )}
    </div>
  );
}

function OutageResult({ result }) {
  const model = useMemo(() => buildChartModel(result), [result]);
  const affectedCircuits = result.circuits.filter((c) => c.affected);
  const unaffectedCount = result.circuits.length - affectedCircuits.length;

  return (
    <>
      <div className="card pass">
        <h3 className="ok-text">✓ 停电预演完成（基于配置 v{result.config_version}，未改动任何配置）</h3>
        <div>
          {result.outage_windows.map((w, i) => (
            <span key={i} className="chip-warn">
              {w.path}：{mdhm(w.start)} – {mdhm(w.end)}
            </span>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          受影响回路 {affectedCircuits.length} 个；未受影响分支 {unaffectedCount} 个，保持原负载。
          全局时间范围：{result.range ? `${mdhm(result.range.start)} – ${mdhm(result.range.end)}` : '无运行时段'}。
        </p>
      </div>

      {/* 受影响回路概览 */}
      {affectedCircuits.length > 0 && (
        <div className="card">
          <h3>受影响回路</h3>
          <table className="grid compact">
            <thead>
              <tr><th>回路</th><th>原负载峰值 kW</th><th>停电期间剩余峰值 kW</th><th>失供峰值 kW</th></tr>
            </thead>
            <tbody>
              {affectedCircuits.map((c) => (
                <tr key={c.id}>
                  <td>{c.kind === 'box' ? '▦ ' : '● '}{c.name}</td>
                  <td>{kW(c.peak)}</td>
                  <td>{kW(c.remaining_peak)}</td>
                  <td className="danger-text">{kW(c.lost_peak)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 时间线：原负载 + 失供填充 */}
      {model && (
        <div className="card">
          <h3>分时段负载（蓝线=原负载，灰区=剩余供电，橙区=失供负载）</h3>
          <div className="timeline-scroll">
            <div className="timeline" style={{ width: LABEL_W + PLOT_W + 8 }}>
              <div className="tl-col-labels" style={{ width: LABEL_W }}>
                {result.circuits.map((c) => (
                  <div key={c.id} className="tl-label" style={{ height: ROW_H }}>
                    <div className="tl-label-name" title={c.name}>
                      <span className={c.kind === 'box' ? 'icon-box' : 'icon-cct'}>{c.kind === 'box' ? '▦' : '●'}</span>
                      {c.name}
                      {c.affected && <span className="badge-danger" title="存在失供区间">停</span>}
                    </div>
                    <div className={c.affected ? 'tl-sub danger-text' : 'tl-sub muted'}>
                      峰值 {kW(c.peak)} / 失供 {kW(c.lost_peak)} kW
                    </div>
                  </div>
                ))}
              </div>
              <div className="tl-col-plot" style={{ width: PLOT_W + 8 }}>
                <svg width={PLOT_W + 8} height={model.totalH + 26} className="tl-svg">
                  {result.circuits.map((c, i) => (
                    <g key={c.id}>
                      <rect x={LABEL_W} y={i * ROW_H} width={PLOT_W} height={ROW_H - 1} fill={i % 2 ? '#f7f8fb' : '#ffffff'} />
                      <line x1={LABEL_W} y1={i * ROW_H} x2={LABEL_W + PLOT_W} y2={i * ROW_H} stroke="#e5e8ef" />
                    </g>
                  ))}
                  {model.ticks.map((t) => (
                    <g key={t.key}>
                      <line x1={t.x} y1={0} x2={t.x} y2={model.totalH} stroke="#eef1f6" />
                      <text x={t.x} y={model.totalH + 18} textAnchor="middle" className="axis-text">{t.label}</text>
                    </g>
                  ))}
                  {result.circuits.map((c, i) => {
                    const row = model.rows[i];
                    const top = i * ROW_H;
                    return (
                      <g key={c.id} transform={`translate(0, ${top})`}>
                        <line x1={LABEL_W} y1={row.yRated} x2={LABEL_W + PLOT_W} y2={row.yRated} stroke="#e11d48" strokeWidth={1.2} strokeDasharray="6 4" />
                        {row.segs.filter((s) => s.lost_load > 0).map((s, j) => (
                          <g key={j}>
                            <rect x={model.x(s.start)} y={row.y(s.load)} width={Math.max(model.x(s.end) - model.x(s.start), 1)} height={row.y(s.load - s.lost_load) - row.y(s.load)} fill="rgba(234,88,12,0.28)" />
                            <rect x={model.x(s.start)} y={row.y(s.load - s.lost_load)} width={Math.max(model.x(s.end) - model.x(s.start), 1)} height={PAD_T + PLOT_H - row.y(s.load - s.lost_load)} fill="rgba(100,116,139,0.12)" />
                            <title>{`${mdhm(s.start)} – ${mdhm(s.end)}；原负载 ${kW(s.load)} kW，剩余 ${kW(s.remaining_load)} kW，失供 ${kW(s.lost_load)} kW`}</title>
                          </g>
                        ))}
                        <path d={row.path} fill="none" stroke="#2563eb" strokeWidth={1.8} />
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 受影响设备及累计失供时长 */}
      {result.affected_devices.length > 0 && (
        <div className="card">
          <h3>受影响设备（累计失供时长）</h3>
          <table className="grid compact">
            <thead>
              <tr><th>设备</th><th>功率 kW</th><th>所在回路</th><th>失供时段</th><th>累计失供时长</th></tr>
            </thead>
            <tbody>
              {result.affected_devices.map((d) => (
                <tr key={d.device_id} className="row-lost">
                  <td>{d.name}</td>
                  <td>{kW(d.power_w)}</td>
                  <td>{d.path}</td>
                  <td>
                    {d.lost_periods.map((p, i) => (
                      <span key={i} className="chip-danger">{mdhm(p.start)} – {mdhm(p.end)}</span>
                    ))}
                  </td>
                  <td className="danger-text"><b>{durationZh(d.lost_seconds)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.affected_devices.length === 0 && (
        <div className="card muted">停电窗口与任何设备运行时段都没有交集：没有设备失供，所有回路保持原负载。</div>
      )}
    </>
  );
}

/** 与 LoadTab 相同的像素坐标模型（按停电结果的时间范围） */
function buildChartModel(result) {
  const { range, circuits } = result;
  if (!range) return null;
  const t0 = toMinutes(range.start);
  const t1 = toMinutes(range.end);
  const span = Math.max(t1 - t0, 1);
  const x = (t) => LABEL_W + ((toMinutes(t) - t0) / span) * PLOT_W;

  const ticks = [];
  for (let i = 0; i <= 5; i++) {
    const m = t0 + (span * i) / 5;
    const ms = new Date(m * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    const label =
      i === 0 || i === 5
        ? `${pad(ms.getUTCMonth() + 1)}-${pad(ms.getUTCDate())} ${pad(ms.getUTCHours())}:${pad(ms.getUTCMinutes())}`
        : `${pad(ms.getUTCMonth() + 1)}-${pad(ms.getUTCDate())} ${pad(ms.getUTCHours())}:${pad(ms.getUTCMinutes())}`;
    ticks.push({ x: LABEL_W + (PLOT_W * i) / 5, label, key: i });
  }

  const rows = circuits.map((c) => {
    const maxLoad = Math.max(c.peak, c.rated_power) * 1.12;
    const y = (w) => PAD_T + PLOT_H * (1 - w / maxLoad);
    const segs = c.timeline;
    let path = '';
    if (segs.length) {
      path = `M ${x(segs[0].start)} ${y(segs[0].load)}`;
      for (const s of segs) path += ` L ${x(s.start)} ${y(s.load)} L ${x(s.end)} ${y(s.load)}`;
    }
    return { segs, path, y, yRated: y(c.rated_power) };
  });

  return { x, ticks, rows, totalH: ROW_H * rows.length + PAD_B };
}
