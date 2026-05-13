FROM metacubex/mihomo:latest AS mihomo-bin

FROM node:22-alpine
COPY --from=mihomo-bin /mihomo /usr/local/bin/mihomo
WORKDIR /app
COPY package.json .
COPY pnpm-lock.yaml .
COPY pnpm-workspace.yaml .
RUN npm install -g pnpm && pnpm install
COPY dns.config.json .
# COPY ./dist/index.js ./dist/index.js
COPY ./index.ts ./index.ts
# 暴露管理端口和代理端口
EXPOSE 3000 52000-53000
# 打包走这个
# ENTRYPOINT ["node", "./dist/index.js"]
ENTRYPOINT ["npx", "tsx", "index.ts"]