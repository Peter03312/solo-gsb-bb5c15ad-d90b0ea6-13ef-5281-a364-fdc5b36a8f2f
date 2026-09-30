import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { buildTree, kW } from '../utils.js';

function NodeRow({ id, depth, tree, onAddChild, onEdit, onDelete }) {
  const c = tree.byId.get(id);
  const kids = tree.children.get(id) ?? [];
  return (
    <>
      <div className="tree-row" style={{ paddingLeft: 12 + depth * 22 }}>
        <span className={c.kind === 'box' ? 'icon-box' : 'icon-cct'}>
          {c.kind === 'box' ? '▦' : '●'}
        </span>
        <span className="tree-name">{c.name}</span>
        <span className="tag">{c.kind === 'box' ? '配电箱' : '末级回路'}</span>
        <span className="tree-rated">额定 {kW(c.rated_power)} kW</span>
        <span className="row-actions">
          <button className="btn-mini" onClick={() => onAddChild(c)}>+ 下级</button>
          <button className="btn-mini" onClick={() => onEdit(c)}>编辑</button>
          <button className="btn-mini danger" onClick={() => onDelete(c)}>删除</button>
        </span>
      </div>
      {kids.map((kid) => (
        <NodeRow key={kid} id={kid} depth={depth + 1} tree={tree} onAddChild={onAddChild} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </>
  );
}

const emptyForm = { name: '', kind: 'circuit', rated_power: '', parent_id: '' };

export default function TreeTab({ state, refresh, setError }) {
  const tree = useMemo(() => buildTree(state.circuits), [state.circuits]);
  const roots = tree.children.get(0) ?? [];

  // dialog: null | {mode:'create'|'edit', parent?:circuit, circuit?:circuit}
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const openCreate = (parent = null) => {
    setDialog({ mode: 'create', parent });
    setForm({ ...emptyForm, parent_id: parent ? String(parent.id) : '' });
    setErr(null);
  };
  const openEdit = (c) => {
    setDialog({ mode: 'edit', circuit: c });
    setForm({
      name: c.name,
      kind: c.kind,
      rated_power: String(c.rated_power / 1000),
      parent_id: c.parent_id == null ? '' : String(c.parent_id),
    });
    setErr(null);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        name: form.name,
        kind: form.kind,
        rated_power: Math.round(Number(form.rated_power) * 1000),
        parent_id: form.parent_id === '' ? null : Number(form.parent_id),
      };
      if (dialog.mode === 'create') await api.createCircuit(payload);
      else await api.updateCircuit(dialog.circuit.id, payload);
      setDialog(null);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c) => {
    if (!window.confirm(`确定删除「${c.name}」？其全部下级回路、挂接设备及运行时段都会一并删除。`)) return;
    try {
      await api.deleteCircuit(c.id);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  // 编辑时父节点候选项排除自身及其后代（避免环路）
  const forbidden = useMemo(() => {
    if (!dialog || dialog.mode !== 'edit') return new Set();
    const set = new Set([dialog.circuit.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const cc of state.circuits) {
        if (cc.parent_id != null && set.has(cc.parent_id) && !set.has(cc.id)) {
          set.add(cc.id);
          changed = true;
        }
      }
    }
    return set;
  }, [dialog, state.circuits]);

  return (
    <div>
      <div className="section-head">
        <h2>配电树（配电箱 → 末级回路）</h2>
        <button className="btn" onClick={() => openCreate(null)}>+ 新增根配电箱</button>
      </div>

      <div className="card tree">
        {roots.length === 0 && <div className="muted">还没有任何配电箱，点击右上角新增。</div>}
        {roots.map((id) => (
          <NodeRow
            key={id}
            id={id}
            depth={0}
            tree={tree}
            onAddChild={(c) => openCreate(c)}
            onEdit={openEdit}
            onDelete={remove}
          />
        ))}
      </div>

      {dialog && (
        <div className="modal-mask" onClick={() => setDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{dialog.mode === 'create' ? '新增节点' : `编辑「${dialog.circuit.name}」`}</h3>
            <label className="field">
              <span>名称</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：舞台灯回路 L1" />
            </label>
            <label className="field">
              <span>类型</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="box">配电箱（可带下级）</option>
                <option value="circuit">末级回路（接设备）</option>
              </select>
            </label>
            <label className="field">
              <span>额定功率 (kW，须为正数)</span>
              <input type="number" step="0.001" min="0" value={form.rated_power} onChange={(e) => setForm({ ...form, rated_power: e.target.value })} />
            </label>
            <label className="field">
              <span>上级节点（留空为根配电箱）</span>
              <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
                <option value="">（根节点）</option>
                {state.circuits
                  .filter((c) => !forbidden.has(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
              </select>
            </label>
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
