# 活动配电负载排演网站

可完全本地部署的活动现场配电负载排演工具：录入 **配电箱 → 末级回路** 的配电树、
各回路额定功率、设备功率、接入回路与运行时段，页面按时间线展示每个回路随时间变化的
负载、峰值与超限区间；设备改接回路必须 **先预演、再确认**。

技术栈：**Node.js 20 + Express**（后端 / 静态托管）、**React 18 + Vite**（前端）、
**SQLite（better-sqlite3）**（单文件数据库），Docker 一键启动。

## 核心规则

- **上级负载汇总全部后代设备**：某回路负载 = 接入该回路及其全部下级回路上、在该时刻
  运行的所有设备功率之和。
- **时段左闭右开 `[start, end)`**，且起点必须严格早于终点。
- **同一设备重叠时段只计一次**：设备时段在保存时自动合并重叠/相邻区间。
- **设备改接先预演再确认**：
  1. 预演在“假设改接后”的配置上重算全部负载；
  2. 沿 **目标回路及其所有祖先** 检查，只要任一回路上 **任一时间段超额**，整次改接被
     拒绝，返回结果中逐一指出 **回路、超额时段、该时段峰值**；
  3. 通过后签发一次性预演令牌；**预演后任何配置变化（回路/设备/时段的增删改或其它
     改接被确认）都会使确认失效**，必须重新预演。
- **非法输入明确报错且不产生部分配置**：环路（把节点挂到自己的子孙下）、缺失回路、
  非正功率、非法时段（空、格式错、起点不早于终点）都会返回中文错误；所有写操作都包在
  SQLite 事务中，失败即回滚。
- 设备只能接入 **末级回路**（无子节点的节点），已挂设备的节点不能再作为配电箱挂下级。

## 一键启动（推荐，Docker Compose）

需要 Docker（含 Compose 插件）。在项目根目录：

```bash
docker compose up -d --build
```

首次启动会自动：构建前端 → 安装后端依赖 → 初始化 SQLite 表结构 →
（可选）写入一套演示数据。

启动后访问：

> **http://localhost:3000**

查看日志 / 停止：

```bash
docker compose logs -f
docker compose down            # 停止（数据保留在命名卷 power-data 中）
```

### 配置（环境变量）

在 docker-compose.yml 中修改，或在根目录创建 `.env`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PUBLISH_PORT` | `3000` | 宿主机发布端口，端口被占用时改为如 `8080`（访问 http://localhost:8080） |
| `SEED_DEMO` | `1` | 首次启动且数据库为空时是否写入演示数据，`0` 为空白库 |
| `DB_PATH` | `/data/power.db` | SQLite 数据文件路径（已挂载到 Docker 卷 `power-data` 持久化） |
| `TZ` | `Asia/Shanghai` | 容器时区 |
| `PORT` | `3000` | 容器内监听端口（一般无需修改） |

例：改用 8080 端口且不写入演示数据：

```bash
PUBLISH_PORT=8080 SEED_DEMO=0 docker compose up -d --build
# 访问 http://localhost:8080
```

## 本地开发（不用 Docker）

需要 Node.js ≥ 20。

```bash
# 1) 后端
cd server
npm install
DB_PATH=./data/power.db npm run dev        # http://localhost:3000

# 2) 前端（新开终端）
cd client
npm install
npm run dev                                # http://localhost:5173 （/api 自动代理到 3000）
```

生产方式本地运行（后端直接托管构建后的前端）：

```bash
cd client && npm install && npm run build
cd ../server && npm install
DB_PATH=./data/power.db npm start          # 打开 http://localhost:3000
```

## 使用说明

1. **配电树** 页：新增根配电箱，再用“+ 下级”建立分箱 / 末级回路，填写每个节点的
   额定功率（kW）。删除节点会级联删除其全部下级与挂接设备。
2. **设备与时段** 页：录入设备功率、选择接入的末级回路、添加一个或多个运行时段；
   重叠/相邻时段会被自动合并。
3. **负载时间线** 页：按时间阶梯展示每个回路的实时汇总负载、峰值；红色虚线为额定功率，
   红底区间为超限区间，顶部汇总每个超限回路的时段与峰值（悬停红区可看具体数值）。
4. **改接预演** 页：选择设备与目标回路 →「① 预演」；
   - 若任一祖先回路会超额，整次改接被拒绝并列出回路 / 时段 / 峰值，配置不变；
   - 通过后列出受影响回路的改接后峰值，点击「② 确认改接」生效；
   - 预演后配置一旦变化，确认按钮自动失效，需要重新预演。

## HTTP API（均返回 JSON）

错误响应统一为：`{ "error": { "code": "...", "message": "中文说明", "details": ... } }`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/state` | 当前完整配置（回路、设备、时段、配置版本） |
| GET | `/api/load` | 各回路分段负载、峰值、超限区间 |
| POST/PUT/DELETE | `/api/circuits[/:id]` | 回路树增改删（改挂父节点做环路校验） |
| POST/PUT/DELETE | `/api/devices[/:id]` | 设备增改删（PUT 不允许直接换回路） |
| POST | `/api/rehearsals` | 预演改接 `{device_id, to_circuit_id}`；超额返回 422 与明细 |
| POST | `/api/rehearsals/:token/confirm` | 确认改接；配置已变返回 410 `STALE` |
| DELETE | `/api/rehearsals/:token` | 放弃预演 |

## 目录结构

```
├── Dockerfile              # 多阶段构建：Vite 构建 + Node 运行
├── docker-compose.yml      # 一键启动 + 数据卷 + 健康检查
├── server/                 # Express + better-sqlite3
│   └── src/
│       ├── index.js        # 入口/初始化
│       ├── db.js           # 建表、配置版本（预演失效机制）
│       ├── load.js         # 负载/超限区间计算（事件扫描）
│       ├── validators.js   # 功率/时段校验与重叠合并
│       └── routes/
└── client/                 # React + Vite
    └── src/components/     # 配电树 / 设备时段 / 负载时间线 / 改接预演
```
