FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
WORKDIR /opt/inference
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    mkdir -p /state/codex /empty && chown -R node:node /state && \
    ./node_modules/.bin/codex --version | grep -Fx 'codex-cli 0.153.4'
COPY *.mjs ./
ENV PATH=/opt/inference/node_modules/.bin:$PATH
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
