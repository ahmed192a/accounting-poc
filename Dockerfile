# Zero-dependency app: no npm install step, only the source is copied.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# Optional persistent database location. Mount a volume at /data and set DB_PATH=/data/accounting.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "src/server.js"]
