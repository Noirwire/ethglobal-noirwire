import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { arcChain, depositToVault, erc20Abi, readArcState } from "./arc";
import { parseArcConfig } from "./config";

const rpc = process.env.ARC_LOCAL_RPC;
const deployment = new URL("../../../../contracts/vault/deployments/local.json", import.meta.url);

const mockUsdc = parseAbi(["function mint(address to, uint256 amount)"]);

describe.skipIf(!rpc)("Arc door against a local chain", () => {
  it("approves USDC and requests a deposit, leaving a pending request onchain", async () => {
    const addresses = JSON.parse(readFileSync(deployment, "utf8")) as { shareVault: Address; usdc: Address; chainId: number };
    const parsed = parseArcConfig({
      chainId: String(addresses.chainId),
      rpcUrl: rpc,
      vault: addresses.shareVault,
      usdc: addresses.usdc,
    });
    if (!parsed.ok) throw new Error(parsed.reason);
    const config = parsed.config;
    const chain = arcChain(config);
    const account = privateKeyToAccount(generatePrivateKey());
    await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [account.address, "0x56bc75e2d63100000"] }),
    });
    const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl), pollingInterval: 100 });
    const walletClient = createWalletClient({ account, chain, transport: http(config.rpcUrl) });

    const mintTx = await walletClient.writeContract({ address: config.usdc, abi: mockUsdc, functionName: "mint", args: [account.address, 50_000_000n] });
    await publicClient.waitForTransactionReceipt({ hash: mintTx });
    const before = await readArcState(publicClient, config, account.address);

    const steps: string[] = [];
    const result = await depositToVault({
      publicClient,
      walletClient,
      config,
      account: account.address,
      assets: 12_340_000n,
      onStep: (step) => steps.push(step),
    });

    expect(result.approveTx).not.toBeNull();
    expect(steps).toContain("approving");
    expect(result.state.request.assets - before.request.assets).toBe(12_340_000n);
    expect(result.state.request.epoch).toBe(result.state.currentEpoch);
    expect(result.state.balance).toBe(before.balance - 12_340_000n);

    const onchain = await publicClient.readContract({
      address: config.vault,
      abi: parseAbi(["function depositRequests(address) view returns (uint64 epoch, uint192 assets)"]),
      functionName: "depositRequests",
      args: [account.address],
    });
    expect(onchain[1]).toBe(result.state.request.assets);
    console.log(JSON.stringify({ approveTx: result.approveTx, depositTx: result.depositTx, mintTx, pending: onchain[1].toString(), epoch: onchain[0].toString() }));

    const allowance = await publicClient.readContract({ address: config.usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, config.vault] });
    expect(allowance).toBe(0n);
  });
});
