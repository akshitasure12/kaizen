// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentBranchToken} from "../src/AgentBranchToken.sol";

contract AgentBranchTokenTest is Test {
    AgentBranchToken public token;
    address public treasury;
    address public user1;
    address public user2;

    function setUp() public {
        treasury = makeAddr("treasury");
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        token = new AgentBranchToken(treasury);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Constructor Tests
    // ═══════════════════════════════════════════════════════════════════════════

    function test_Constructor() public view {
        assertEq(token.name(), "AgentBranch Token");
        assertEq(token.symbol(), "ABT");
        assertEq(token.decimals(), 18);
        assertEq(token.treasury(), treasury);
        assertEq(token.balanceOf(address(this)), 100_000 * 10**18);
    }

    function test_ConstructorRevertsWithZeroTreasury() public {
        vm.expectRevert("Invalid treasury");
        new AgentBranchToken(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Faucet Tests
    // ═══════════════════════════════════════════════════════════════════════════

    function test_Faucet() public {
        vm.prank(user1);
        token.faucet();

        assertEq(token.balanceOf(user1), 1000 * 10**18);
        assertEq(token.totalFaucetDistributed(), 1000 * 10**18);
    }

    function test_FaucetCooldown() public {
        vm.startPrank(user1);
        
        token.faucet();
        
        vm.expectRevert("Faucet cooldown active");
        token.faucet();

        vm.stopPrank();
    }

    function test_FaucetAfterCooldown() public {
        vm.startPrank(user1);
        
        token.faucet();
        assertEq(token.balanceOf(user1), 1000 * 10**18);

        // Warp forward past cooldown
        vm.warp(block.timestamp + 1 hours + 1);

        token.faucet();
        assertEq(token.balanceOf(user1), 2000 * 10**18);

        vm.stopPrank();
    }

    function test_FaucetStatus() public {
        (bool available, uint256 nextAvailable) = token.faucetStatus(user1);
        assertTrue(available);
        assertEq(nextAvailable, 1 hours); // lastFaucetCall is 0

        vm.prank(user1);
        token.faucet();

        (available, nextAvailable) = token.faucetStatus(user1);
        assertFalse(available);
        assertEq(nextAvailable, block.timestamp + 1 hours);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Agent Deposit Tests
    // ═══════════════════════════════════════════════════════════════════════════

    function test_DepositForAgent() public {
        // Give user1 some tokens
        vm.prank(user1);
        token.faucet();

        uint256 balanceBefore = token.balanceOf(user1);

        vm.prank(user1);
        token.depositForAgent("test-agent.eth");

        assertEq(token.balanceOf(user1), balanceBefore - 50 * 10**18);
        assertEq(token.balanceOf(treasury), 50 * 10**18);
    }

    function test_DepositForAgentInsufficientBalance() public {
        vm.prank(user1);
        vm.expectRevert("Insufficient balance");
        token.depositForAgent("test-agent.eth");
    }

    function test_DepositForAgentEmptyName() public {
        vm.prank(user1);
        token.faucet();

        vm.prank(user1);
        vm.expectRevert("Empty ENS name");
        token.depositForAgent("");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Admin Tests
    // ═══════════════════════════════════════════════════════════════════════════

    function test_SetTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        token.setTreasury(newTreasury);
        assertEq(token.treasury(), newTreasury);
    }

    function test_SetTreasuryNotOwner() public {
        address newTreasury = makeAddr("newTreasury");
        
        vm.prank(user1);
        vm.expectRevert();
        token.setTreasury(newTreasury);
    }

    function test_SetTreasuryZeroAddress() public {
        vm.expectRevert("Invalid treasury");
        token.setTreasury(address(0));
    }

    function test_Mint() public {
        uint256 amount = 500 * 10**18;
        token.mint(user1, amount);
        assertEq(token.balanceOf(user1), amount);
    }

    function test_MintNotOwner() public {
        vm.prank(user1);
        vm.expectRevert();
        token.mint(user1, 100);
    }

    function test_Burn() public {
        uint256 burnAmount = 1000 * 10**18;
        uint256 balanceBefore = token.balanceOf(address(this));

        token.burn(burnAmount);

        assertEq(token.balanceOf(address(this)), balanceBefore - burnAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Integration Tests
    // ═══════════════════════════════════════════════════════════════════════════

    function test_FullAgentRegistrationFlow() public {
        // User gets tokens from faucet
        vm.startPrank(user1);
        token.faucet();
        assertEq(token.balanceOf(user1), 1000 * 10**18);

        // User deposits for agent registration
        token.depositForAgent("my-agent.eth");
        assertEq(token.balanceOf(user1), 950 * 10**18);
        assertEq(token.balanceOf(treasury), 50 * 10**18);

        // User can register more agents
        token.depositForAgent("my-agent-2.eth");
        assertEq(token.balanceOf(user1), 900 * 10**18);
        assertEq(token.balanceOf(treasury), 100 * 10**18);

        vm.stopPrank();
    }

    function test_MultipleUsers() public {
        // User 1 uses faucet
        vm.prank(user1);
        token.faucet();

        // User 2 uses faucet
        vm.prank(user2);
        token.faucet();

        assertEq(token.balanceOf(user1), 1000 * 10**18);
        assertEq(token.balanceOf(user2), 1000 * 10**18);
        assertEq(token.totalFaucetDistributed(), 2000 * 10**18);
    }
}
