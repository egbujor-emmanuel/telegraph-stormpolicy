// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StormPolicy
/// @notice A minimal parametric storm-insurance primitive. Anyone can fund
/// and register a policy (a location, a beneficiary, a payout amount). A
/// single authorized off-chain agent -- our monitor, which cross-corroborates
/// Telegraph's WEATHER_FORECAST and STORM_ALERT intents and applies a
/// confidence-calibrated threshold before ever calling this contract --
/// can trigger the payout for a policy once, and must submit the full
/// evidence trail (both signal hashes, both confidence values, the
/// reasoning) as part of that call, so the decision is independently
/// auditable on-chain rather than merely asserted off-chain.
contract StormPolicy {
    struct Policy {
        address funder;
        address beneficiary;
        string location;
        uint256 payoutAmount;
        bool active;
        bool triggered;
        uint256 createdAt;
    }

    address public immutable agent;
    uint256 public nextPolicyId;
    mapping(uint256 => Policy) public policies;

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed funder,
        address indexed beneficiary,
        string location,
        uint256 payoutAmount
    );
    event PolicyCancelled(uint256 indexed policyId, uint256 refunded);
    event PolicyTriggered(
        uint256 indexed policyId,
        bytes32 forecastSignalHash,
        bytes32 alertSignalHash,
        uint256 forecastConfidenceBps,
        uint256 alertConfidenceBps,
        string reason,
        uint256 payoutAmount
    );

    modifier onlyAgent() {
        require(msg.sender == agent, "only agent");
        _;
    }

    constructor(address _agent) {
        require(_agent != address(0), "agent required");
        agent = _agent;
    }

    /// @notice Fund and register a new parametric storm policy. The
    /// attached value becomes the bounded payout.
    function createPolicy(address beneficiary, string calldata location)
        external
        payable
        returns (uint256 policyId)
    {
        require(msg.value > 0, "must fund payout");
        require(beneficiary != address(0), "beneficiary required");
        require(bytes(location).length > 0, "location required");

        policyId = nextPolicyId++;
        policies[policyId] = Policy({
            funder: msg.sender,
            beneficiary: beneficiary,
            location: location,
            payoutAmount: msg.value,
            active: true,
            triggered: false,
            createdAt: block.timestamp
        });

        emit PolicyCreated(policyId, msg.sender, beneficiary, location, msg.value);
    }

    /// @notice The funder can reclaim funds from a policy that never triggered.
    function cancelPolicy(uint256 policyId) external {
        Policy storage p = policies[policyId];
        require(p.active, "not active");
        require(msg.sender == p.funder, "only funder");

        p.active = false;
        uint256 amount = p.payoutAmount;
        p.payoutAmount = 0;

        (bool ok, ) = p.funder.call{value: amount}("");
        require(ok, "refund failed");

        emit PolicyCancelled(policyId, amount);
    }

    /// @notice Release a policy's payout. Callable only by the authorized
    /// agent, only once per policy, and only with the evidence that
    /// justified the decision attached.
    function triggerPayout(
        uint256 policyId,
        bytes32 forecastSignalHash,
        bytes32 alertSignalHash,
        uint256 forecastConfidenceBps,
        uint256 alertConfidenceBps,
        string calldata reason
    ) external onlyAgent {
        Policy storage p = policies[policyId];
        require(p.active, "not active");
        require(!p.triggered, "already triggered");

        p.active = false;
        p.triggered = true;
        uint256 amount = p.payoutAmount;

        (bool ok, ) = p.beneficiary.call{value: amount}("");
        require(ok, "payout failed");

        emit PolicyTriggered(
            policyId,
            forecastSignalHash,
            alertSignalHash,
            forecastConfidenceBps,
            alertConfidenceBps,
            reason,
            amount
        );
    }

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }
}
