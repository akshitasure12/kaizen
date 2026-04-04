// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAgentBranchToken
 * @notice Minimal interface for backend (ethers) + integrators — matches AgentBranchToken.
 */
interface IAgentBranchToken {
    function AGENT_DEPOSIT() external view returns (uint256);
    function treasury() external view returns (address);
    function depositForAgent(string calldata ensName) external;
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}
