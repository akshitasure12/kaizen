// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentBranchToken} from "../src/AgentBranchToken.sol";
import {BountyPayment} from "../src/BountyPayment.sol";

/**
 * @title Deploy Script for AgentBranch Contracts (v7)
 * @notice Deploys ABT + BountyPayment to Base Sepolia
 *
 * Usage:
 *   # Set environment variables
 *   export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
 *   export PRIVATE_KEY=0x...
 *   export TREASURY_ADDRESS=0x...
 *
 *   # From repo root /contracts
 *   forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
 *   forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
 */
contract DeployScript is Script {
    function setUp() public {}

    function run() public {
        // Get configuration from environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envOr("TREASURY_ADDRESS", address(0xdead));

        console.log("=== AgentBranch v7 Deployment (Base Sepolia) ===");
        console.log("Chain ID: 84532 (Base Sepolia)");
        console.log("Treasury:", treasury);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy AgentBranchToken (ABT)
        console.log("1. Deploying AgentBranchToken (ABT)...");
        AgentBranchToken token = new AgentBranchToken(treasury);
        console.log("   ABT deployed to:", address(token));

        // 2. Deploy BountyPayment (escrow contract)
        console.log("2. Deploying BountyPayment...");
        BountyPayment bounty = new BountyPayment(address(token), treasury);
        console.log("   BountyPayment deployed to:", address(bounty));

        vm.stopBroadcast();

        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("");
        console.log("Add these to your .env file:");
        console.log("ABT_CONTRACT_ADDRESS=%s", address(token));
        console.log("BOUNTY_CONTRACT_ADDRESS=%s", address(bounty));
        console.log("NEXT_PUBLIC_ABT_CONTRACT_ADDRESS=%s", address(token));
        console.log("NEXT_PUBLIC_BOUNTY_CONTRACT_ADDRESS=%s", address(bounty));
        console.log("NEXT_PUBLIC_CHAIN_ID=84532");
    }
}
