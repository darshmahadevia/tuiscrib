FROM oven/bun:1.3.14

WORKDIR /app

# Install from the lockfile before copying source so dependency layers are reusable.
COPY package.json bun.lock ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/service/package.json packages/service/package.json
COPY packages/terminal/package.json packages/terminal/package.json
COPY packages/acceptance/package.json packages/acceptance/package.json
RUN bun install --frozen-lockfile --production

COPY . .

ENV HOST=0.0.0.0
ENV NODE_ENV=production

CMD ["bun", "run", "service:start"]
