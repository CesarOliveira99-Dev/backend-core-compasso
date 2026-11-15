FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 DATABASE_PATH=/data/compasso.sqlite MEDIA_PATH=/data/media SEED_DEMO=false
EXPOSE 4000
CMD ["node", "dist/main.js"]
