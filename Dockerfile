FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run ocr:models
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 SERVE_FRONTEND=false OCR_LANG_PATH=/app/tessdata
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/.local/tessdata ./tessdata
USER node
EXPOSE 3001
CMD ["node", "dist/server/index.js"]
