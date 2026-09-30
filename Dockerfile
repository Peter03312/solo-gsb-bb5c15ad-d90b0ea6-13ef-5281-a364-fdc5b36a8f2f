# ---- 构建阶段：编译 React 前端 ----
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- 运行阶段：安装后端依赖并托管前端静态文件 ----
FROM node:20-alpine
WORKDIR /app

# better-sqlite3 在 alpine 下从预编译二进制安装；保留构建工具以兜底编译
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && mkdir -p /data

COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DB_PATH=/data/power.db
ENV SEED_DEMO=1
# 容器内默认中国时区，便于按本地时间录入/展示时段
ENV TZ=Asia/Shanghai

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=4s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["node", "src/index.js"]
