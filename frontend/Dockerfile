# Stage 1: build the React/Vite app
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: serve with nginx + enforce HTTP Basic Auth at runtime
FROM nginx:alpine
RUN apk add --no-cache apache2-utils

# Replace default nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from the build stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy the entrypoint that creates the htpasswd file and starts nginx
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
