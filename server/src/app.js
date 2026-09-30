import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import HttpError from './httpError.js';
import circuitsRouter from './routes/circuits.js';
import devicesRouter from './routes/devices.js';
import rehearsalsRouter from './routes/rehearsals.js';
import outagesRouter from './routes/outages.js';
import stateRouter from './routes/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json());

  // JSON 解析失败也要返回明确错误，而不是默认 HTML
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是合法的 JSON' } });
    }
    return next(err);
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/circuits', circuitsRouter);
  app.use('/api/devices', devicesRouter);
  app.use('/api/rehearsals', rehearsalsRouter);
  app.use('/api/outages', outagesRouter);
  app.use('/api', stateRouter);

  // 统一业务错误响应：{ error: { code, message, details } }
  // 所有写操作都在 SQLite 事务中完成，抛错时事务回滚，不留部分配置。
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details ?? undefined },
      });
    }
    // SQLite 约束错误（CHECK/外键等）
    if (err && /SQLITE_CONSTRAINT/.test(err.code ?? '')) {
      return res.status(400).json({ error: { code: 'CONSTRAINT', message: err.message } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  // 生产环境：托管前端构建产物
  const staticDir = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  return app;
}
