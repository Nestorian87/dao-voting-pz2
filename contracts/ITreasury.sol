// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Payment allocation interface used by the voting contract.
interface ITreasury {
    /// @notice Reserves a payment for the specified recipient.
    function allocate(address recipient, uint256 amount) external;
}
