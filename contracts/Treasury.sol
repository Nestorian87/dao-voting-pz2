// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITreasury} from "./ITreasury.sol";

/// @notice Holds ETH and lets recipients withdraw funds approved by governance.
contract Treasury is Ownable, Pausable, ReentrancyGuard, ITreasury {
    error InvalidGovernor();
    error GovernorAlreadySet();
    error OnlyGovernor();
    error InvalidPayment();
    error InsufficientFunds();
    error NothingToClaim();
    error PaymentFailed();

    event GovernorSet(address indexed governor);
    event Deposited(address indexed sender, uint256 amount);
    event Allocated(address indexed recipient, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);

    address public governor;
    uint256 public reserved;
    mapping(address => uint256) public claimable;

    constructor(address admin) Ownable(admin) {}

    /// @notice Accepts ETH for future proposals.
    receive() external payable {
        if (msg.value == 0) revert InvalidPayment();
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Links the voting contract once.
    function setGovernor(address newGovernor) external onlyOwner {
        if (governor != address(0)) revert GovernorAlreadySet();
        if (newGovernor.code.length == 0) revert InvalidGovernor();
        governor = newGovernor;
        emit GovernorSet(newGovernor);
    }

    /// @notice Reports the ETH that is not reserved for existing claims.
    function available() public view returns (uint256) {
        return address(this).balance - reserved;
    }

    /// @notice Reserves a payment approved by the voting contract.
    function allocate(address recipient, uint256 amount) external override whenNotPaused {
        if (msg.sender != governor) revert OnlyGovernor();
        if (recipient == address(0) || amount == 0) revert InvalidPayment();
        if (amount > available()) revert InsufficientFunds();
        claimable[recipient] += amount;
        reserved += amount;
        emit Allocated(recipient, amount);
    }

    /// @notice Pays all ETH reserved for the caller.
    function claim() external whenNotPaused nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        reserved -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert PaymentFailed();
        emit Claimed(msg.sender, amount);
    }

    /// @notice Temporarily stops allocations and withdrawals.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Reopens allocations and withdrawals.
    function unpause() external onlyOwner {
        _unpause();
    }
}
