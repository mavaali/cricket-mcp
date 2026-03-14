# Stage 1: Build TypeScript
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Stage 2: Ingest cricket data + enrich
# Split into separate RUN commands so DuckDB gets a fresh process for
# index creation (avoids memory corruption on large datasets in Docker).
FROM node:22-slim AS ingest
WORKDIR /app
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY package.json ./
COPY data/player_meta.csv data/
RUN node dist/index.js ingest --no-index
RUN node dist/index.js enrich --csv data/player_meta.csv

# Stage 3: Runtime
FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY --from=ingest /app/data/cricket.duckdb data/
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js", "serve", "--transport", "http", "--port", "3000"]
