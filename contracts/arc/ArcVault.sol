// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMerchantRegistry {
    function approved(address merchant) external view returns (bool);
}

/// @notice Circle Gateway Wallet (x402 batched nanopayments). depositFor credits `depositor`'s Gateway balance.
interface IGatewayWallet {
    function depositFor(address token, address depositor, uint256 value) external;
}

/// @notice A curated list of merchants (APIs, data sellers, agents) that vault owners may opt into.
contract MerchantRegistry is IMerchantRegistry {
    address public curator;
    mapping(address => bool) public approved;
    error NotCurator();
    error InvalidInput();
    event MerchantSet(address indexed merchant, bool approved, string label);
    event CuratorChanged(address indexed curator);
    constructor(address curator_) { if (curator_ == address(0)) revert InvalidInput(); curator = curator_; }
    function setMerchant(address merchant, bool ok, string calldata label) external {
        if (msg.sender != curator) revert NotCurator();
        if (merchant == address(0)) revert InvalidInput();
        approved[merchant] = ok;
        emit MerchantSet(merchant, ok, label);
    }
    function setCurator(address next) external {
        if (msg.sender != curator) revert NotCurator();
        if (next == address(0)) revert InvalidInput();
        curator = next;
        emit CuratorChanged(next);
    }
}

/// @notice All amounts use the 6-decimal ERC-20 USDC interface; never native gas units.
/// The owner may be any address, including a multisig (e.g. Safe) for key recovery.
contract ArcVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable owner;
    IERC20 public immutable usdc;
    /// Circle Gateway Wallet, or address(0) when Gateway funding is disabled.
    address public immutable gatewayWallet;
    IMerchantRegistry public registry;

    struct Policy {
        uint256 maxTotal;      // lifetime ceiling, includes gas top-ups
        uint256 maxPayment;    // per payment
        uint256 maxPerDay;     // per UTC-day ceiling
        uint256 gasAllowance;  // lifetime USDC the agent may draw for its own gas
        uint64 expiresAt;
        bool useRegistry;      // also allow merchants approved in `registry`
    }
    struct Capability {
        uint256 maxTotal;
        uint256 maxPayment;
        uint256 maxPerDay;
        uint256 gasAllowance;
        uint256 spent;
        uint256 gasSpent;
        uint256 daySpent;
        uint64 day;
        uint64 expiresAt;
        uint64 version;
        bool active;
        bool useRegistry;
    }
    mapping(address => Capability) public capabilities;
    mapping(address => mapping(uint64 => mapping(address => bool))) private recipients;
    mapping(address => mapping(bytes32 => bool)) public usedPaymentIds;
    /// Lifetime USDC an agent may move into its own Circle Gateway balance, and how much it has moved.
    /// Gateway payments are signed off-chain by the agent's EOA (Gateway does not accept ERC-1271), so this
    /// allowance is the most the agent can spend through Gateway; it also counts against maxTotal and maxPerDay.
    mapping(address => uint256) public gatewayAllowance;
    mapping(address => uint256) public gatewayFunded;

    error NotOwner();
    error InvalidInput();
    error Unauthorized();
    error Expired();
    error RecipientDenied();
    error PaymentLimit();
    error TotalLimit();
    error DailyLimit();
    error GasLimit();
    error GatewayLimit();
    error InsufficientFunds();
    error DuplicatePayment();
    error UnsupportedToken();
    error GatewayDisabled();

    event Funded(address indexed sender, uint256 amount);
    event Authorized(address indexed agent, uint64 version, uint256 maxTotal, uint256 maxPayment, uint256 maxPerDay, uint256 gasAllowance, uint64 expiresAt, bool useRegistry, address[] recipients);
    event RecipientSet(address indexed agent, address indexed recipient, bool allowed);
    event RegistrySet(address indexed registry);
    /// paymentId is the agent's invoice hash, e.g. keccak256 of the order or HTTP 402 challenge.
    event Paid(address indexed agent, address indexed recipient, bytes32 indexed paymentId, uint256 amount, uint256 remainingBudget);
    event GasToppedUp(address indexed agent, uint256 amount, uint256 remainingBudget);
    event Revoked(address indexed agent);
    event Withdrawn(address indexed recipient, uint256 amount);
    event GatewayAllowanceSet(address indexed agent, uint256 allowance);
    event GatewayFunded(address indexed agent, uint256 amount, uint256 remainingBudget);

    constructor(address owner_, address token_, address gatewayWallet_) {
        if (owner_ == address(0) || token_ == address(0)) revert InvalidInput();
        if (IERC20Metadata(token_).decimals() != 6) revert UnsupportedToken();
        owner = owner_;
        usdc = IERC20(token_);
        gatewayWallet = gatewayWallet_;
    }
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    function balance() public view returns (uint256) { return usdc.balanceOf(address(this)); }
    function today() public view returns (uint64) { return uint64(block.timestamp / 1 days); }
    function allowed(address agent, address recipient) public view returns (bool) {
        Capability storage c = capabilities[agent];
        if (recipients[agent][c.version][recipient]) return true;
        return c.useRegistry && address(registry) != address(0) && recipient != agent && registry.approved(recipient);
    }
    /// Remaining spend for the current day, accounting for a day rollover.
    function dailyRemaining(address agent) public view returns (uint256) {
        Capability storage c = capabilities[agent];
        uint256 used = c.day == today() ? c.daySpent : 0;
        return c.maxPerDay > used ? c.maxPerDay - used : 0;
    }

    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidInput();
        uint256 beforeBalance = balance();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (balance() - beforeBalance != amount) revert UnsupportedToken();
        emit Funded(msg.sender, amount);
    }

    /// Updates preserve lifetime spend; each update starts a fresh recipient list version.
    function authorize(address agent, Policy calldata p, address[] calldata list) external onlyOwner nonReentrant {
        Capability storage c = capabilities[agent];
        if (agent == address(0) || agent == owner || agent == address(this)) revert InvalidInput();
        if (p.maxTotal == 0 || p.maxTotal < c.spent || p.maxPayment == 0 || p.maxPayment > p.maxTotal) revert InvalidInput();
        if (p.maxPerDay < p.maxPayment || p.gasAllowance > p.maxTotal || p.expiresAt <= block.timestamp) revert InvalidInput();
        if (list.length > 100 || (list.length == 0 && !p.useRegistry)) revert InvalidInput();
        c.version++;
        c.maxTotal = p.maxTotal;
        c.maxPayment = p.maxPayment;
        c.maxPerDay = p.maxPerDay;
        c.gasAllowance = p.gasAllowance;
        c.expiresAt = p.expiresAt;
        c.useRegistry = p.useRegistry;
        c.active = true;
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == address(0) || list[i] == address(this) || list[i] == agent) revert InvalidInput();
            recipients[agent][c.version][list[i]] = true;
        }
        emit Authorized(agent, c.version, p.maxTotal, p.maxPayment, p.maxPerDay, p.gasAllowance, p.expiresAt, p.useRegistry, list);
    }
    function setRecipient(address agent, address recipient, bool ok) external onlyOwner {
        Capability storage c = capabilities[agent];
        if (c.version == 0 || recipient == address(0) || recipient == address(this) || recipient == agent) revert InvalidInput();
        recipients[agent][c.version][recipient] = ok;
        emit RecipientSet(agent, recipient, ok);
    }
    function setRegistry(address next) external onlyOwner {
        registry = IMerchantRegistry(next);
        emit RegistrySet(next);
    }
    /// Sets the lifetime Gateway funding ceiling for an agent. Lowering it below what was funded stops further funding.
    function setGatewayAllowance(address agent, uint256 allowance) external onlyOwner {
        if (gatewayWallet == address(0)) revert GatewayDisabled();
        if (capabilities[agent].version == 0) revert InvalidInput();
        gatewayAllowance[agent] = allowance;
        emit GatewayAllowanceSet(agent, allowance);
    }
    function revoke(address agent) external onlyOwner nonReentrant {
        capabilities[agent].active = false;
        emit Revoked(agent);
    }

    function _spend(Capability storage c, uint256 amount) private {
        if (!c.active) revert Unauthorized();
        if (block.timestamp >= c.expiresAt) revert Expired();
        if (amount > c.maxTotal - c.spent) revert TotalLimit();
        uint64 d = today();
        if (c.day != d) { c.day = d; c.daySpent = 0; }
        if (c.daySpent >= c.maxPerDay || amount > c.maxPerDay - c.daySpent) revert DailyLimit();
        if (amount > balance()) revert InsufficientFunds();
        c.spent += amount;
        c.daySpent += amount;
    }
    function pay(address recipient, uint256 amount, bytes32 paymentId) external nonReentrant {
        Capability storage c = capabilities[msg.sender];
        if (!c.active) revert Unauthorized();
        if (block.timestamp >= c.expiresAt) revert Expired();
        if (!allowed(msg.sender, recipient)) revert RecipientDenied();
        if (amount == 0 || paymentId == bytes32(0)) revert InvalidInput();
        if (usedPaymentIds[msg.sender][paymentId]) revert DuplicatePayment();
        if (amount > c.maxPayment) revert PaymentLimit();
        _spend(c, amount);
        usedPaymentIds[msg.sender][paymentId] = true;
        usdc.safeTransfer(recipient, amount);
        emit Paid(msg.sender, recipient, paymentId, amount, c.maxTotal - c.spent);
    }
    /// Lets the agent fund its own gas (USDC is Arc's gas token) within its gas allowance and budget.
    function topUpGas(uint256 amount) external nonReentrant {
        Capability storage c = capabilities[msg.sender];
        if (amount == 0) revert InvalidInput();
        if (c.gasSpent >= c.gasAllowance || amount > c.gasAllowance - c.gasSpent) revert GasLimit();
        _spend(c, amount);
        c.gasSpent += amount;
        usdc.safeTransfer(msg.sender, amount);
        emit GasToppedUp(msg.sender, amount, c.maxTotal - c.spent);
    }
    /// Moves USDC from the vault into the calling agent's Circle Gateway balance, so it can pay any x402 seller
    /// through Gateway. Bounded by the Gateway allowance, lifetime budget, daily limit, expiry and revocation.
    function fundGateway(uint256 amount) external nonReentrant {
        if (gatewayWallet == address(0)) revert GatewayDisabled();
        Capability storage c = capabilities[msg.sender];
        if (amount == 0) revert InvalidInput();
        uint256 funded = gatewayFunded[msg.sender];
        if (funded >= gatewayAllowance[msg.sender] || amount > gatewayAllowance[msg.sender] - funded) revert GatewayLimit();
        _spend(c, amount);
        gatewayFunded[msg.sender] = funded + amount;
        uint256 beforeBalance = balance();
        usdc.forceApprove(gatewayWallet, amount);
        IGatewayWallet(gatewayWallet).depositFor(address(usdc), msg.sender, amount);
        usdc.forceApprove(gatewayWallet, 0);
        if (beforeBalance - balance() != amount) revert UnsupportedToken();
        emit GatewayFunded(msg.sender, amount, c.maxTotal - c.spent);
    }
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidInput();
        if (amount > balance()) revert InsufficientFunds();
        usdc.safeTransfer(owner, amount);
        emit Withdrawn(owner, amount);
    }
}

contract ArcVaultFactory {
    address public immutable usdc;
    address public immutable gatewayWallet;
    mapping(address => address) public vaultOf;          // latest vault per owner
    mapping(address => address[]) private _vaults;
    event VaultCreated(address indexed owner, address indexed vault);
    /// gateway is Circle's Gateway Wallet on this chain, or address(0) to disable Gateway funding.
    constructor(address token, address gateway) {
        if (IERC20Metadata(token).decimals() != 6) revert ArcVault.UnsupportedToken();
        usdc = token;
        gatewayWallet = gateway;
    }
    /// Owners may create several vaults (e.g. one per team or agent group).
    function createVault() external returns (address vault) {
        vault = address(new ArcVault(msg.sender, usdc, gatewayWallet));
        vaultOf[msg.sender] = vault;
        _vaults[msg.sender].push(vault);
        emit VaultCreated(msg.sender, vault);
    }
    function vaultsOf(address owner) external view returns (address[] memory) { return _vaults[owner]; }
}
