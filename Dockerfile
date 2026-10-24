FROM node:22.23.4-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
EXPOSE 4010
CMD ["node", "src/server.mjs"]
