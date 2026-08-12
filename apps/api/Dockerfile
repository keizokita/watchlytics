# Um estágio só: instala tudo, compila o contract, poda os devDeps.
# Duas etapas economizariam ~40MB de imagem — não vale o Dockerfile mais longo.
FROM node:24-alpine

WORKDIR /app

# Só os manifests primeiro: camada de dependências não invalida a cada commit.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY apps/api/package.json apps/api/
RUN npm ci --include-workspace-root \
      -w @watchlytics/contract -w @watchlytics/api

COPY packages/contract packages/contract
COPY apps/api apps/api
COPY seed seed

RUN npm run build -w @watchlytics/contract && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

# Node 24 executa .ts nativamente — nenhum build step para a api.
CMD ["node", "apps/api/src/server.ts"]
