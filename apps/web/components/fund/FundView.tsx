import { Doors } from "../deposit/Doors";
import { PositionPanel } from "./PositionPanel";

export function FundView() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-ink-strong text-[28px] font-semibold tracking-tight">Fund</h1>
        <p className="text-faint mt-2 max-w-[60ch] text-body">
          Put test USDC into the maker vault from Arc, Ethereum, Base, Arbitrum or Solana, then see and withdraw your position. Everything here runs on test networks with no
          real value. Requests are priced at the next close, so shares appear once it settles.
        </p>
      </div>
      <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
        <section aria-labelledby="fund-title" className="border-line rounded-xl border p-5">
          <h2 id="fund-title" className="text-ink-strong text-[18px] font-semibold tracking-tight">
            Deposit USDC
          </h2>
          <p className="text-faint mt-1 mb-4 text-label">Pick where your USDC is today.</p>
          <Doors />
        </section>
        <PositionPanel />
      </div>
    </div>
  );
}
