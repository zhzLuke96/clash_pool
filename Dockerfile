FROM metacubex/mihomo:latest AS mihomo-bin

FROM node:22-alpine
COPY --from=mihomo-bin /mihomo /usr/local/bin/mihomo
WORKDIR /app
COPY index.ts .
COPY package.json .
COPY pnpm-lock.yaml .
COPY pnpm-workspace.yaml .
RUN npm install -g pnpm && pnpm install
# 暴露管理端口和代理端口
EXPOSE 3000 52000-53000
ENTRYPOINT ["npx", "tsx", "index.ts"]