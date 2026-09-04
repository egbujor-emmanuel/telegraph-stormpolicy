// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StormPolicyBonded
/// @notice StormPolicy with an optimistic bonded assertion in front of the
/// payout, instead of the agent triggering it directly. Design follows the
/// pattern proven by UMA's Optimistic Oracle (bonded assertion + liveness
/// window, "assume correct unless challenged") and Reality.eth (a matching
/// bond disputes an answer), scoped down for a hackathon timeframe:
///
///  1. The agent posts a bond and asserts a policy should trigger, with the
///     full evidence trail attached (both signal hashes, both confidence
///     values, the reasoning) -- same evidence shape as the base contract.
///  2. During the liveness window that follows, anyone can dispute the
///     assertion by matching the agent's bond.
///  3. If nobody disputes before the window closes, anyone can finalize:
///     the payout releases and the agent's bond returns. This is the
///     "optimistic" path and is expected to be the common case.
///  4. If it is disputed, a designated arbiter decides who was right.
///     The loser's bond is paid to the winner -- this is the slashing.
///
/// What this deliberately does NOT do, compared to the systems above:
///   - UMA escalates unresolved disputes to the DVM, a decentralized
///     commit-reveal vote across its token holders. Reality.eth lets bonds
///     re-escalate across multiple rounds before falling back to an
///     arbitrator. Building either a working token-voting system or a
///     multi-round escalation ladder in the time available for this
///     hackathon would have meant shipping it untested. This contract goes
///     straight from "disputed" to a single trusted arbiter address, which
///     is a real centralization point -- the same shortcut production
///     parametric insurers (e.g. Arbol, Etherisc) document taking today: a
///     trusted party as the fallback for oracle disagreement, rather than
///     shipping a from-scratch decentralized court. The difference here is
///     that the fallback is wired through a real bond/slash economic
///     mechanism instead of an ungated admin pause button.
///   - There is no multi-round bond escalation. A dispute is one matched
///     bond, then arbitration -- not Reality.eth's ladder.
///
/// Two things it does handle: the bond scales with the payout at stake
/// rather than being flat (`requiredBond`), and a dispute the arbiter never
/// answers can be unwound by anyone after a timeout (`resolveStale`), which
/// returns both bonds rather than freezing them behind a silent arbiter.
contract StormPolicyBonded {
    struct Policy {
        address funder;
        address beneficiary;
        string location;
        uint256 payoutAmount;
        bool active;
        bool triggered;
        uint256 createdAt;
    }

    enum AssertionState {
        None,
        Pending,
        Disputed,
        Resolved
    }

    struct Assertion {
        AssertionState state;
        uint256 bondAmount;
        uint256 disputeBond;
        address disputer;
        uint256 livenessEnds;
        uint256 disputedAt;
        bytes32 forecastSignalHash;
        bytes32 alertSignalHash;
        uint256 forecastConfidenceBps;
        uint256 alertConfidenceBps;
        string reason;
    }

    address public immutable agent;
    address public arbiter;
    /// Bond floor, so a dust-sized policy still costs something to assert.
    uint256 public immutable minBond;
    /// Bond as a share of the payout, in basis points. Staking a flat amount
    /// against every policy means the incentive to be careful shrinks as the
    /// payout grows; scaling it keeps the agent's exposure proportional to
    /// the money its claim moves.
    uint256 public immutable bondBps;
    uint256 public immutable livenessPeriod;
    /// How long a dispute may sit unresolved before anyone can unwind it.
    /// Without this, an arbiter that simply never answers freezes both bonds
    /// and the policy indefinitely.
    uint256 public immutable arbiterTimeout;

    uint256 public nextPolicyId;
    mapping(uint256 => Policy) public policies;
    mapping(uint256 => Assertion) public assertions;

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed funder,
        address indexed beneficiary,
        string location,
        uint256 payoutAmount
    );
    event PolicyCancelled(uint256 indexed policyId, uint256 refunded);
    event TriggerAsserted(
        uint256 indexed policyId,
        bytes32 forecastSignalHash,
        bytes32 alertSignalHash,
        uint256 forecastConfidenceBps,
        uint256 alertConfidenceBps,
        string reason,
        uint256 bondAmount,
        uint256 livenessEnds
    );
    event TriggerDisputed(uint256 indexed policyId, address indexed disputer, uint256 disputeBond);
    event PolicyTriggered(
        uint256 indexed policyId,
        bytes32 forecastSignalHash,
        bytes32 alertSignalHash,
        uint256 forecastConfidenceBps,
        uint256 alertConfidenceBps,
        string reason,
        uint256 payoutAmount
    );
    event DisputeResolved(uint256 indexed policyId, bool agentWasCorrect, address winner, uint256 slashedAmount);
    event DisputeUnwound(uint256 indexed policyId, address disputer, uint256 refundedEach);
    event ArbiterUpdated(address indexed newArbiter);

    modifier onlyAgent() {
        require(msg.sender == agent, "only agent");
        _;
    }

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "only arbiter");
        _;
    }

    constructor(
        address _agent,
        address _arbiter,
        uint256 _minBond,
        uint256 _bondBps,
        uint256 _livenessPeriod,
        uint256 _arbiterTimeout
    ) {
        require(_agent != address(0), "agent required");
        require(_arbiter != address(0), "arbiter required");
        require(_livenessPeriod > 0, "liveness required");
        require(_arbiterTimeout > _livenessPeriod, "timeout must exceed liveness");
        require(_bondBps <= 10000, "bondBps too high");
        agent = _agent;
        arbiter = _arbiter;
        minBond = _minBond;
        bondBps = _bondBps;
        livenessPeriod = _livenessPeriod;
        arbiterTimeout = _arbiterTimeout;
    }

    /// @notice The bond this policy requires to assert against: a share of
    /// what the claim would pay out, never below the floor.
    function requiredBond(uint256 policyId) public view returns (uint256) {
        uint256 scaled = (policies[policyId].payoutAmount * bondBps) / 10000;
        return scaled < minBond ? minBond : scaled;
    }

    /// @notice Fund and register a new parametric storm policy.
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

    /// @notice The funder can reclaim funds from a policy with no live or
    /// past assertion against it.
    function cancelPolicy(uint256 policyId) external {
        Policy storage p = policies[policyId];
        require(p.active, "not active");
        require(msg.sender == p.funder, "only funder");
        require(assertions[policyId].state == AssertionState.None, "assertion exists");

        p.active = false;
        uint256 amount = p.payoutAmount;
        p.payoutAmount = 0;

        (bool ok, ) = p.funder.call{value: amount}("");
        require(ok, "refund failed");

        emit PolicyCancelled(policyId, amount);
    }

    /// @notice The agent asserts a policy should trigger, posting a bond and
    /// the evidence trail. Starts the dispute window; does not move payout
    /// funds yet.
    function assertTrigger(
        uint256 policyId,
        bytes32 forecastSignalHash,
        bytes32 alertSignalHash,
        uint256 forecastConfidenceBps,
        uint256 alertConfidenceBps,
        string calldata reason
    ) external payable onlyAgent {
        Policy storage p = policies[policyId];
        require(p.active, "not active");
        require(!p.triggered, "already triggered");
        require(assertions[policyId].state == AssertionState.None, "already asserted");
        require(msg.value == requiredBond(policyId), "wrong bond amount");

        uint256 livenessEnds = block.timestamp + livenessPeriod;
        assertions[policyId] = Assertion({
            state: AssertionState.Pending,
            bondAmount: msg.value,
            disputeBond: 0,
            disputer: address(0),
            livenessEnds: livenessEnds,
            disputedAt: 0,
            forecastSignalHash: forecastSignalHash,
            alertSignalHash: alertSignalHash,
            forecastConfidenceBps: forecastConfidenceBps,
            alertConfidenceBps: alertConfidenceBps,
            reason: reason
        });

        emit TriggerAsserted(
            policyId,
            forecastSignalHash,
            alertSignalHash,
            forecastConfidenceBps,
            alertConfidenceBps,
            reason,
            msg.value,
            livenessEnds
        );
    }

    /// @notice Dispute a pending assertion by matching the agent's bond,
    /// before the liveness window closes. Freezes it for the arbiter.
    function dispute(uint256 policyId) external payable {
        require(msg.sender != agent, "agent cannot dispute itself");
        Assertion storage a = assertions[policyId];
        require(a.state == AssertionState.Pending, "not disputable");
        require(block.timestamp < a.livenessEnds, "liveness expired");
        require(msg.value == a.bondAmount, "must match bond");

        a.state = AssertionState.Disputed;
        a.disputer = msg.sender;
        a.disputeBond = msg.value;
        a.disputedAt = block.timestamp;

        emit TriggerDisputed(policyId, msg.sender, msg.value);
    }

    /// @notice Anyone can finalize an assertion once its liveness window has
    /// closed undisputed -- the "assume correct unless challenged" path.
    /// Releases the payout and returns the agent's bond.
    function finalize(uint256 policyId) external {
        Assertion storage a = assertions[policyId];
        require(a.state == AssertionState.Pending, "not finalizable");
        require(block.timestamp >= a.livenessEnds, "liveness not expired");

        Policy storage p = policies[policyId];
        p.active = false;
        p.triggered = true;
        uint256 payout = p.payoutAmount;
        uint256 bond = a.bondAmount;
        a.state = AssertionState.Resolved;

        emit PolicyTriggered(
            policyId,
            a.forecastSignalHash,
            a.alertSignalHash,
            a.forecastConfidenceBps,
            a.alertConfidenceBps,
            a.reason,
            payout
        );

        (bool ok1, ) = p.beneficiary.call{value: payout}("");
        require(ok1, "payout failed");
        (bool ok2, ) = agent.call{value: bond}("");
        require(ok2, "bond return failed");
    }

    /// @notice The arbiter decides a disputed assertion. The loser's bond
    /// is paid to the winner -- this is the slashing. If the agent was
    /// right, the payout also releases now; if wrong, the policy stays
    /// active and untriggered, free to be asserted again later.
    function resolveDispute(uint256 policyId, bool agentWasCorrect) external onlyArbiter {
        Assertion storage a = assertions[policyId];
        require(a.state == AssertionState.Disputed, "not disputed");

        a.state = AssertionState.Resolved;
        uint256 totalBonds = a.bondAmount + a.disputeBond;

        if (agentWasCorrect) {
            Policy storage p = policies[policyId];
            p.active = false;
            p.triggered = true;
            uint256 payout = p.payoutAmount;

            emit PolicyTriggered(
                policyId,
                a.forecastSignalHash,
                a.alertSignalHash,
                a.forecastConfidenceBps,
                a.alertConfidenceBps,
                a.reason,
                payout
            );
            emit DisputeResolved(policyId, true, agent, a.disputeBond);

            (bool ok1, ) = p.beneficiary.call{value: payout}("");
            require(ok1, "payout failed");
            (bool ok2, ) = agent.call{value: totalBonds}("");
            require(ok2, "bond payout failed");
        } else {
            address disputer = a.disputer;
            emit DisputeResolved(policyId, false, disputer, a.bondAmount);

            // A policy the agent asserted wrongly is not spent -- the storm it
            // was wrong about may still arrive later. Clearing the assertion
            // returns the policy to an assertable state so cover continues,
            // rather than leaving it funded but permanently unusable.
            delete assertions[policyId];

            (bool ok, ) = disputer.call{value: totalBonds}("");
            require(ok, "slash payout failed");
        }
    }

    /// @notice Unwind a dispute the arbiter never answered. Callable by
    /// anyone once the timeout has passed, so neither side's bond can be
    /// held hostage by an arbiter that goes silent. Both bonds are returned
    /// and the assertion clears: nobody is punished for someone else's
    /// inaction, and the policy is assertable again.
    function resolveStale(uint256 policyId) external {
        Assertion storage a = assertions[policyId];
        require(a.state == AssertionState.Disputed, "not disputed");
        require(block.timestamp >= a.disputedAt + arbiterTimeout, "arbiter still has time");

        address disputer = a.disputer;
        uint256 agentBond = a.bondAmount;
        uint256 disputerBond = a.disputeBond;

        delete assertions[policyId];
        emit DisputeUnwound(policyId, disputer, agentBond);

        (bool ok1, ) = agent.call{value: agentBond}("");
        require(ok1, "agent refund failed");
        (bool ok2, ) = disputer.call{value: disputerBond}("");
        require(ok2, "disputer refund failed");
    }

    /// @notice The arbiter role can be handed off (e.g. to a multisig)
    /// without redeploying.
    function updateArbiter(address newArbiter) external onlyArbiter {
        require(newArbiter != address(0), "arbiter required");
        arbiter = newArbiter;
        emit ArbiterUpdated(newArbiter);
    }

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }

    function getAssertion(uint256 policyId) external view returns (Assertion memory) {
        return assertions[policyId];
    }
}
