FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app
COPY package.json .
RUN npm install
RUN npx playwright install chromium

COPY server.js .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
