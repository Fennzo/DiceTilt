const hre = require('hardhat');

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const Treasury = await hre.ethers.getContractFactory('Treasury');
  const treasury = await Treasury.deploy();
  await treasury.waitForDeployment();
  const addr = await treasury.getAddress();

  // Fund Treasury with 100 ETH from deployer (Hardhat account #0, pre-funded by Anvil).
  // evm-deploy.sh parses stdout via tail -1 for the address, so use stderr for this log.
  const fundTx = await deployer.sendTransaction({
    to: addr,
    value: hre.ethers.parseEther('100'),
  });
  await fundTx.wait();
  console.error('[deploy] Funded Treasury with 100 ETH');

  // Address MUST be the last stdout line — parsed by evm-deploy.sh via tail -1.
  console.log(addr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
