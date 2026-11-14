// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ITreasury} from "./ITreasury.sol";

/// @notice Votes on proposed ETH payments using historical voting weights.
contract DaoVoting is Ownable, Pausable {
    enum State {Active, Rejected, Approved, Executed}

    // The first three fields and the vote count with its execution flag share slots.
    struct Proposal {
        address recipient;
        uint48 snapshot;
        uint48 deadline;
        uint256 amount;
        uint208 votesFor;
        bool executed;
        uint208 votesAgainst;
    }

    error InvalidConfiguration();
    error InvalidPayment();
    error NoVotingPower();
    error UnknownProposal();
    error AlreadyVoted();
    error VotingClosed();
    error NotApproved();

    event Proposed(uint256 indexed id, address indexed proposer, address indexed recipient, uint256 amount, uint48 snapshot, uint48 deadline);
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event Executed(uint256 indexed id);

    IVotes public immutable token;
    ITreasury public immutable treasury;
    uint256 public immutable quorum;
    uint48 public immutable duration;
    uint256 public proposalCount;
    mapping(uint256 => Proposal) private proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    constructor(address admin, IVotes voteToken, ITreasury paymentTreasury, uint256 minimumVotes, uint48 votingDuration)
    Ownable(admin)
    {
        if (minimumVotes == 0 || votingDuration == 0) revert InvalidConfiguration();
        token = voteToken;
        treasury = paymentTreasury;
        quorum = minimumVotes;
        duration = votingDuration;
    }

    /// @notice Creates a payment proposal using the last completed block as the snapshot.
    function propose(address recipient, uint256 amount) external whenNotPaused returns (uint256 id) {
        if (recipient == address(0) || amount == 0) revert InvalidPayment();
        uint48 snapshot = uint48(block.number - 1);
        if (token.getPastVotes(msg.sender, snapshot) == 0) revert NoVotingPower();
        uint48 deadline = uint48(block.timestamp) + duration;
        id = ++proposalCount;
        proposals[id] = Proposal(recipient, snapshot, deadline, amount, 0, false, 0);
        emit Proposed(id, msg.sender, recipient, amount, snapshot, deadline);
    }

    /// @notice Casts a single vote with the voting power held at the snapshot.
    function vote(uint256 id, bool support) external whenNotPaused {
        Proposal storage p = _proposal(id);
        if (block.timestamp >= p.deadline) revert VotingClosed();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();
        uint208 weight = uint208(token.getPastVotes(msg.sender, p.snapshot));
        if (weight == 0) revert NoVotingPower();
        hasVoted[id][msg.sender] = true;
        if (support) {
            p.votesFor += weight;
        } else {
            p.votesAgainst += weight;
        }
        emit Voted(id, msg.sender, support, weight);
    }

    /// @notice Reserves payment for a successful proposal. Any account may trigger this.
    function execute(uint256 id) external whenNotPaused {
        Proposal storage p = _proposal(id);
        if (_state(p) != State.Approved) revert NotApproved();
        p.executed = true;
        emit Executed(id);
        treasury.allocate(p.recipient, p.amount);
    }

    /// @notice Reads one proposal by its sequential identifier.
    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _proposal(id);
    }

    /// @notice Reports the current state of a proposal.
    function state(uint256 id) external view returns (State) {
        return _state(_proposal(id));
    }

    /// @notice Temporarily stops proposals, voting, and execution. Deadlines continue to run.
    function pause() external onlyOwner {_pause();}

    /// @notice Reopens proposal creation, voting, and execution.
    function unpause() external onlyOwner {_unpause();}

    function _proposal(uint256 id) private view returns (Proposal storage p) {
        p = proposals[id];
        if (p.recipient == address(0)) revert UnknownProposal();
    }

    function _state(Proposal storage p) private view returns (State) {
        if (p.executed) return State.Executed;
        if (block.timestamp < p.deadline) return State.Active;
        if (uint256(p.votesFor) + p.votesAgainst < quorum || p.votesFor <= p.votesAgainst) {
            return State.Rejected;
        }
        return State.Approved;
    }
}
