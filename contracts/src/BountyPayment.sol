// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BountyPayment
 * @notice On-chain escrow for AgentBranch issue bounties
 * @dev Uses ABT (ERC-20) as the payment token. Deployed on Base Sepolia.
 *
 * Flow:
 *   1. Poster calls createBounty() — ABT is transferred into escrow
 *   2. Solvers submit off-chain; judge picks winner off-chain
 *   3. Poster (or owner) calls awardBounty() — ABT released to winner
 *   4. Poster can cancelBounty() before award — refund minus small fee
 *   5. If deadline passes without award, solver can claimBounty()
 *
 * Fee model:
 *   - Cancellation fee: 2% (sent to treasury)
 *   - Award: 0% protocol fee (can be added later)
 */
contract BountyPayment is Ownable, ReentrancyGuard {
    // ═══════════════════════════════════════════════════════════════════════════
    // Types
    // ═══════════════════════════════════════════════════════════════════════════

    enum BountyStatus {
        Active,      // 0 — funds escrowed, accepting submissions
        Awarded,     // 1 — winner paid out
        Cancelled,   // 2 — poster cancelled, refund issued
        Expired      // 3 — deadline passed, claimed by solver or refunded
    }

    struct Bounty {
        address poster;
        uint256 amount;
        uint256 deadline;
        address winner;
        BountyStatus status;
        string issueId;       // off-chain issue UUID
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice The ABT ERC-20 token used for payments
    IERC20 public immutable ABT_TOKEN;

    /// @notice Treasury address for protocol fees
    address public treasury;

    /// @notice Cancellation fee in basis points (200 = 2%)
    uint256 public cancelFeeBps = 200;

    /// @notice Auto-increment bounty ID
    uint256 public nextBountyId = 1;

    /// @notice All bounties by ID
    mapping(uint256 => Bounty) public bounties;

    /// @notice Total ABT currently held in escrow
    uint256 public totalEscrowed;

    // ═══════════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════════

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed poster,
        uint256 amount,
        uint256 deadline,
        string issueId
    );

    event BountyAwarded(
        uint256 indexed bountyId,
        address indexed winner,
        uint256 amount
    );

    event BountyCancelled(
        uint256 indexed bountyId,
        address indexed poster,
        uint256 refundAmount,
        uint256 feeAmount
    );

    event BountyClaimed(
        uint256 indexed bountyId,
        address indexed claimant,
        uint256 amount
    );

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event CancelFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    // ═══════════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _abtToken Address of the ABT ERC-20 token
     * @param _treasury Address to receive protocol fees
     */
    constructor(
        address _abtToken,
        address _treasury
    ) Ownable(msg.sender) {
        require(_abtToken != address(0), "Invalid token");
        require(_treasury != address(0), "Invalid treasury");

        ABT_TOKEN = IERC20(_abtToken);
        treasury = _treasury;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Core Functions
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Create a new bounty with ABT escrow
     * @param amount ABT amount to escrow (must have prior approval)
     * @param deadlineTimestamp Unix timestamp after which bounty expires
     * @param issueId Off-chain issue UUID for reference
     * @return bountyId The ID of the newly created bounty
     */
    function createBounty(
        uint256 amount,
        uint256 deadlineTimestamp,
        string calldata issueId
    ) external nonReentrant returns (uint256 bountyId) {
        require(amount > 0, "Amount must be > 0");
        require(deadlineTimestamp > block.timestamp, "Deadline must be future");
        require(bytes(issueId).length > 0, "Issue ID required");

        // Transfer ABT from poster to this contract
        require(
            ABT_TOKEN.transferFrom(msg.sender, address(this), amount),
            "ABT transfer failed"
        );

        bountyId = nextBountyId++;

        bounties[bountyId] = Bounty({
            poster: msg.sender,
            amount: amount,
            deadline: deadlineTimestamp,
            winner: address(0),
            status: BountyStatus.Active,
            issueId: issueId
        });

        totalEscrowed += amount;

        emit BountyCreated(bountyId, msg.sender, amount, deadlineTimestamp, issueId);
    }

    /**
     * @notice Award bounty to the winning solver
     * @dev Only callable by the poster or contract owner
     * @param bountyId ID of the bounty
     * @param winner Address of the winning solver
     */
    function awardBounty(
        uint256 bountyId,
        address winner
    ) external nonReentrant {
        Bounty storage b = bounties[bountyId];

        require(b.status == BountyStatus.Active, "Bounty not active");
        require(
            msg.sender == b.poster || msg.sender == owner(),
            "Not authorized"
        );
        require(winner != address(0), "Invalid winner");

        b.status = BountyStatus.Awarded;
        b.winner = winner;
        totalEscrowed -= b.amount;

        require(ABT_TOKEN.transfer(winner, b.amount), "ABT transfer failed");

        emit BountyAwarded(bountyId, winner, b.amount);
    }

    /**
     * @notice Cancel a bounty and refund the poster (minus cancellation fee)
     * @dev Only callable by the poster before award/expiry
     * @param bountyId ID of the bounty
     */
    function cancelBounty(uint256 bountyId) external nonReentrant {
        Bounty storage b = bounties[bountyId];

        require(b.status == BountyStatus.Active, "Bounty not active");
        require(msg.sender == b.poster, "Not poster");

        b.status = BountyStatus.Cancelled;
        totalEscrowed -= b.amount;

        uint256 fee = (b.amount * cancelFeeBps) / 10000;
        uint256 refund = b.amount - fee;

        if (fee > 0) {
            require(ABT_TOKEN.transfer(treasury, fee), "Fee transfer failed");
        }
        require(ABT_TOKEN.transfer(b.poster, refund), "Refund transfer failed");

        emit BountyCancelled(bountyId, b.poster, refund, fee);
    }

    /**
     * @notice Claim an expired bounty (refund to poster after deadline)
     * @dev Anyone can call this after the deadline to trigger refund
     * @param bountyId ID of the bounty
     */
    function claimExpired(uint256 bountyId) external nonReentrant {
        Bounty storage b = bounties[bountyId];

        require(b.status == BountyStatus.Active, "Bounty not active");
        require(block.timestamp > b.deadline, "Not expired yet");

        b.status = BountyStatus.Expired;
        totalEscrowed -= b.amount;

        // Full refund on expiry (no fee)
        require(ABT_TOKEN.transfer(b.poster, b.amount), "Refund transfer failed");

        emit BountyClaimed(bountyId, b.poster, b.amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // View Functions
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Get full bounty details
     */
    function getBounty(uint256 bountyId)
        external
        view
        returns (
            address poster,
            uint256 amount,
            uint256 deadline,
            address winner,
            BountyStatus status,
            string memory issueId
        )
    {
        Bounty storage b = bounties[bountyId];
        return (b.poster, b.amount, b.deadline, b.winner, b.status, b.issueId);
    }

    /**
     * @notice Check if a bounty is still active and not expired
     */
    function isBountyActive(uint256 bountyId) external view returns (bool) {
        Bounty storage b = bounties[bountyId];
        return b.status == BountyStatus.Active && block.timestamp <= b.deadline;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Admin Functions
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Update treasury address
     */
    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury");
        address old = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(old, newTreasury);
    }

    /**
     * @notice Update cancellation fee (max 10%)
     */
    function setCancelFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 1000, "Fee too high (max 10%)");
        uint256 old = cancelFeeBps;
        cancelFeeBps = newFeeBps;
        emit CancelFeeUpdated(old, newFeeBps);
    }

    /**
     * @notice Emergency: recover tokens accidentally sent to this contract
     * @dev Cannot withdraw escrowed ABT (only excess)
     */
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        if (token == address(ABT_TOKEN)) {
            uint256 excess = ABT_TOKEN.balanceOf(address(this)) - totalEscrowed;
            require(amount <= excess, "Cannot withdraw escrowed funds");
        }
        require(IERC20(token).transfer(owner(), amount), "Rescue failed");
    }
}
