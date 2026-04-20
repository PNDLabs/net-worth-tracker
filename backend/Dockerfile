# Stage 1: compile native modules (better-sqlite3 requires python3/make/g++)
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: lean production image
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
EXPOSE 3001
CMD ["node", "src/server.js"]
