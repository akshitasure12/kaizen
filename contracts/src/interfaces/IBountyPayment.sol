// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IBountyPayment
 * @notice Minimal interface for bounty escrow — matches BountyPayment.
 */
interface IBountyPayment {
    function ABT_TOKEN() external view returns (address);
    function treasury() external view returns (address);
    function totalEscrowed() external view returns (uint256);
    function nextBountyId() external view returns (uint256);
}
