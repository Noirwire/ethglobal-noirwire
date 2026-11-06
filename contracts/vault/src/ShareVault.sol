// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title ShareVault
 * @notice Asynchronous epoch vault. Deposits and redemptions are requests priced at the next epoch
 * close, so nobody enters or leaves at a stale price. Epochs close only through a NAV report
 * delivered by the authorised NavReceiver. Access control: Ownable2Step for parameters, a single
 * owner-assigned operator for moving idle USDC to allowlisted treasury destinations.
 * @custom:security-contact security@noirwire.com
 */
contract ShareVault is ERC20, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                             TYPE DECLARATIONS
    //////////////////////////////////////////////////////////////*/

    struct Settlement {
        uint64 settledAt;
        uint192 redeemShares;
        uint256 price;
        uint256 redeemFilledShares;
    }

    struct DepositRequest {
        uint64 epoch;
        uint192 assets;
    }

    struct RedeemRequest {
        uint64 epoch;
        uint192 shares;
    }

    /*//////////////////////////////////////////////////////////////
                             STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    uint256 public constant BPS = 10_000;
    uint256 internal constant PRICE_SCALE = 1e18;
    uint256 internal constant USDC_TO_E18 = 1e12;
    uint256 internal constant ALL_EPOCHS = type(uint256).max;
    /// @dev Price is the USD value of one whole share (1e18 share units) scaled by 1e18:
    /// price = netAssets6 * 1e12 * 1e18 / supply18. The opening price is 1e18, so 1 USDC (1e6 units)
    /// mints 1e6 * 1e12 * 1e18 / 1e18 = 1e18 share units. Both conversions round down.
    uint256 public constant INITIAL_PRICE = 1e18;

    uint32 public constant MIN_REPORT_AGE = 1 minutes;
    uint32 public constant MAX_REPORT_AGE = 1 days;
    uint16 public constant MIN_PRICE_MOVE_BPS = 50;
    uint16 public constant MAX_PRICE_MOVE_BPS = 5_000;
    uint32 public constant MIN_EPOCH_GAP = 1 hours;
    uint32 public constant MAX_EPOCH_GAP = 30 days;
    uint16 public constant MIN_REDEEM_BPS = 100;
    uint32 public constant MAX_LOCKUP = 90 days;
    uint16 public constant MAX_PERFORMANCE_FEE_BPS = 3_000;

    IERC20 public immutable USDC;

    uint64 public currentEpoch = 1;
    uint64 public lastSettledAt;
    uint32 public maxReportAge = 1 hours;
    uint32 public maxEpochGap = 2 days;
    uint32 public lockupPeriod = 1 days;
    uint16 public maxPriceMoveBps = 1_000;
    uint16 public maxRedeemBps = 2_500;
    uint16 public performanceFeeBps = 2_000;
    bool public requestsPaused;
    bool public deviationAcknowledged;

    address public navReceiver;
    address public operator;
    address public feeRecipient;

    uint256 public maxMovePerCall;
    uint256 public maxMovePerEpoch;
    uint256 public lastPrice;
    uint256 public highWaterMark = INITIAL_PRICE;
    uint256 public reservedAssets;
    uint256 public ledgerAssets;

    mapping(address destination => bool allowed) public destinationAllowed;
    mapping(uint64 epoch => uint256 amount) public movedInEpoch;
    mapping(uint64 epoch => uint256 assets) public epochDepositAssets;
    mapping(uint64 epoch => uint256 shares) public epochRedeemShares;
    mapping(uint64 epoch => Settlement settlement) public settlements;

    mapping(address user => DepositRequest request) public depositRequests;
    mapping(address user => RedeemRequest request) public redeemRequests;
    mapping(address user => uint256 shares) public claimableShares;
    mapping(address user => uint256 assets) public claimableAssets;
    mapping(address user => uint256 timestamp) public lockedUntil;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event DepositRequested(uint64 indexed epoch, address indexed payer, address indexed receiver, uint256 assets);
    event DepositCancelled(uint64 indexed epoch, address indexed user, uint256 assets);
    event RedeemRequested(uint64 indexed epoch, address indexed owner, address indexed receiver, uint256 shares);
    event RedeemCancelled(uint64 indexed epoch, address indexed user, uint256 shares);
    event EpochSettled(
        uint64 indexed epoch,
        uint256 price,
        uint256 depositAssets,
        uint256 redeemShares,
        uint256 redeemFilledShares,
        uint256 feeShares
    );
    event DeviationHalt(uint64 indexed epoch, uint256 proposedPrice, uint256 lastPrice);
    event DeviationAcknowledged(uint64 indexed epoch);
    event SharesClaimed(address indexed user, uint256 shares);
    event AssetsClaimed(address indexed user, uint256 assets);
    event MovedToVenue(address indexed to, uint256 amount);
    event ReturnAcknowledged(uint256 amount);
    event SurplusSwept(address indexed to, uint256 amount);
    event DestinationAllowlistUpdated(address indexed destination, bool allowed);
    event ParameterUpdated(bytes32 indexed name, uint256 value);
    event AddressUpdated(bytes32 indexed name, address value);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ShareVault__NotNavReceiver();
    error ShareVault__NotOperator();
    error ShareVault__ZeroAmount();
    error ShareVault__ZeroAddress();
    error ShareVault__RequestsPaused();
    error ShareVault__StaleHalt();
    error ShareVault__WrongCloseId(uint64 expected, uint64 given);
    error ShareVault__ReportTooOld();
    error ShareVault__ReportFromFuture();
    error ShareVault__ReportNotNewer();
    error ShareVault__SharePriceZero();
    error ShareVault__LockupActive(uint256 unlocksAt);
    error ShareVault__EpochClosed();
    error ShareVault__NothingToCancel();
    error ShareVault__InsufficientIdleAssets(uint256 available);
    error ShareVault__DestinationNotAllowed();
    error ShareVault__OverPerCallCap(uint256 cap);
    error ShareVault__OverPerEpochCap(uint256 remaining);
    error ShareVault__NoSurplus();
    error ShareVault__ReturnNotBacked();
    error ShareVault__OutOfBounds();

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyNavReceiver() {
        if (msg.sender != navReceiver) revert ShareVault__NotNavReceiver();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert ShareVault__NotOperator();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                               FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    constructor(IERC20 usdc_, address owner_, address feeRecipient_)
        ERC20("NoirWire Maker Vault Share", "nwMV")
        Ownable(owner_)
    {
        if (address(usdc_) == address(0) || feeRecipient_ == address(0)) {
            revert ShareVault__ZeroAddress();
        }
        USDC = usdc_;
        feeRecipient = feeRecipient_;
        lastSettledAt = uint64(block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                    USER-FACING STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function requestDeposit(uint256 assets, address receiver) external nonReentrant {
        _checkRequest(assets, receiver);
        if (stalled()) revert ShareVault__StaleHalt();

        _syncDeposit(receiver);
        USDC.safeTransferFrom(msg.sender, address(this), assets);
        ledgerAssets += assets;

        uint64 epoch = currentEpoch;
        DepositRequest storage request = depositRequests[receiver];
        request.epoch = epoch;
        request.assets = (uint256(request.assets) + assets).toUint192();
        epochDepositAssets[epoch] += assets;
        emit DepositRequested(epoch, msg.sender, receiver, assets);
    }

    function cancelDeposit() external nonReentrant {
        DepositRequest memory request = depositRequests[msg.sender];
        if (request.assets == 0) revert ShareVault__NothingToCancel();
        if (request.epoch != currentEpoch) revert ShareVault__EpochClosed();

        delete depositRequests[msg.sender];
        epochDepositAssets[request.epoch] -= request.assets;
        ledgerAssets -= request.assets;
        USDC.safeTransfer(msg.sender, request.assets);
        emit DepositCancelled(request.epoch, msg.sender, request.assets);
    }

    function requestRedeem(uint256 shares, address receiver) external nonReentrant {
        _checkRequest(shares, receiver);
        uint256 unlocksAt = lockedUntil[msg.sender];
        if (block.timestamp < unlocksAt) revert ShareVault__LockupActive(unlocksAt);

        _advanceRedeem(receiver, ALL_EPOCHS);
        _transfer(msg.sender, address(this), shares);

        uint64 epoch = currentEpoch;
        RedeemRequest storage request = redeemRequests[receiver];
        request.epoch = epoch;
        request.shares = (uint256(request.shares) + shares).toUint192();
        epochRedeemShares[epoch] += shares;
        emit RedeemRequested(epoch, msg.sender, receiver, shares);
    }

    function cancelRedeem() external nonReentrant {
        _advanceRedeem(msg.sender, ALL_EPOCHS);
        RedeemRequest memory request = redeemRequests[msg.sender];
        if (request.shares == 0) revert ShareVault__NothingToCancel();

        delete redeemRequests[msg.sender];
        epochRedeemShares[request.epoch] -= request.shares;
        _transfer(address(this), msg.sender, request.shares);
        emit RedeemCancelled(request.epoch, msg.sender, request.shares);
    }

    function settleEpoch(uint64 closeId, uint256 totalAssets, uint256 totalLiabilities, uint64 observedAt)
        external
        onlyNavReceiver
    {
        uint64 epoch = currentEpoch;
        if (closeId != epoch) revert ShareVault__WrongCloseId(epoch, closeId);
        if (observedAt > block.timestamp) revert ShareVault__ReportFromFuture();
        if (block.timestamp - observedAt > maxReportAge) revert ShareVault__ReportTooOld();
        if (observedAt <= lastSettledAt) revert ShareVault__ReportNotNewer();

        uint256 supply = totalSupply();
        uint256 netAssets = _floorSub(totalAssets, totalLiabilities);
        (uint256 price, uint256 feeShares) = _priceAfterFee(netAssets, supply);
        if (supply > 0 && price == 0) revert ShareVault__SharePriceZero();

        if (_deviates(price) && !deviationAcknowledged) {
            requestsPaused = true;
            emit DeviationHalt(epoch, price, lastPrice);
            return;
        }
        deviationAcknowledged = false;
        requestsPaused = false;

        if (feeShares > 0) _mint(feeRecipient, feeShares);
        if (price > highWaterMark) highWaterMark = price;
        lastPrice = price;
        lastSettledAt = uint64(block.timestamp);

        uint256 depositAssets = epochDepositAssets[epoch];
        if (depositAssets > 0) _mint(address(this), _sharesFor(depositAssets, price));

        uint256 redeemShares = epochRedeemShares[epoch];
        uint256 filled = _fillRedemptions(redeemShares, price, netAssets);
        if (filled > 0) {
            _burn(address(this), filled);
            reservedAssets += _assetsFor(filled, price);
        }

        settlements[epoch] = Settlement(uint64(block.timestamp), redeemShares.toUint192(), price, filled);
        currentEpoch = epoch + 1;
        epochRedeemShares[epoch + 1] += redeemShares - filled;

        emit EpochSettled(epoch, price, depositAssets, redeemShares, filled, feeShares);
    }

    function acknowledgeDeviation() external onlyOwner {
        deviationAcknowledged = true;
        emit DeviationAcknowledged(currentEpoch);
    }

    function claimShares(address user) external nonReentrant {
        _syncDeposit(user);
        uint256 shares = claimableShares[user];
        if (shares == 0) revert ShareVault__ZeroAmount();
        claimableShares[user] = 0;
        _transfer(address(this), user, shares);
        emit SharesClaimed(user, shares);
    }

    function claimAssets(address user) external nonReentrant {
        _advanceRedeem(user, ALL_EPOCHS);
        uint256 owed = claimableAssets[user];
        uint256 reserved = reservedAssets;
        uint256 assets = owed > reserved ? reserved : owed;
        if (assets == 0) revert ShareVault__ZeroAmount();
        claimableAssets[user] = owed - assets;
        reservedAssets = reserved - assets;
        ledgerAssets -= assets;
        USDC.safeTransfer(user, assets);
        emit AssetsClaimed(user, assets);
    }

    function advanceRedeem(address user, uint256 maxEpochs) external nonReentrant {
        _advanceRedeem(user, maxEpochs);
    }

    function moveToVenue(address to, uint256 amount) external nonReentrant onlyOperator {
        if (!destinationAllowed[to]) revert ShareVault__DestinationNotAllowed();
        if (amount == 0) revert ShareVault__ZeroAmount();
        uint256 perCall = maxMovePerCall;
        if (amount > perCall) revert ShareVault__OverPerCallCap(perCall);
        uint64 epoch = currentEpoch;
        uint256 moved = movedInEpoch[epoch];
        uint256 perEpoch = maxMovePerEpoch;
        uint256 epochRoom = _floorSub(perEpoch, moved);
        if (amount > epochRoom) revert ShareVault__OverPerEpochCap(epochRoom);
        uint256 available = idleAssets();
        if (amount > available) revert ShareVault__InsufficientIdleAssets(available);

        movedInEpoch[epoch] = moved + amount;
        ledgerAssets -= amount;
        USDC.safeTransfer(to, amount);
        emit MovedToVenue(to, amount);
    }

    /// @notice Brings USDC that came back from a treasury destination into the ledger. Only counts
    /// what the vault actually holds beyond the ledger.
    function acknowledgeReturn(uint256 amount) external onlyOperator {
        if (amount == 0) revert ShareVault__ZeroAmount();
        if (amount > surplusAssets()) revert ShareVault__ReturnNotBacked();
        ledgerAssets += amount;
        emit ReturnAcknowledged(amount);
    }

    function sweepSurplus(address to) external nonReentrant onlyOwner {
        if (to == address(0)) revert ShareVault__ZeroAddress();
        uint256 amount = surplusAssets();
        if (amount == 0) revert ShareVault__NoSurplus();
        USDC.safeTransfer(to, amount);
        emit SurplusSwept(to, amount);
    }

    function setNavReceiver(address value) external onlyOwner {
        navReceiver = value;
        emit AddressUpdated("navReceiver", value);
    }

    function setOperator(address value) external onlyOwner {
        operator = value;
        emit AddressUpdated("operator", value);
    }

    function setFeeRecipient(address value) external onlyOwner {
        if (value == address(0)) revert ShareVault__ZeroAddress();
        feeRecipient = value;
        emit AddressUpdated("feeRecipient", value);
    }

    function setDestinationAllowed(address destination, bool allowed) external onlyOwner {
        if (destination == address(0)) revert ShareVault__ZeroAddress();
        destinationAllowed[destination] = allowed;
        emit DestinationAllowlistUpdated(destination, allowed);
    }

    function setMoveCaps(uint256 perCall, uint256 perEpoch) external onlyOwner {
        maxMovePerCall = perCall;
        maxMovePerEpoch = perEpoch;
        emit ParameterUpdated("maxMovePerCall", perCall);
        emit ParameterUpdated("maxMovePerEpoch", perEpoch);
    }

    function setMaxReportAge(uint32 value) external onlyOwner {
        if (value < MIN_REPORT_AGE || value > MAX_REPORT_AGE) revert ShareVault__OutOfBounds();
        maxReportAge = value;
        emit ParameterUpdated("maxReportAge", value);
    }

    function setMaxPriceMoveBps(uint16 value) external onlyOwner {
        if (value < MIN_PRICE_MOVE_BPS || value > MAX_PRICE_MOVE_BPS) revert ShareVault__OutOfBounds();
        maxPriceMoveBps = value;
        emit ParameterUpdated("maxPriceMoveBps", value);
    }

    function setMaxEpochGap(uint32 value) external onlyOwner {
        if (value < MIN_EPOCH_GAP || value > MAX_EPOCH_GAP) revert ShareVault__OutOfBounds();
        maxEpochGap = value;
        emit ParameterUpdated("maxEpochGap", value);
    }

    function setMaxRedeemBps(uint16 value) external onlyOwner {
        if (value < MIN_REDEEM_BPS || value > BPS) revert ShareVault__OutOfBounds();
        maxRedeemBps = value;
        emit ParameterUpdated("maxRedeemBps", value);
    }

    function setLockupPeriod(uint32 value) external onlyOwner {
        if (value > MAX_LOCKUP) revert ShareVault__OutOfBounds();
        lockupPeriod = value;
        emit ParameterUpdated("lockupPeriod", value);
    }

    function setPerformanceFeeBps(uint16 value) external onlyOwner {
        if (value > MAX_PERFORMANCE_FEE_BPS) revert ShareVault__OutOfBounds();
        performanceFeeBps = value;
        emit ParameterUpdated("performanceFeeBps", value);
    }

    /*//////////////////////////////////////////////////////////////
                    USER-FACING READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice USDC cash that belongs in the NAV report: the ledger minus settled redemptions
    /// awaiting claim and minus deposits still pending in the open epoch.
    function navCash() external view returns (uint256 cash) {
        cash = idleAssets();
    }

    function idleAssets() public view returns (uint256 idle) {
        idle = _floorSub(ledgerAssets, reservedAssets + epochDepositAssets[currentEpoch]);
    }

    function surplusAssets() public view returns (uint256 surplus) {
        surplus = _floorSub(USDC.balanceOf(address(this)), ledgerAssets);
    }

    function stalled() public view returns (bool isStalled) {
        isStalled = block.timestamp > uint256(lastSettledAt) + maxEpochGap;
    }

    function pendingClaims(address user) external view returns (uint256 shares, uint256 assets) {
        shares = claimableShares[user];
        assets = claimableAssets[user];
        DepositRequest memory deposit = depositRequests[user];
        uint64 epochNow = currentEpoch;
        if (deposit.assets > 0 && deposit.epoch < epochNow) {
            shares += _sharesFor(deposit.assets, settlements[deposit.epoch].price);
        }
        RedeemRequest memory redeem = redeemRequests[user];
        uint64 epoch = redeem.epoch;
        uint256 remaining = redeem.shares;
        while (remaining > 0 && epoch < epochNow) {
            Settlement memory s = settlements[epoch];
            (uint256 filled, uint256 carried) = _splitRemaining(remaining, s);
            assets += _assetsFor(filled, s.price);
            remaining = carried;
            ++epoch;
        }
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _syncDeposit(address user) internal {
        DepositRequest memory request = depositRequests[user];
        if (request.assets == 0 || request.epoch >= currentEpoch) return;
        Settlement memory s = settlements[request.epoch];
        claimableShares[user] += _sharesFor(request.assets, s.price);
        uint256 unlocksAt = uint256(s.settledAt) + lockupPeriod;
        if (unlocksAt > lockedUntil[user]) lockedUntil[user] = unlocksAt;
        delete depositRequests[user];
    }

    function _advanceRedeem(address user, uint256 maxEpochs) internal {
        RedeemRequest memory request = redeemRequests[user];
        if (request.shares == 0 && request.epoch == 0) return;
        uint64 epochNow = currentEpoch;
        uint256 remaining = request.shares;
        uint256 steps;
        uint256 accrued;
        while (remaining > 0 && request.epoch < epochNow && steps < maxEpochs) {
            Settlement memory s = settlements[request.epoch];
            (uint256 filled, uint256 carried) = _splitRemaining(remaining, s);
            accrued += _assetsFor(filled, s.price);
            remaining = carried;
            ++request.epoch;
            ++steps;
        }
        if (accrued > 0) claimableAssets[user] += accrued;
        if (remaining == 0) request.epoch = epochNow;
        request.shares = uint192(remaining);
        redeemRequests[user] = request;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        bool userToUser = from != address(0) && to != address(0) && from != address(this) && to != address(this);
        if (userToUser && lockedUntil[from] > lockedUntil[to]) lockedUntil[to] = lockedUntil[from];
    }

    /*//////////////////////////////////////////////////////////////
                     INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _checkRequest(uint256 amount, address receiver) internal view {
        if (amount == 0) revert ShareVault__ZeroAmount();
        if (receiver == address(0)) revert ShareVault__ZeroAddress();
        if (requestsPaused) revert ShareVault__RequestsPaused();
    }

    function _priceAfterFee(uint256 netAssets, uint256 supply)
        internal
        view
        returns (uint256 price, uint256 feeShares)
    {
        if (supply == 0) {
            return (INITIAL_PRICE, _sharesFor(netAssets, INITIAL_PRICE));
        }
        uint256 rawPrice = _priceOf(netAssets, supply);
        uint256 hwm = highWaterMark;
        uint256 feeBps = performanceFeeBps;
        if (rawPrice <= hwm || feeBps == 0) return (rawPrice, 0);
        feeShares = supply * (rawPrice - hwm) * feeBps / (rawPrice * BPS);
        price = _priceOf(netAssets, supply + feeShares);
    }

    function _deviates(uint256 price) internal view returns (bool deviated) {
        uint256 previous = lastPrice;
        if (previous == 0) return false;
        uint256 move = price > previous ? price - previous : previous - price;
        deviated = move * BPS > previous * maxPriceMoveBps;
    }

    function _fillRedemptions(uint256 redeemShares, uint256 price, uint256 netAssets)
        internal
        view
        returns (uint256 filled)
    {
        if (redeemShares == 0) return 0;
        uint256 wanted = _assetsFor(redeemShares, price);
        uint256 cap = netAssets * maxRedeemBps / BPS;
        uint256 cash = _floorSub(ledgerAssets, reservedAssets);
        if (cash < cap) cap = cash;
        if (wanted <= cap) return redeemShares;
        filled = redeemShares * cap / wanted;
    }

    /// @dev Both parts round down, so across all requesters the filled parts sum to at most the
    /// settled fill and the carried parts to at most the aggregate carry. The leftover is under one
    /// share unit per requester and stays in the vault.
    function _splitRemaining(uint256 remaining, Settlement memory s)
        internal
        pure
        returns (uint256 filled, uint256 carried)
    {
        filled = remaining * s.redeemFilledShares / s.redeemShares;
        carried = remaining * (s.redeemShares - s.redeemFilledShares) / s.redeemShares;
    }

    function _floorSub(uint256 a, uint256 b) internal pure returns (uint256 difference) {
        difference = a > b ? a - b : 0;
    }

    function _priceOf(uint256 netAssets, uint256 supply) internal pure returns (uint256 price) {
        price = netAssets * USDC_TO_E18 * PRICE_SCALE / supply;
    }

    function _sharesFor(uint256 assets, uint256 price) internal pure returns (uint256 shares) {
        shares = assets * USDC_TO_E18 * PRICE_SCALE / price;
    }

    function _assetsFor(uint256 shares, uint256 price) internal pure returns (uint256 assets) {
        assets = shares * price / (PRICE_SCALE * USDC_TO_E18);
    }
}
