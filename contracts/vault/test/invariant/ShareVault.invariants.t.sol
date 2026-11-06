// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Base} from "test/Base.t.sol";
import {VaultHandler} from "test/invariant/VaultHandler.sol";

contract ShareVaultInvariantsTest is StdInvariant, Base {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        receiver.setWorkflowIdentity(bytes32(0), address(0), bytes10(0));
        vault.setMaxPriceMoveBps(5000);
        vault.setLockupPeriod(0);
        handler = new VaultHandler(vault, usdc, forwarder, address(receiver), operator, treasury, feeRecipient);
        targetContract(address(handler));
    }

    /// @dev Everything users can still claim fits inside the assets the vault reserved for them,
    /// which in turn sit inside the ledger and the real USDC balance.
    function invariant_SumOfClaimsIsCoveredByHeldAssets() external view {
        uint256 claimsTotal;
        for (uint256 i; i < handler.actorCount(); ++i) {
            (, uint256 assets) = vault.pendingClaims(handler.actors(i));
            claimsTotal += assets;
        }
        assertLe(claimsTotal, vault.reservedAssets());
        assertLe(vault.reservedAssets() + _pendingDeposits(), vault.ledgerAssets());
        assertLe(vault.ledgerAssets(), usdc.balanceOf(address(vault)));
    }

    /// @dev The share supply is exactly what settlements minted minus what they burned.
    function invariant_SupplyEqualsMintedMinusBurned() external view {
        assertEq(vault.totalSupply(), handler.ghostMinted() - handler.ghostBurned());
    }

    /// @dev Reserved assets for settled redemptions are never moved out of the vault.
    function invariant_ReservedAssetsStayInTheVault() external view {
        assertGe(usdc.balanceOf(address(vault)), vault.reservedAssets());
        assertGe(usdc.balanceOf(address(vault)), vault.reservedAssets() + _pendingDeposits());
    }

    /// @dev Unclaimed deposit shares and escrowed redemption shares are all held by the vault.
    function invariant_EscrowedSharesAreHeldByTheVault() external view {
        uint256 owed;
        for (uint256 i; i < handler.actorCount(); ++i) {
            (uint256 shares,) = vault.pendingClaims(handler.actors(i));
            owed += shares;
        }
        assertGe(vault.balanceOf(address(vault)), owed + vault.epochRedeemShares(vault.currentEpoch()));
    }

    /// @dev Donations never become deposits: pending deposits plus ledger track requests only.
    function invariant_NavCashNeverExceedsTheLedger() external view {
        assertLe(vault.navCash(), vault.ledgerAssets());
    }
}
