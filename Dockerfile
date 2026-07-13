FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production CI=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

VOLUME ["/app/data"]
EXPOSE 8080

USER node
CMD ["node", "src/index.js"]
