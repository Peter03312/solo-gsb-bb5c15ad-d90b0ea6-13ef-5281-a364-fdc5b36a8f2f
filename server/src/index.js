import { initDb } from './db.js';
import { createApp } from './app.js';
import { seedDemo } from './seed.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? '/data/power.db';
const SEED_DEMO = (process.env.SEED_DEMO ?? '1') !== '0';

initDb(DB_PATH);
if (SEED_DEMO) {
  try {
    if (seedDemo()) console.log('[init] 已写入演示数据（设置 SEED_DEMO=0 可关闭）');
  } catch (e) {
    console.error('[init] 演示数据写入失败：', e.message);
  }
}

const app = createApp();
app.listen(PORT, HOST, () => {
  console.log(`配电负载排演服务已启动: http://${HOST}:${PORT}`);
  console.log(`SQLite 数据文件: ${DB_PATH}`);
});
