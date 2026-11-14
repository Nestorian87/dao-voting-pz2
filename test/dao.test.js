const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance, stopImpersonatingAccount } = require("@nomicfoundation/hardhat-network-helpers");

const votes = ethers.parseEther;
const payment = votes("0.1");
const duration = 60;
const quorum = votes("10");

async function setup() {
  const [admin, alice, bob, outsider] = await ethers.getSigners();
  const token = await ethers.deployContract("VoteToken", [admin.address]);
  const treasury = await ethers.deployContract("Treasury", [admin.address]);
  const voting = await ethers.deployContract("DaoVoting", [
    admin.address, await token.getAddress(), await treasury.getAddress(), quorum, duration,
  ]);
  await treasury.setGovernor(await voting.getAddress());
  await token.mint(alice.address, votes("7"));
  await token.mint(bob.address, votes("5"));
  await token.connect(alice).delegate(alice.address);
  await token.connect(bob).delegate(bob.address);
  await admin.sendTransaction({ to: await treasury.getAddress(), value: votes("1") });
  return { admin, alice, bob, outsider, token, treasury, voting };
}

async function proposed() {
  const f = await setup();
  await f.voting.connect(f.alice).propose(f.bob.address, payment);
  const { deadline, snapshot } = await f.voting.getProposal(1);
  return { ...f, deadline, snapshot };
}

async function approved() {
  const f = await proposed();
  await f.voting.connect(f.alice).vote(1, true);
  await f.voting.connect(f.bob).vote(1, true);
  await time.increaseTo(f.deadline);
  return f;
}

describe("DAO voting and treasury", function () {
  it("restricts minting to the administrator", async () => {
    const { token, outsider } = await loadFixture(setup);
    await expect(token.connect(outsider).mint(outsider.address, 1))
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
  });
  it("mints voting tokens and records delegation", async () => {
    const { token, bob } = await loadFixture(setup);
    expect(await token.balanceOf(bob.address)).to.equal(votes("5"));
    expect(await token.getVotes(bob.address)).to.equal(votes("5"));
  });
  for (const [label, q, d] of [["zero quorum", 0, duration], ["zero duration", quorum, 0]]) {
    it("rejects " + label, async () => {
      const { admin, token, treasury, voting } = await loadFixture(setup);
      const factory = await ethers.getContractFactory("DaoVoting");
      await expect(factory.deploy(admin.address, await token.getAddress(), await treasury.getAddress(), q, d))
        .to.be.revertedWithCustomError(voting, "InvalidConfiguration");
    });
  }
  it("emits proposal parameters and assigns the first identifier", async () => {
    const { alice, bob, voting } = await loadFixture(setup);
    const block = await ethers.provider.getBlock("latest");
    await expect(voting.connect(alice).propose(bob.address, payment))
      .to.emit(voting, "Proposed").withArgs(1, alice.address, bob.address, payment, block.number, block.timestamp + 1 + duration);
    expect(await voting.proposalCount()).to.equal(1);
    expect(await voting.state(1)).to.equal(0);
  });
  it("rejects a zero recipient", async () => {
    const { voting, alice } = await loadFixture(setup);
    await expect(voting.connect(alice).propose(ethers.ZeroAddress, payment))
      .to.be.revertedWithCustomError(voting, "InvalidPayment");
  });
  it("rejects a zero proposal amount", async () => {
    const { voting, alice } = await loadFixture(setup);
    await expect(voting.connect(alice).propose(alice.address, 0))
      .to.be.revertedWithCustomError(voting, "InvalidPayment");
  });
  it("rejects a proposer without votes", async () => {
    const { voting, outsider } = await loadFixture(setup);
    await expect(voting.connect(outsider).propose(outsider.address, payment))
      .to.be.revertedWithCustomError(voting, "NoVotingPower");
  });
  for (const method of ["getProposal", "state", "execute", "vote"]) {
    it("rejects an unknown proposal in " + method, async () => {
      const { voting } = await loadFixture(setup);
      const args = method === "vote" ? [1, true] : [1];
      await expect(voting[method](...args))
        .to.be.revertedWithCustomError(voting, "UnknownProposal");
    });
  }
  it("emits the weighted affirmative vote", async () => {
    const { voting, alice } = await loadFixture(proposed);
    await expect(voting.connect(alice).vote(1, true)).to.emit(voting, "Voted")
      .withArgs(1, alice.address, true, votes("7"));
    expect(await voting.hasVoted(1, alice.address)).to.equal(true);
    expect((await voting.getProposal(1)).votesFor).to.equal(votes("7"));
  });
  it("counts an opposing vote", async () => {
    const { voting, bob } = await loadFixture(proposed);
    await expect(voting.connect(bob).vote(1, false)).to.emit(voting, "Voted")
      .withArgs(1, bob.address, false, votes("5"));
    expect((await voting.getProposal(1)).votesAgainst).to.equal(votes("5"));
  });
  it("rejects a repeated vote", async () => {
    const { voting, alice } = await loadFixture(proposed);
    await voting.connect(alice).vote(1, true);
    await expect(voting.connect(alice).vote(1, false)).to.be.revertedWithCustomError(voting, "AlreadyVoted");
  });
  it("rejects a voter without voting power at the snapshot", async () => {
    const { voting, outsider } = await loadFixture(proposed);
    await expect(voting.connect(outsider).vote(1, true)).to.be.revertedWithCustomError(voting, "NoVotingPower");
  });
  it("keeps historical voting weights after a transfer", async () => {
    const { voting, token, alice, bob } = await loadFixture(proposed);
    await token.connect(alice).transfer(bob.address, votes("7"));
    expect(await token.getVotes(bob.address)).to.equal(votes("12"));
    await expect(voting.connect(alice).vote(1, true)).to.emit(voting, "Voted").withArgs(1, alice.address, true, votes("7"));
    await expect(voting.connect(bob).vote(1, true)).to.emit(voting, "Voted").withArgs(1, bob.address, true, votes("5"));
  });
  it("allows a vote one second before the deadline", async () => {
    const { voting, alice, deadline } = await loadFixture(proposed);
    await time.setNextBlockTimestamp(deadline - 1n);
    await expect(voting.connect(alice).vote(1, true)).to.emit(voting, "Voted");
  });
  for (const delta of [0n, 1n]) {
    it("rejects a vote at deadline plus " + delta + " seconds", async () => {
      const { voting, alice, deadline } = await loadFixture(proposed);
      await time.setNextBlockTimestamp(deadline + delta);
      await expect(voting.connect(alice).vote(1, true)).to.be.revertedWithCustomError(voting, "VotingClosed");
    });
  }
  it("rejects execution before the deadline", async () => {
    const { voting } = await loadFixture(proposed);
    await expect(voting.execute(1)).to.be.revertedWithCustomError(voting, "NotApproved");
  });
  it("rejects a proposal below quorum", async () => {
    const { voting, alice, deadline } = await loadFixture(proposed);
    await voting.connect(alice).vote(1, true);
    await time.increaseTo(deadline);
    expect(await voting.state(1)).to.equal(1);
    await expect(voting.execute(1)).to.be.revertedWithCustomError(voting, "NotApproved");
  });
  it("rejects when more votes are cast against", async () => {
    const { voting, alice, bob, deadline } = await loadFixture(proposed);
    await voting.connect(alice).vote(1, false);
    await voting.connect(bob).vote(1, true);
    await time.increaseTo(deadline);
    expect(await voting.state(1)).to.equal(1);
  });
  it("accepts an exact quorum and a majority", async () => {
    const { token, voting, alice, bob, outsider } = await loadFixture(setup);
    await token.connect(bob).transfer(outsider.address, votes("2"));
    await voting.connect(alice).propose(bob.address, payment);
    await voting.connect(alice).vote(1, true);
    await voting.connect(bob).vote(1, false);
    await time.increaseTo((await voting.getProposal(1)).deadline);
    expect(await voting.state(1)).to.equal(2);
  });
  it("executes an approved proposal once and reserves the ETH", async () => {
    const { voting, treasury, bob, outsider } = await loadFixture(approved);
    expect(await voting.state(1)).to.equal(2);
    await expect(voting.connect(outsider).execute(1)).to.emit(treasury, "Allocated")
      .withArgs(bob.address, payment).and.to.emit(voting, "Executed").withArgs(1);
    expect(await treasury.reserved()).to.equal(payment);
    expect(await treasury.available()).to.equal(votes("0.9"));
    expect(await voting.state(1)).to.equal(3);
    await expect(voting.execute(1)).to.be.revertedWithCustomError(voting, "NotApproved");
  });
  it("allows only the recipient to withdraw the reserved ETH and only once", async () => {
    const { voting, treasury, bob, outsider } = await loadFixture(approved);
    await voting.execute(1);
    await expect(treasury.connect(outsider).claim()).to.be.revertedWithCustomError(treasury, "NothingToClaim");
    const tx = treasury.connect(bob).claim();
    await expect(tx).to.changeEtherBalances([treasury, bob], [-payment, payment]);
    await expect(tx).to.emit(treasury, "Claimed").withArgs(bob.address, payment);
    expect(await treasury.reserved()).to.equal(0);
    await expect(treasury.connect(bob).claim()).to.be.revertedWithCustomError(treasury, "NothingToClaim");
  });
  it("keeps a proposal approved if the treasury cannot fund it yet", async () => {
    const { voting, treasury, alice, bob, admin } = await loadFixture(setup);
    const largerPayment = votes("2");
    await voting.connect(alice).propose(bob.address, largerPayment);
    await voting.connect(alice).vote(1, true);
    await voting.connect(bob).vote(1, true);
    await time.increaseTo((await voting.getProposal(1)).deadline);
    await expect(voting.execute(1)).to.be.revertedWithCustomError(treasury, "InsufficientFunds");
    expect(await voting.state(1)).to.equal(2);
    await admin.sendTransaction({ to: await treasury.getAddress(), value: votes("1") });
    await voting.execute(1);
    expect(await treasury.claimable(bob.address)).to.equal(largerPayment);
  });
  it("rejects direct allocations by accounts outside the voting contract", async () => {
    const { treasury, admin, outsider } = await loadFixture(setup);
    await expect(treasury.connect(admin).allocate(outsider.address, payment))
      .to.be.revertedWithCustomError(treasury, "OnlyGovernor");
    expect(await treasury.claimable(outsider.address)).to.equal(0);
  });
  it("rejects a noncontract governor and allows linking only once", async () => {
    const { admin, voting } = await loadFixture(setup);
    const treasury = await ethers.deployContract("Treasury", [admin.address]);
    await expect(treasury.setGovernor(admin.address)).to.be.revertedWithCustomError(treasury, "InvalidGovernor");
    await expect(treasury.setGovernor(await voting.getAddress())).to.emit(treasury, "GovernorSet")
      .withArgs(await voting.getAddress());
    await expect(treasury.setGovernor(await voting.getAddress())).to.be.revertedWithCustomError(treasury, "GovernorAlreadySet");
  });
  it("emits deposits and rejects zero ETH deposits", async () => {
    const { admin, treasury } = await loadFixture(setup);
    const to = await treasury.getAddress();
    await expect(admin.sendTransaction({ to, value: 1 })).to.emit(treasury, "Deposited").withArgs(admin.address, 1);
    await expect(admin.sendTransaction({ to, value: 0 })).to.be.revertedWithCustomError(treasury, "InvalidPayment");
  });
  it("pauses voting and resumes it without extending the deadline", async () => {
    const { voting, alice, bob, admin, deadline } = await loadFixture(proposed);
    await expect(voting.connect(alice).pause()).to.be.revertedWithCustomError(voting, "OwnableUnauthorizedAccount");
    await expect(voting.pause()).to.emit(voting, "Paused").withArgs(admin.address);
    await expect(voting.connect(alice).propose(bob.address, payment)).to.be.revertedWithCustomError(voting, "EnforcedPause");
    await expect(voting.connect(alice).vote(1, true)).to.be.revertedWithCustomError(voting, "EnforcedPause");
    await expect(voting.execute(1)).to.be.revertedWithCustomError(voting, "EnforcedPause");
    await expect(voting.unpause()).to.emit(voting, "Unpaused").withArgs(admin.address);
    await voting.connect(alice).vote(1, true);
    expect((await voting.getProposal(1)).deadline).to.equal(deadline);
  });
  it("pauses allocations and claims, and resumes both", async () => {
    const { treasury, voting, bob, admin } = await loadFixture(approved);
    await expect(treasury.connect(bob).pause()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    await expect(treasury.pause()).to.emit(treasury, "Paused").withArgs(admin.address);
    await expect(voting.execute(1)).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    await expect(treasury.unpause()).to.emit(treasury, "Unpaused").withArgs(admin.address);
    await voting.execute(1);
    await treasury.pause();
    await expect(treasury.connect(bob).claim()).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    await treasury.unpause();
    await treasury.connect(bob).claim();
  });
  it("preserves an allocation when the recipient rejects the payment", async () => {
    const { voting, treasury, alice, bob, token } = await loadFixture(setup);
    const recipient = await token.getAddress();
    await voting.connect(alice).propose(recipient, payment);
    await voting.connect(alice).vote(1, true);
    await voting.connect(bob).vote(1, true);
    await time.increaseTo((await voting.getProposal(1)).deadline);
    await voting.execute(1);
    await impersonateAccount(recipient);
    await setBalance(recipient, votes("1"));
    const recipientSigner = await ethers.getSigner(recipient);
    await expect(treasury.connect(recipientSigner).claim()).to.be.revertedWithCustomError(treasury, "PaymentFailed");
    await stopImpersonatingAccount(recipient);
    expect(await treasury.claimable(recipient)).to.equal(payment);
    expect(await treasury.reserved()).to.equal(payment);
  });
});
