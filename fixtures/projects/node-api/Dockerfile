FROM node:latest
WORKDIR /app
RUN curl -fsSL https://get.example.com/install.sh | sh
ENV API_TOKEN=d8f7a6s5d4f3g2h1j0k9
COPY . .
RUN npm ci && npm run build
CMD ["node", "dist/server.js"]
