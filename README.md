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
- **停电检修预演**（`POST /api/outages/preview`）：
  1. 可同时为 **多个配电箱或末级回路** 分别填写停电起止时间；
  2. 停电作用于 **所选节点及其全部后代设备**；只统计设备 **原运行时段与停电窗口的
     交集**，沿用左闭右开规则；
  3. 同一设备受祖先节点、子节点或多个重叠窗口影响时 **先合并失供区间**，任一时刻
     该设备功率只计一次，不重复计入；
  4. 结果按时间段给出每个回路的 **原负载 / 剩余供电负载 / 失供负载**
     （剩余 = 原负载 − 失供），并列出受影响设备及其 **累计失供时长**；
     未受影响分支 `lost_load` 恒为 0，即保持原负载；
  5. 预演为 **纯读计算**，不改变配电树、设备接线或运行时段，不触碰配置版本；
  6. 空方案、缺失回路、起止时间缺失/格式错/起点不早于终点一律 400 中文报错，
     不生成结果。
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
5. **停电预演** 页：为多个配电箱 / 末级回路逐行填写停电起止时间（可多行、窗口可重叠），
   点击「预演供电影响」：
   - 顶部回显全部停电窗口与受影响回路数量，未受影响分支保持原负载；
   - 时间线蓝线为原负载、橙区为失供负载、灰区为停电期间仍带的剩余供电负载；
   - 下方表格列出每个受影响设备的失供时段与累计失供时长（祖先/子节点/重叠窗口已合并，
     同一设备不重复计时）；窗口与运行时段无交集时明确提示“没有设备失供”。

## 停电预演 HTTP API 与调用示例

`POST /api/outages/preview`，请求体：

```json
{
  "outages": [
    { "circuit_id": 2, "start": "2026-10-01T20:00", "end": "2026-10-01T21:00" },
    { "circuit_id": 4, "start": "2026-10-01T20:30", "end": "2026-10-01T22:00" }
  ]
}
```

- 时间支持 `YYYY-MM-DDTHH:MM`（或秒精度），左闭右开，起点必须严格早于终点；
- 同一 `circuit_id` 可出现多次（多个停电窗口，重叠/相邻自动合并）；
- 停电作用于节点子树全部设备；结果中的分段时间线与 `GET /api/load` 使用同一套事件点，
  可直接叠加展示。

curl 示例：

```bash
curl -X POST http://localhost:3000/api/outages/preview \
  -H 'Content-Type: application/json' \
  -d '{"outages":[{"circuit_id":2,"start":"2026-10-01T20:00","end":"2026-10-01T21:00"}]}'
```

返回（节选）：

```json
{
  "config_version": 1,
  "range": { "start": "2026-10-01T16:00:00", "end": "2026-10-01T23:00:00" },
  "outage_windows": [
    { "circuit_id": 2, "name": "灯光分箱 LP", "path": "主配电箱 AP / 灯光分箱 LP",
      "start": "2026-10-01T20:00:00", "end": "2026-10-01T21:00:00" }
  ],
  "circuits": [
    { "id": 2, "name": "灯光分箱 LP", "kind": "box", "parent_id": 1, "rated_power": 30000,
      "affected": true, "peak": 13000, "remaining_peak": 13000, "lost_peak": 13000,
      "timeline": [
        { "start": "2026-10-01T19:30:00", "end": "2026-10-01T20:00:00",
          "load": 13000, "remaining_load": 13000, "lost_load": 0 },
        { "start": "2026-10-01T20:00:00", "end": "2026-10-01T21:00:00",
          "load": 13000, "remaining_load": 0, "lost_load": 13000 }
      ] }
  ],
  "affected_circuits": [
    { "circuit_id": 2, "name": "灯光分箱 LP", "path": "主配电箱 AP / 灯光分箱 LP", "lost_peak": 13000 }
  ],
  "affected_devices": [
    { "device_id": 1, "name": "摇头灯 A", "power_w": 5000, "circuit_id": 4,
      "circuit_name": "舞台灯回路 L1", "path": "主配电箱 AP / 灯光分箱 LP / 舞台灯回路 L1",
      "lost_periods": [ { "start": "2026-10-01T20:00:00", "end": "2026-10-01T21:00:00" } ],
      "lost_seconds": 3600, "lost_duration": "1小时" }
  ]
}
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `outage_windows` | 归一化后的停电窗口（同节点多窗口已合并），含节点名与路径 |
| `circuits[].timeline[]` | 分段：`load` 原负载、`remaining_load` 剩余供电负载、`lost_load` 失供负载（瓦） |
| `circuits[].peak / remaining_peak / lost_peak` | 原负载峰值 / 停电期间剩余峰值 / 失供峰值 |
| `circuits[].affected` | 是否存在失供区间；未受影响分支恒为 `false` 且时间线 `lost_load=0` |
| `affected_circuits` | 所有存在失供的回路（含被汇总到的祖先配电箱） |
| `affected_devices[]` | 受影响设备、失供时段（已合并）、`lost_seconds` 与中文 `lost_duration` |

错误响应（HTTP 400，不生成任何结果）：

| code | 触发条件 |
| --- | --- |
| `EMPTY_PLAN` | 缺少 `outages`、不是数组或为空数组 |
| `MISSING_CIRCUIT` | 某行缺少有效 `circuit_id`，或回路不存在（报错指明第几行） |
| `INVALID_TIME` | 起止时间缺失/格式非法（报错指明第几行、起点还是终点） |
| `INVALID_PERIOD` | 起点不早于终点（左闭右开，区间不可为空） |
| `INVALID_JSON` | 请求体不是合法 JSON |

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
| POST | `/api/outages/preview` | 停电检修预演 `{outages:[{circuit_id,start,end}]}`；纯读不改配置 |

## 目录结构

```
├── Dockerfile              # 多阶段构建：Vite 构建 + Node 运行
├── docker-compose.yml      # 一键启动 + 数据卷 + 健康检查
├── server/                 # Express + better-sqlite3
│   └── src/
│       ├── index.js        # 入口/初始化
│       ├── db.js           # 建表、配置版本（预演失效机制）
│       ├── load.js         # 负载/超限区间计算（事件扫描）
│       ├── outage.js       # 停电预演：失供区间合并/交集、分段原负载/剩余/失供
│       ├── validators.js   # 功率/时段校验与重叠合并
│       └── routes/
└── client/                 # React + Vite
    └── src/components/     # 配电树 / 设备时段 / 负载时间线 / 改接预演 / 停电预演
```
