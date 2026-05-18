FROM node:20

# Install build tools for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

ENV PORT=10000
ENV NODE_ENV=production

EXPOSE 10000
CMD ["node", "server.js"]
