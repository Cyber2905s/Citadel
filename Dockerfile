FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY migrations ./migrations
COPY src ./src
COPY scripts ./scripts
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
