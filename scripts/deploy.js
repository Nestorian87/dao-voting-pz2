const fs = require("node:fs");
const path = require("node:path");
const { ethers, network, run } = require("hardhat");

async function main() {
  const [admin, first, second] = await ethers.getSigners();
  if (!admin) throw new Error("Set DEPLOYER_PRIVATE_KEY for the selected network.");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const local = network.name === "localhost";
  if (chainId !== (local ? 31337 : 11155111)) {
    throw new Error("The RPC returned an unexpected chain ID.");
  }
  const duration = Number(process.env.VOTING_DURATION_SECONDS ?? (local ? 60 : 300));
  const quorum = ethers.parseEther(process.env.QUORUM_VOTES ?? "10");
  const funding = ethers.parseEther(process.env.TREASURY_FUNDING_ETH ?? (local ? "1" : "0.001"));
  const voter1 = ethers.getAddress(local ? first.address : process.env.VOTER_1 || admin.address);
  const voter2 = ethers.getAddress(local ? second.address : process.env.VOTER_2 || "");
  if (voter1 === voter2 || voter1 === ethers.ZeroAddress || voter2 === ethers.ZeroAddress) {
    throw new Error("Set two distinct nonzero voter addresses.");
  }
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration >= 2 ** 48 || quorum <= 0n || funding < 0n) {
    throw new Error("Check duration, quorum, and funding in .env.");
  }

  const tokenArgs = [admin.address];
  const treasuryArgs = [admin.address];
  const token = await ethers.deployContract("VoteToken", tokenArgs);
  await token.waitForDeployment();
  const treasury = await ethers.deployContract("Treasury", treasuryArgs);
  await treasury.waitForDeployment();
  const votingArgs = [admin.address, await token.getAddress(), await treasury.getAddress(), quorum, duration];
  const voting = await ethers.deployContract("DaoVoting", votingArgs);
  await voting.waitForDeployment();
  if (!local) await voting.deploymentTransaction().wait(2);
  await (await treasury.setGovernor(await voting.getAddress())).wait();
  await (await token.mint(voter1, ethers.parseEther("7"), { gasLimit: 400_000 })).wait();
  await (await token.mint(voter2, ethers.parseEther("5"), { gasLimit: 400_000 })).wait();
  if (funding > 0n) {
    await (await admin.sendTransaction({ to: await treasury.getAddress(), value: funding })).wait();
  }

  const config = {
    chainId,
    label: local ? "Hardhat Local" : "Sepolia",
    explorer: local ? null : "https://sepolia.etherscan.io/address/",
    token: await token.getAddress(),
    treasury: await treasury.getAddress(),
    voting: await voting.getAddress(),
    voters: [voter1, voter2],
  };
  const file = path.join(__dirname, "../web/deployment.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log(JSON.stringify(config, null, 2));

  if (!local && process.env.ETHERSCAN_API_KEY) {
    for (const [contract, constructorArguments] of [[token, tokenArgs], [treasury, treasuryArgs], [voting, votingArgs]]) {
      await contract.deploymentTransaction().wait(5);
      try {
        await run("verify:verify", { address: await contract.getAddress(), constructorArguments });
      } catch (error) {
        console.error("Verification failed:", error.message);
        process.exitCode = 1;
      }
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
