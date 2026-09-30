import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import TreeTab from './components/TreeTab.jsx';
import DevicesTab from './components/DevicesTab.jsx';
import LoadTab from './components/LoadTab.jsx';
import RehearseTab from './components/RehearseTab.jsx';
import OutageTab from './components/OutageTab.jsx';

const TABS = [
  { key: 'load', label: '负载时间线' },
  { key: 'tree', label: '配电树' },
  { key: 'devices', label: '设备与时段' },
  { key: 'rehearse', label: '改接预演' },
  { key: 'outage', label: '停电预演' },
];

export default function App() {
  const [tab, setTab] = useState('load');
  const [state, setState] = useState(null);
  const [load, setLoad] = useState(null);
  const [error, setError] = useState(null);
  // 预演会话：预演通过后由“改接预演”页持有；任何配置变更都会使其失效
  const [rehearsal, setRehearsal] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([api.getState(), api.getLoad()]);
      // 配置版本变化且与预演版本不一致 → 预演失效
      setState(s);
      setLoad(l);
      setRehearsal((prev) => (prev && prev.config_version !== s.version ? null : prev));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const overloadedCount = load ? load.circuits.filter((c) => c.overloads.length > 0).length : 0;

  return (
    <div className="app">
      <header className="topbar">
        <h1>活动配电负载排演</h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? 'tab active' : 'tab'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.key === 'load' && overloadedCount > 0 && (
                <span className="badge-danger" title="当前存在超限回路">{overloadedCount}</span>
              )}
              {t.key === 'rehearse' && rehearsal && !rehearsal.invalid && (
                <span className="badge-ok" title="已有通过的预演，待确认">待确认</span>
              )}
            </button>
          ))}
        </nav>
        <div className="version" title="配置版本：每次修改自增，用于令旧预演失效">
          配置版本 v{state?.version ?? '–'}
        </div>
      </header>

      {error && (
        <div className="banner-error">
          加载失败：{error}
          <button className="link" onClick={refresh}>重试</button>
        </div>
      )}

      <main className="content">
        {!state || !load ? (
          <div className="muted">正在加载…</div>
        ) : (
          <>
            {tab === 'load' && <LoadTab load={load} />}
            {tab === 'tree' && <TreeTab state={state} refresh={refresh} setError={setError} />}
            {tab === 'devices' && <DevicesTab state={state} refresh={refresh} setError={setError} />}
            {tab === 'rehearse' && (
              <RehearseTab
                state={state}
                load={load}
                refresh={refresh}
                setError={setError}
                rehearsal={rehearsal}
                setRehearsal={setRehearsal}
              />
            )}
            {tab === 'outage' && <OutageTab state={state} />}
          </>
        )}
      </main>
      <footer className="footer">
        左闭右开时段 · 上级负载汇总全部运行中的后代设备 · 同一设备重叠时段只计一次
      </footer>
    </div>
  );
}
