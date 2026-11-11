FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
USER node
EXPOSE 3000
CMD ["npm", "start"]
