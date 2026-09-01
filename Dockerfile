FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY server ./server
COPY public ./public
COPY build ./build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server/index.mjs"]
