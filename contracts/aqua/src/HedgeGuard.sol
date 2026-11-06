// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IAggregatorV3} from "src/interfaces/IAggregatorV3.sol";
import {IHedgeGuard} from "src/interfaces/IHedgeGuard.sol";
import {SwapQuery, SwapRegisters} from "src/interfaces/ISwapVmExtruction.sol";

/**
 * @title HedgeGuard
 * @notice Extruction target for a SwapVM strategy that lets takers trade against a market maker's hedge
 * inventory only in the direction that reduces the maker's BTC exposure.
 * @dev The same deterministic evaluation runs for quote (static call) and swap. Only the swap path mutates
 * state, and only when called by the SwapVM router. Amounts are read from the swap registers, so the strategy
 * must run its pricing curve before this instruction.
 * @custom:security-contact security@noirwire.com
 */
contract HedgeGuard is Ownable2Step, IHedgeGuard {
    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant PRICE_DECIMALS = 8;
    uint256 internal constant USDC_PER_BTC_TO_PRICE_E8 = 1e10;
    uint256 internal constant BPS_DENOMINATOR = 1e4;
    uint256 internal constant DECIMAL_BASE = 10;

    /*//////////////////////////////////////////////////////////////
                               STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable ROUTER;
    address public immutable WBTC;
    address public immutable USDC;

    address public hedger;
    OracleConfig public oracleConfig;
    mapping(address maker => Target target) internal s_targets;
    mapping(address maker => TargetTerms terms) internal s_terms;

    struct TargetTerms {
        bytes32 id;
        Direction direction;
        uint64 size;
        uint64 minPriceE8;
        uint64 maxPriceE8;
    }

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event TargetSet(
        address indexed maker,
        bytes32 indexed targetId,
        Direction direction,
        uint64 size,
        uint64 minPriceE8,
        uint64 maxPriceE8,
        uint40 expiry
    );
    event TargetCleared(address indexed maker);
    event OracleConfigured(address indexed feed, uint32 maxAge, uint16 maxDeviationBps);
    event HedgerChanged(address indexed newHedger);
    event HedgeFilled(
        address indexed maker,
        bytes32 indexed orderHash,
        address taker,
        uint256 btcAmount,
        uint256 priceE8,
        uint64 remaining
    );

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error HedgeGuard__OnlyHedger();
    error HedgeGuard__OnlyRouter();
    error HedgeGuard__ZeroAddress();
    error HedgeGuard__InvalidTarget();
    error HedgeGuard__InvalidOracleConfig();
    error HedgeGuard__TargetIdConflict(bytes32 targetId);
    error HedgeGuard__TargetNotSet(address maker);
    error HedgeGuard__TargetExpired(uint40 expiry);
    error HedgeGuard__AmountsNotComputed();
    error HedgeGuard__WrongDirection(address tokenIn, address tokenOut);
    error HedgeGuard__SizeExceedsRemaining(uint256 requested, uint64 remaining);
    error HedgeGuard__PriceOutsideBand(uint256 priceE8, uint64 minPriceE8, uint64 maxPriceE8);
    error HedgeGuard__OracleInvalid(int256 answer);
    error HedgeGuard__OracleStale(uint256 updatedAt, uint256 maxAge);
    error HedgeGuard__PriceFarFromOracle(uint256 priceE8, uint256 oracleE8, uint16 maxDeviationBps);

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyHedger() {
        if (msg.sender != hedger) {
            revert HedgeGuard__OnlyHedger();
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address router,
        address wbtc,
        address usdc,
        address initialOwner,
        address initialHedger,
        OracleConfig memory initialOracle
    ) Ownable(initialOwner) {
        if (router == address(0) || wbtc == address(0) || usdc == address(0) || initialHedger == address(0)) {
            revert HedgeGuard__ZeroAddress();
        }
        ROUTER = router;
        WBTC = wbtc;
        USDC = usdc;
        hedger = initialHedger;
        _setOracle(initialOracle.feed, initialOracle.maxAge, initialOracle.maxDeviationBps);
        emit HedgerChanged(initialHedger);
    }

    /*//////////////////////////////////////////////////////////////
                     USER-FACING STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IHedgeGuard
    function setTarget(
        address maker,
        bytes32 targetId,
        Direction direction,
        uint64 size,
        uint64 minPriceE8,
        uint64 maxPriceE8,
        uint40 expiry
    ) external onlyHedger {
        if (
            maker == address(0) || targetId == bytes32(0) || direction == Direction.None || size == 0 || minPriceE8 == 0
                || minPriceE8 > maxPriceE8 || expiry <= block.timestamp
        ) {
            revert HedgeGuard__InvalidTarget();
        }
        TargetTerms memory terms = s_terms[maker];
        if (terms.id == targetId) {
            if (
                terms.direction != direction || terms.size != size || terms.minPriceE8 != minPriceE8
                    || terms.maxPriceE8 != maxPriceE8
            ) {
                revert HedgeGuard__TargetIdConflict(targetId);
            }
            return;
        }
        s_terms[maker] = TargetTerms({
            id: targetId, direction: direction, size: size, minPriceE8: minPriceE8, maxPriceE8: maxPriceE8
        });
        s_targets[maker] = Target({
            direction: direction, remaining: size, minPriceE8: minPriceE8, maxPriceE8: maxPriceE8, expiry: expiry
        });
        emit TargetSet(maker, targetId, direction, size, minPriceE8, maxPriceE8, expiry);
    }

    /// @inheritdoc IHedgeGuard
    function clearTarget(address maker) external onlyHedger {
        delete s_targets[maker];
        emit TargetCleared(maker);
    }

    /// @inheritdoc IHedgeGuard
    function setOracle(address feed, uint32 maxAge, uint16 maxDeviationBps) external onlyOwner {
        _setOracle(feed, maxAge, maxDeviationBps);
    }

    /// @inheritdoc IHedgeGuard
    function setHedger(address newHedger) external onlyOwner {
        if (newHedger == address(0)) {
            revert HedgeGuard__ZeroAddress();
        }
        hedger = newHedger;
        emit HedgerChanged(newHedger);
    }

    /**
     * @notice SwapVM Extruction entrypoint. Quote calls it through a static call, swap calls it with state changes.
     * @dev Leaves the swap registers and program counter untouched; it only accepts or rejects the fill.
     */
    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata,
        bytes calldata
    ) external returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap) {
        (Target memory target, uint256 btcAmount, uint256 priceE8) = _evaluate(query, swap);

        if (!isStaticContext) {
            if (msg.sender != ROUTER) {
                revert HedgeGuard__OnlyRouter();
            }
            uint64 remaining = target.remaining - uint64(btcAmount);
            s_targets[query.maker].remaining = remaining;
            emit HedgeFilled(query.maker, query.orderHash, query.taker, btcAmount, priceE8, remaining);
        }

        updatedNextPC = nextPC;
        updatedSwap = swap;
    }

    /*//////////////////////////////////////////////////////////////
                      USER-FACING READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IHedgeGuard
    function targetOf(address maker) external view returns (Target memory target) {
        target = s_targets[maker];
    }

    /// @notice The Chainlink-scale (8 decimals) price the guard currently reads from its feed.
    function oraclePriceE8() external view returns (uint256 priceE8) {
        OracleConfig memory config = oracleConfig;
        priceE8 = _oraclePriceE8(config);
    }

    /*//////////////////////////////////////////////////////////////
                     INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _setOracle(address feed, uint32 maxAge, uint16 maxDeviationBps) internal {
        if (feed == address(0) || maxAge == 0 || maxDeviationBps == 0 || maxDeviationBps > BPS_DENOMINATOR) {
            revert HedgeGuard__InvalidOracleConfig();
        }
        oracleConfig = OracleConfig({feed: feed, maxAge: maxAge, maxDeviationBps: maxDeviationBps});
        emit OracleConfigured(feed, maxAge, maxDeviationBps);
    }

    /*//////////////////////////////////////////////////////////////
                      INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _evaluate(SwapQuery calldata query, SwapRegisters calldata swap)
        internal
        view
        returns (Target memory target, uint256 btcAmount, uint256 priceE8)
    {
        if (swap.amountIn == 0 || swap.amountOut == 0) {
            revert HedgeGuard__AmountsNotComputed();
        }

        target = s_targets[query.maker];
        if (target.direction == Direction.None) {
            revert HedgeGuard__TargetNotSet(query.maker);
        }
        if (block.timestamp >= target.expiry) {
            revert HedgeGuard__TargetExpired(target.expiry);
        }

        bool makerSells = target.direction == Direction.MakerSellsBtc;
        (address allowedIn, address allowedOut) = makerSells ? (USDC, WBTC) : (WBTC, USDC);
        if (query.tokenIn != allowedIn || query.tokenOut != allowedOut) {
            revert HedgeGuard__WrongDirection(query.tokenIn, query.tokenOut);
        }
        uint256 usdcAmount;
        (btcAmount, usdcAmount) = makerSells ? (swap.amountOut, swap.amountIn) : (swap.amountIn, swap.amountOut);

        if (btcAmount > target.remaining) {
            revert HedgeGuard__SizeExceedsRemaining(btcAmount, target.remaining);
        }

        priceE8 = usdcAmount * USDC_PER_BTC_TO_PRICE_E8 / btcAmount;
        if (priceE8 < target.minPriceE8 || priceE8 > target.maxPriceE8) {
            revert HedgeGuard__PriceOutsideBand(priceE8, target.minPriceE8, target.maxPriceE8);
        }

        OracleConfig memory config = oracleConfig;
        uint256 oracleE8 = _oraclePriceE8(config);
        uint256 diff = priceE8 > oracleE8 ? priceE8 - oracleE8 : oracleE8 - priceE8;
        if (diff * BPS_DENOMINATOR > oracleE8 * config.maxDeviationBps) {
            revert HedgeGuard__PriceFarFromOracle(priceE8, oracleE8, config.maxDeviationBps);
        }
    }

    function _oraclePriceE8(OracleConfig memory config) internal view returns (uint256 priceE8) {
        IAggregatorV3 feed = IAggregatorV3(config.feed);
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) {
            revert HedgeGuard__OracleInvalid(answer);
        }
        if (updatedAt == 0 || block.timestamp > updatedAt + config.maxAge) {
            revert HedgeGuard__OracleStale(updatedAt, config.maxAge);
        }

        uint256 feedDecimals = feed.decimals();
        priceE8 = uint256(answer);
        if (feedDecimals > PRICE_DECIMALS) {
            priceE8 /= DECIMAL_BASE ** (feedDecimals - PRICE_DECIMALS);
        } else if (feedDecimals < PRICE_DECIMALS) {
            priceE8 *= DECIMAL_BASE ** (PRICE_DECIMALS - feedDecimals);
        }
        if (priceE8 == 0) {
            revert HedgeGuard__OracleInvalid(answer);
        }
    }
}
