# -----------------------------------------------------------------------------
# Dockerfile for the Express backend.
# ONE image is built and then started three times (app1, app2, app3) by
# docker-compose.yml. Only the SERVER_NAME environment variable differs.
# -----------------------------------------------------------------------------

# Small official Node.js image (Alpine Linux keeps it light).
FROM node:24-alpine

# All following commands run inside this folder in the container.
WORKDIR /app

# Copy ONLY the dependency files first, then install.
# Why? Docker caches each step. If you later edit server.js but not
# package.json, Docker reuses the cached "npm install" layer and the rebuild
# takes seconds instead of re-downloading Express.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Now copy the application code.
COPY server.js ./

# Documentation only: tells readers the app listens on 4000 inside the
# container. (Publishing the port to your laptop happens in docker-compose.yml.)
EXPOSE 4000

# Run node directly (not "npm start") so Node receives stop signals from
# Docker directly and shuts down quickly.
CMD ["node", "server.js"]
