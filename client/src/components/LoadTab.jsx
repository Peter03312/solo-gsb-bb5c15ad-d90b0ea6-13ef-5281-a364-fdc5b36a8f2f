import React, { useMemo } from 'react';
import { kW, mdhm, toMinutes } from '../utils.js';

const LABEL_W = 232;
const ROW_H = 64;
const PLOT_W = 1080;
const PAD_T = 10;
const PAD_B = 18;
const PLOT_H = ROW_H - PAD_T - PAD_B;

/**
 * 负载时间线：每个回路一行，按全局事件点绘制阶梯负载；
 * 超过额定功率的区间用红色填充，并在回路名下列出超限时段与峰值。
 */
export default function LoadTab({ load }) {
  const { range, circuits } = load;

  const model = useMemo(() => {
    if (!range) return null;
    const t0 = toMinutes(range.start);
    const t1 = toMinutes(range.end);
    const span = Math.max(t1 - t0, 1);
    const x = (t) => LABEL_W + ((toMinutes(t) - t0) / span) * PLOT_W;

    // 6 个时间刻度
    const ticks = [];
    for (let i = 0; i <= 5; i++) {
      const m = t0 + (span * i) / 5;
      // 反查刻度的定长字符串：直接用线性分钟数还原
      const ms = new Date(m * 60000);
      const pad = (n) => String(n).padStart(2, '0');
      const label =
        i === 0 || i === 5
          ? mdhmFmt(ms, pad)
          : `${pad(ms.getUTCMonth() + 1)}-${pad(ms.getUTCDate())} ${pad(ms.getUTCHours())}:${pad(ms.getUTCMinutes())}`;
      ticks.push({ x: LABEL_W + (PLOT_W * i) / 5, label, key: i });
    }

    const rows = circuits.map((c) => {
      const maxLoad = Math.max(c.peak, c.rated_power) * 1.12;
      const y = (w) => PAD_T + PLOT_H * (1 - w / maxLoad);
      const yRated = y(c.rated_power);

      const segs = c.timeline;
      let path = '';
      if (segs.length) {
        path = `M ${x(segs[0].start)} ${y(segs[0].load)}`;
        for (const s of segs) {
          path += ` L ${x(s.start)} ${y(s.load)} L ${x(s.end)} ${y(s.load)}`;
        }
      }
      const overRects = [];
      for (const s of segs) {
        if (s.load > c.rated_power) {
          overRects.push({
            x: x(s.start),
            width: Math.max(x(s.end) - x(s.start), 1),
            y: y(s.load),
            height: yRated - y(s.load),
            load: s.load,
            start: s.start,
            end: s.end,
          });
        }
      }
      return { c, path, yRated, overRects, areaPath: buildArea(segs, x, y, PLOT_H, PAD_T) };
    });

    return { x, t0, t1, ticks, rows, totalH: ROW_H * rows.length + PAD_B };
  }, [range, circuits]);

  if (!range) {
    return (
      <div>
        <h2>负载时间线</h2>
        <div className="card muted">
          还没有任何设备运行时段，无法生成时间线。请先到「设备与时段」页录入设备及其运行时段。
        </div>
      </div>
    );
  }

  const overloaded = circuits.filter((c) => c.overloads.length > 0);

  return (
    <div>
      <div className="section-head">
        <h2>负载时间线</h2>
        <span className="muted">
          全局范围 {mdhm(range.start)} – {mdhm(range.end)}
        </span>
      </div>

      {overloaded.length > 0 && (
        <div className="card over-summary">
          <div className="over-title">⚠ 当前有 {overloaded.length} 个回路存在超限区间：</div>
          {overloaded.map((c) => (
            <div key={c.id} className="over-line">
              <strong>{c.name}</strong>
              <span className="muted">（额定 {kW(c.rated_power)} kW，峰值 {kW(c.peak)} kW）</span>
              {c.overloads.map((o, i) => (
                <span key={i} className="chip-danger">
                  {mdhm(o.start)} – {mdhm(o.end)}　峰值 {kW(o.peak)} kW
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="timeline-scroll">
        <div className="timeline" style={{ width: LABEL_W + PLOT_W + 8 }}>
          <div className="tl-col-labels" style={{ width: LABEL_W }}>
            {model.rows.map(({ c }) => (
              <div key={c.id} className="tl-label" style={{ height: ROW_H }}>
                <div className="tl-label-name" title={c.name}>
                  <span className={c.kind === 'box' ? 'icon-box' : 'icon-cct'}>{c.kind === 'box' ? '▦' : '●'}</span>
                  {c.name}
                </div>
                <div className={c.overloads.length ? 'tl-sub danger-text' : 'tl-sub muted'}>
                  额定 {kW(c.rated_power)} / 峰值 {kW(c.peak)} kW
                </div>
              </div>
            ))}
          </div>
          <div className="tl-col-plot" style={{ width: PLOT_W + 8 }}>
            <svg width={PLOT_W + 8} height={model.totalH + 26} className="tl-svg">
              {/* 行底纹与分隔线 */}
              {model.rows.map(({ c }, i) => (
                <g key={c.id}>
                  <rect x={LABEL_W} y={i * ROW_H} width={PLOT_W} height={ROW_H - 1} fill={i % 2 ? '#f7f8fb' : '#ffffff'} />
                  <line x1={LABEL_W} y1={i * ROW_H} x2={LABEL_W + PLOT_W} y2={i * ROW_H} stroke="#e5e8ef" />
                </g>
              ))}
              {/* 时间刻度 */}
              {model.ticks.map((t) => (
                <g key={t.key}>
                  <line x1={t.x} y1={0} x2={t.x} y2={model.totalH} stroke="#eef1f6" />
                  <text x={t.x} y={model.totalH + 18} textAnchor="middle" className="axis-text">{t.label}</text>
                </g>
              ))}
              {/* 每行曲线 */}
              {model.rows.map(({ c, path, yRated, overRects, areaPath }, i) => {
                const top = i * ROW_H;
                return (
                  <g key={c.id} transform={`translate(0, ${top})`}>
                    <path d={areaPath} fill="rgba(37,99,235,0.10)" />
                    {/* 额定功率虚线 */}
                    <line x1={LABEL_W} y1={yRated} x2={LABEL_W + PLOT_W} y2={yRated} stroke="#e11d48" strokeWidth={1.2} strokeDasharray="6 4" />
                    <text x={LABEL_W + PLOT_W - 4} y={yRated - 4} textAnchor="end" className="rated-text">
                      额定 {kW(c.rated_power)} kW
                    </text>
                    {/* 超限红区 */}
                    {overRects.map((r, j) => (
                      <g key={j}>
                        <rect x={r.x} y={r.y} width={r.width} height={Math.max(r.height, 0)} fill="rgba(225,29,72,0.22)" />
                        <title>{`${mdhm(r.start)} – ${mdhm(r.end)}，负载 ${kW(r.load)} kW > 额定 ${kW(c.rated_power)} kW`}</title>
                      </g>
                    ))}
                    <path d={path} fill="none" stroke={overRects.length ? '#1d4ed8' : '#2563eb'} strokeWidth={1.8} />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      </div>
      <p className="muted small">
        蓝线为回路随时间的总负载（已沿配电树汇总全部后代设备；同一设备的重叠时段只计一次），红色虚线为额定功率，
        红底区间即为超限区间。悬停红区可查看具体负载值。
      </p>
    </div>
  );
}

function buildArea(segs, x, y, plotH, padT) {
  if (!segs.length) return '';
  const base = padT + plotH;
  let d = `M ${x(segs[0].start)} ${base}`;
  for (const s of segs) {
    d += ` L ${x(s.start)} ${y(s.load)} L ${x(s.end)} ${y(s.load)}`;
  }
  d += ` L ${x(segs[segs.length - 1].end)} ${base} Z`;
  return d;
}

function mdhmFmt(ms, pad) {
  return `${pad(ms.getUTCMonth() + 1)}-${pad(ms.getUTCDate())} ${pad(ms.getUTCHours())}:${pad(ms.getUTCMinutes())}`;
}
