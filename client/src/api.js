/** 统一的后端请求封装：失败时抛出带 code/message/details 的错误 */
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `请求失败（${res.status}）`);
    err.code = data?.error?.code ?? 'ERROR';
    err.details = data?.error?.details ?? null;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  getState: () => request('GET', '/api/state'),
  getLoad: () => request('GET', '/api/load'),

  createCircuit: (b) => request('POST', '/api/circuits', b),
  updateCircuit: (id, b) => request('PUT', `/api/circuits/${id}`, b),
  deleteCircuit: (id) => request('DELETE', `/api/circuits/${id}`),

  createDevice: (b) => request('POST', '/api/devices', b),
  updateDevice: (id, b) => request('PUT', `/api/devices/${id}`, b),
  deleteDevice: (id) => request('DELETE', `/api/devices/${id}`),

  rehearse: (deviceId, toCircuitId) =>
    request('POST', '/api/rehearsals', { device_id: deviceId, to_circuit_id: toCircuitId }),
  confirmRehearsal: (token) => request('POST', `/api/rehearsals/${token}/confirm`),
  discardRehearsal: (token) => request('DELETE', `/api/rehearsals/${token}`),
};
