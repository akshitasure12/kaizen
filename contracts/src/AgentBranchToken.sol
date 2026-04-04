// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AgentBranchToken (ABT)
 * @notice ERC-20 token for the AgentBranch platform
 * @dev Includes a testnet faucet function for easy testing
 * 
 * Features:
 * - Standard ERC-20 functionality
 * - Testnet faucet (mints 1000 ABT per call, with cooldown)
 * - Owner can mint additional tokens if needed
 * - 18 decimals (standard)
 * 
 * Usage:
 * 1. Deploy to Sepolia
 * 2. Users call faucet() to get test tokens
 * 3. Users approve and transfer 50 ABT to treasury for agent registration
 */
contract AgentBranchToken is ERC20, Ownable {
    // ═══════════════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Amount minted per faucet call (1000 ABT)
    uint256 public constant FAUCET_AMOUNT = 1000 * 10**18;

    /// @notice Cooldown between faucet calls per address (1 hour)
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    /// @notice Required deposit for agent registration (50 ABT)
    uint256 public constant AGENT_DEPOSIT = 50 * 10**18;

    // ═══════════════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Treasury address where agent deposits are sent
    address public treasury;

    /// @notice Tracks last faucet call timestamp per address
    mapping(address => uint256) public lastFaucetCall;

    /// @notice Total tokens distributed via faucet
    uint256 public totalFaucetDistributed;

    // ═══════════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════════

    event FaucetUsed(address indexed user, uint256 amount);
    event AgentDeposit(address indexed user, string ensName, uint256 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // ═══════════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _treasury Address to receive agent registration deposits
     */
    constructor(address _treasury) ERC20("AgentBranch Token", "ABT") Ownable(msg.sender) {
        require(_treasury != address(0), "Invalid treasury");
        treasury = _treasury;

        // Mint initial supply to deployer (100,000 ABT for liquidity/testing)
        _mint(msg.sender, 100_000 * 10**18);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Faucet (Testnet Only)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Get free ABT tokens (testnet faucet)
     * @dev Mints FAUCET_AMOUNT to caller, with cooldown
     */
    function faucet() external {
        uint256 lastCall = lastFaucetCall[msg.sender];
        require(
            lastCall == 0 || block.timestamp >= lastCall + FAUCET_COOLDOWN,
            "Faucet cooldown active"
        );

        lastFaucetCall[msg.sender] = block.timestamp;
        totalFaucetDistributed += FAUCET_AMOUNT;

        _mint(msg.sender, FAUCET_AMOUNT);

        emit FaucetUsed(msg.sender, FAUCET_AMOUNT);
    }

    /**
     * @notice Check if faucet is available for an address
     * @param user Address to check
     * @return available Whether faucet can be used
     * @return nextAvailable Timestamp when faucet becomes available
     */
    function faucetStatus(address user) external view returns (bool available, uint256 nextAvailable) {
        uint256 lastCall = lastFaucetCall[user];
        nextAvailable = lastCall == 0 ? FAUCET_COOLDOWN : lastCall + FAUCET_COOLDOWN;
        available = lastCall == 0 || block.timestamp >= lastCall + FAUCET_COOLDOWN;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Agent Registration
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit ABT to register an agent
     * @param ensName ENS name of the agent being registered
     * @dev Transfers AGENT_DEPOSIT from caller to treasury
     */
    function depositForAgent(string calldata ensName) external {
        require(bytes(ensName).length > 0, "Empty ENS name");
        require(balanceOf(msg.sender) >= AGENT_DEPOSIT, "Insufficient balance");

        _transfer(msg.sender, treasury, AGENT_DEPOSIT);

        emit AgentDeposit(msg.sender, ensName, AGENT_DEPOSIT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Admin Functions
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Update treasury address
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury");
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @notice Mint additional tokens (owner only)
     * @param to Recipient address
     * @param amount Amount to mint
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from caller's balance
     * @param amount Amount to burn
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
