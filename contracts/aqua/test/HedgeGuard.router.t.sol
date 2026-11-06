// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HedgeGuard} from "src/HedgeGuard.sol";
import {IHedgeGuard} from "src/interfaces/IHedgeGuard.sol";
import {ForkBase} from "test/utils/ForkBase.sol";
import {IAqua, ISwapVmRouter} from "test/utils/ISwapVmRouter.sol";

contract HedgeGuardRouterTest is ForkBase {
    uint8 internal constant OPCODE_XYC_SWAP = 17;
    uint8 internal constant OPCODE_SALT = 20;
    uint8 internal constant OPCODE_EXTRUCTION = 32;
    uint256 internal constant USE_AQUA_FLAG = 1 << 254;
    bytes internal constant TAKER_EXACT_IN_AND_PUSH = hex"00000000000000000000000000000000000000000041";
    uint256 internal constant INVENTORY = 2e8;
    uint64 internal constant TARGET_SIZE = 1e8;

    ISwapVmRouter.Order internal order;
    bytes32 internal strategyHash;

    function setUp() public override {
        super.setUp();
        deal(WBTC, maker, INVENTORY);
        deal(USDC, taker, 1_000_000e6);
        deal(WBTC, taker, 10e8);

        vm.startPrank(maker);
        IERC20(WBTC).approve(AQUA, type(uint256).max);
        IERC20(USDC).approve(AQUA, type(uint256).max);
        vm.stopPrank();

        vm.startPrank(taker);
        IERC20(WBTC).approve(ROUTER, type(uint256).max);
        IERC20(USDC).approve(ROUTER, type(uint256).max);
        vm.stopPrank();

        order = ISwapVmRouter.Order({maker: maker, traits: USE_AQUA_FLAG, data: _program(1)});
        _setTarget(IHedgeGuard.Direction.MakerSellsBtc, TARGET_SIZE);
        strategyHash = _ship();
    }

    function _program(uint64 salt) internal view returns (bytes memory program) {
        program = abi.encodePacked(
            OPCODE_XYC_SWAP, uint8(0), OPCODE_EXTRUCTION, uint8(20), address(guard), OPCODE_SALT, uint8(8), salt
        );
    }

    function _tokens() internal pure returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = WBTC;
        tokens[1] = USDC;
    }

    function _ship() internal returns (bytes32 hash) {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = INVENTORY;
        amounts[1] = INVENTORY * oracleE8 / PRICE_TO_USDC;
        vm.prank(maker);
        hash = IAqua(AQUA).ship(ROUTER, abi.encode(order), _tokens(), amounts);
    }

    function _usdcFor(uint256 btc) internal view returns (uint256 usdc) {
        usdc = btc * oracleE8 / PRICE_TO_USDC;
    }

    function testFuzz_AllowedDirectionQuoteEqualsSwap(uint256 btc) public {
        btc = bound(btc, 1e6, 3e6);
        uint256 usdcIn = _usdcFor(btc);

        (uint256 quotedIn, uint256 quotedOut, bytes32 quotedHash) =
            ISwapVmRouter(ROUTER).quote(order, USDC, WBTC, usdcIn, TAKER_EXACT_IN_AND_PUSH);
        assertEq(quotedHash, strategyHash);

        uint256 makerBtcBefore = IERC20(WBTC).balanceOf(maker);
        uint256 takerBtcBefore = IERC20(WBTC).balanceOf(taker);
        uint256 takerUsdcBefore = IERC20(USDC).balanceOf(taker);

        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) =
            ISwapVmRouter(ROUTER).swap(order, USDC, WBTC, usdcIn, TAKER_EXACT_IN_AND_PUSH);

        assertEq(amountIn, quotedIn);
        assertEq(amountOut, quotedOut);
        assertEq(makerBtcBefore - IERC20(WBTC).balanceOf(maker), amountOut);
        assertEq(IERC20(WBTC).balanceOf(taker) - takerBtcBefore, amountOut);
        assertEq(takerUsdcBefore - IERC20(USDC).balanceOf(taker), amountIn);
        assertEq(guard.targetOf(maker).remaining, TARGET_SIZE - amountOut);
    }

    function testFuzz_RevertWhen_WrongWaySwap(uint256 btc) public {
        btc = bound(btc, 1e6, 3e6);

        vm.expectPartialRevert(HedgeGuard.HedgeGuard__WrongDirection.selector);
        ISwapVmRouter(ROUTER).quote(order, WBTC, USDC, btc, TAKER_EXACT_IN_AND_PUSH);

        uint256 takerBtcBefore = IERC20(WBTC).balanceOf(taker);
        vm.prank(taker);
        vm.expectPartialRevert(HedgeGuard.HedgeGuard__WrongDirection.selector);
        ISwapVmRouter(ROUTER).swap(order, WBTC, USDC, btc, TAKER_EXACT_IN_AND_PUSH);
        assertEq(IERC20(WBTC).balanceOf(taker), takerBtcBefore);
        assertEq(guard.targetOf(maker).remaining, TARGET_SIZE);
    }

    function test_RevertWhen_OverfillThroughRouter() public {
        uint256 usdcIn = _usdcFor(15e6);
        vm.prank(hedger);
        guard.setTarget(
            maker,
            IHedgeGuard.Direction.MakerSellsBtc,
            1e6,
            uint64(oracleE8 * 95 / 100),
            uint64(oracleE8 * 105 / 100),
            uint40(block.timestamp + 1 days)
        );

        vm.prank(taker);
        vm.expectPartialRevert(HedgeGuard.HedgeGuard__SizeExceedsRemaining.selector);
        ISwapVmRouter(ROUTER).swap(order, USDC, WBTC, usdcIn, TAKER_EXACT_IN_AND_PUSH);
    }

    function test_RevertWhen_TargetClearedBetweenQuoteAndSwap() public {
        uint256 usdcIn = _usdcFor(2e6);
        ISwapVmRouter(ROUTER).quote(order, USDC, WBTC, usdcIn, TAKER_EXACT_IN_AND_PUSH);

        vm.prank(hedger);
        guard.clearTarget(maker);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(HedgeGuard.HedgeGuard__TargetNotSet.selector, maker));
        ISwapVmRouter(ROUTER).swap(order, USDC, WBTC, usdcIn, TAKER_EXACT_IN_AND_PUSH);
    }

    function test_DockRemovesVirtualBalances() public {
        (uint248 btcVirtual,) = IAqua(AQUA).rawBalances(maker, ROUTER, strategyHash, WBTC);
        assertEq(btcVirtual, INVENTORY);

        vm.prank(maker);
        IAqua(AQUA).dock(ROUTER, strategyHash, _tokens());

        (btcVirtual,) = IAqua(AQUA).rawBalances(maker, ROUTER, strategyHash, WBTC);
        assertEq(btcVirtual, 0);
    }
}
