// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * AgentBond Protocol — AgentBondEscrow.sol
 * Hedera Hello Future Apex Hackathon 2026 — AI & Agents Track
 *
 * Performance bond escrow for AI agent jobs.
 * Agents stake HBAR as a bond when bidding on jobs.
 * Bad actors (agent or client) face economic consequences.
 *
 * Deployed on Hedera Testnet (EVM-compatible, Besu)
 */
contract AgentBondEscrow {

    // ─────────────── State ───────────────

    enum JobStatus {
        Open,       // Job posted, awaiting agent bid
        Assigned,   // Agent bid placed + bond locked
        Delivered,  // Agent submitted deliverable hash
        Completed,  // Client accepted, funds released
        Slashed,    // Client rejected, bond partially slashed
        Expired     // Deadline passed with no delivery
    }

    struct Job {
        address client;
        address agent;
        uint256 jobValue;      // Tinybars locked by client
        uint256 bondAmount;    // Tinybars locked by agent
        uint256 deadline;      // Unix timestamp
        uint256 deliveryTime;  // When agent submitted
        bytes32 deliveryHash;  // SHA256 of deliverable (also on HCS)
        JobStatus status;
        string  hcsTopicId;    // Hedera topic ID for this job's evidence chain
    }

    mapping(bytes32 => Job) public jobs;
    mapping(address => bytes32[]) public agentJobs;
    mapping(address => uint256) public agentEarnings;
    mapping(address => uint256) public agentSlashes;

    uint256 public bondRateBps = 2000;    // 20% in basis points
    uint256 public timeoutPeriod = 48 hours;
    uint256 public protocolFeeBps = 100;  // 1% in basis points
    address public treasury;

    // ─────────────── Events ───────────────

    event JobCreated(
        bytes32 indexed jobId,
        address indexed client,
        uint256 value,
        string hcsTopicId,
        uint256 deadline
    );
    event BidPlaced(
        bytes32 indexed jobId,
        address indexed agent,
        uint256 bond
    );
    event DeliverySubmitted(
        bytes32 indexed jobId,
        bytes32 deliveryHash,
        uint256 deliveryTime
    );
    event DeliveryAccepted(bytes32 indexed jobId, uint256 agentPayout);
    event BondSlashed(
        bytes32 indexed jobId,
        uint256 slashAmount,
        uint256 clientRefund
    );
    event AutoReleased(bytes32 indexed jobId, uint256 agentPayout);
    event JobExpired(bytes32 indexed jobId, uint256 clientRefund);

    // ─────────────── Constructor ───────────────

    constructor(address _treasury) {
        treasury = _treasury;
    }

    // ─────────────── Job Lifecycle ───────────────

    /**
     * Client posts a job and locks HBAR payment.
     * @param hcsTopicId  The Hedera Consensus Service topic ID for this job's evidence
     * @param durationHours  How long the agent has to deliver
     */
    function createJob(string calldata hcsTopicId, uint256 durationHours)
        external payable returns (bytes32 jobId)
    {
        require(msg.value > 0, "Job value must be positive");
        require(durationHours >= 1, "Minimum 1 hour duration");

        uint256 protocolFee = (msg.value * protocolFeeBps) / 10000;
        uint256 netValue = msg.value - protocolFee;

        jobId = keccak256(
            abi.encodePacked(msg.sender, block.timestamp, hcsTopicId)
        );
        require(jobs[jobId].client == address(0), "Job ID collision");

        jobs[jobId] = Job({
            client:       msg.sender,
            agent:        address(0),
            jobValue:     netValue,
            bondAmount:   0,
            deadline:     block.timestamp + (durationHours * 1 hours),
            deliveryTime: 0,
            deliveryHash: bytes32(0),
            status:       JobStatus.Open,
            hcsTopicId:   hcsTopicId
        });

        // Send protocol fee to treasury
        if (protocolFee > 0) {
            payable(treasury).transfer(protocolFee);
        }

        emit JobCreated(jobId, msg.sender, netValue, hcsTopicId, jobs[jobId].deadline);
    }

    /**
     * Agent places a bid and locks their performance bond.
     * Bond must be at least bondRateBps percent of job value.
     */
    function placeBid(bytes32 jobId) external payable {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Open, "Job not open");
        require(job.client != msg.sender, "Client cannot be agent");
        require(block.timestamp < job.deadline, "Job deadline passed");

        uint256 requiredBond = (job.jobValue * bondRateBps) / 10000;
        require(msg.value >= requiredBond, "Bond too small");

        job.agent      = msg.sender;
        job.bondAmount = msg.value;
        job.status     = JobStatus.Assigned;
        agentJobs[msg.sender].push(jobId);

        emit BidPlaced(jobId, msg.sender, msg.value);
    }

    /**
     * Agent submits a SHA256 hash of the deliverable.
     * The full deliverable is also submitted to HCS for tamper-proof evidence.
     */
    function submitDelivery(bytes32 jobId, bytes32 deliveryHash) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Assigned, "Job not assigned to agent");
        require(job.agent == msg.sender, "Only assigned agent can deliver");
        require(block.timestamp <= job.deadline, "Missed deadline");

        job.deliveryHash = deliveryHash;
        job.deliveryTime = block.timestamp;
        job.status       = JobStatus.Delivered;

        emit DeliverySubmitted(jobId, deliveryHash, block.timestamp);
    }

    /**
     * Client accepts the delivery. Pays agent: job value + bond back.
     */
    function acceptDelivery(bytes32 jobId) external {
        Job storage job = jobs[jobId];
        require(job.client == msg.sender, "Only client can accept");
        require(job.status == JobStatus.Delivered, "Not in delivered state");

        job.status = JobStatus.Completed;
        uint256 agentPayout = job.jobValue + job.bondAmount;
        agentEarnings[job.agent] += job.jobValue;
        payable(job.agent).transfer(agentPayout);

        emit DeliveryAccepted(jobId, agentPayout);
    }

    /**
     * Client rejects delivery with reason logged in HCS.
     * Half of agent's bond goes to client as compensation.
     * Other half returned to agent (agent still lost time).
     */
    function rejectDelivery(bytes32 jobId) external {
        Job storage job = jobs[jobId];
        require(job.client == msg.sender, "Only client can reject");
        require(job.status == JobStatus.Delivered, "Not in delivered state");

        job.status = JobStatus.Slashed;
        uint256 slashAmount   = job.bondAmount / 2;
        uint256 agentRefund   = job.bondAmount - slashAmount;
        uint256 clientRefund  = job.jobValue + slashAmount;

        agentSlashes[job.agent] += slashAmount;
        payable(job.client).transfer(clientRefund);
        payable(job.agent).transfer(agentRefund);

        emit BondSlashed(jobId, slashAmount, clientRefund);
    }

    /**
     * Agent claims auto-release if client has not responded within timeoutPeriod.
     * This prevents client ghosting after delivery.
     */
    function claimTimeout(bytes32 jobId) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Delivered, "Not in delivered state");
        require(job.agent == msg.sender, "Only agent can claim timeout");
        require(
            block.timestamp >= job.deliveryTime + timeoutPeriod,
            "Timeout period not elapsed"
        );

        job.status = JobStatus.Completed;
        uint256 agentPayout = job.jobValue + job.bondAmount;
        agentEarnings[job.agent] += job.jobValue;
        payable(job.agent).transfer(agentPayout);

        emit AutoReleased(jobId, agentPayout);
    }

    /**
     * Client reclaims their locked HBAR if agent never delivered before deadline.
     */
    function claimExpiry(bytes32 jobId) external {
        Job storage job = jobs[jobId];
        require(job.client == msg.sender, "Only client can claim expiry");
        require(
            job.status == JobStatus.Assigned || job.status == JobStatus.Open,
            "Not claimable"
        );
        require(block.timestamp > job.deadline, "Deadline not passed");

        uint256 clientRefund = job.jobValue + job.bondAmount;
        job.status = JobStatus.Expired;
        payable(job.client).transfer(clientRefund);

        emit JobExpired(jobId, clientRefund);
    }

    // ─────────────── Views ───────────────

    function getJob(bytes32 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function getAgentJobs(address agent) external view returns (bytes32[] memory) {
        return agentJobs[agent];
    }

    function getAgentStats(address agent) external view returns (
        uint256 totalEarned,
        uint256 totalSlashed,
        uint256 activeJobs
    ) {
        totalEarned  = agentEarnings[agent];
        totalSlashed = agentSlashes[agent];
        activeJobs   = agentJobs[agent].length;
    }

    function getRequiredBond(bytes32 jobId) external view returns (uint256) {
        return (jobs[jobId].jobValue * bondRateBps) / 10000;
    }
}
