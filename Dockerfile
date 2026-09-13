FROM node:22-alpine
WORKDIR /app

# deps first (cached while package files unchanged); electron/builder are devDeps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# runtime code + web assets only — express.static serves core/, renderer/, web/
# (incl. renderer/vendor via /vendor); tests/docs/notes/dist stay out
COPY server ./server
COPY core ./core
COPY web ./web
COPY renderer ./renderer

ENV DATA_DIR=/data PORT=4321 NODE_ENV=production
VOLUME /data
EXPOSE 4321

# alpine has no curl — one-liner node fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||4321) +'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
