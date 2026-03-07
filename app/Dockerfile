FROM node:20-alpine

# better-sqlite3 needs build tools for native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY . .
RUN mkdir -p data

EXPOSE 8080

CMD ["node", "server.js"]
