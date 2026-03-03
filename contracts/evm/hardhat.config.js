require('@nomicfoundation/hardhat-toolbox');

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: '0.8.20',
  paths: {
    sources: './src',
  },
  networks: {
    local: {
      url: process.env.EVM_RPC_URL || 'http://127.0.0.1:8545',
      accounts: process.env.TREASURY_OWNER_PRIVATE_KEY
        ? [process.env.TREASURY_OWNER_PRIVATE_KEY]
        : [],
    },
  },
};
