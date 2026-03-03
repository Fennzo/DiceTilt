FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache wget

COPY contracts/evm/package.json contracts/evm/hardhat.config.js ./
COPY contracts/evm/scripts ./scripts/
COPY contracts/evm/src ./src/

RUN npm install

COPY docker/evm-deploy.sh /evm-deploy.sh
RUN chmod +x /evm-deploy.sh
CMD ["/evm-deploy.sh"]
