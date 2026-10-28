// Pays any standard x402 seller through Circle Gateway, with money that comes from the Velo402 vault.
// Gateway needs an EOA signature per payment, so the agent's own key signs; the vault bounds the exposure:
// the agent can only move what the owner's Gateway allowance, lifetime budget and daily limit permit.
import { GatewayClient } from '@circle-fin/x402-batching/client';
import type { Hex } from 'viem';
import { ArcAgent, displayUsdc } from './arc-sdk';

export type GatewayPurchase = { status: number; data: unknown; paidUSDC: string; settlement: string; fundedFromVault: string | null };

export class GatewayBuyer {
  private readonly client: GatewayClient;
  /** maxPrice and topUp are in USDC atomic units (6 decimals). */
  constructor(private readonly agent: ArcAgent, privateKey: Hex, net: 'mainnet' | 'testnet', private readonly maxPrice: bigint, private readonly topUp: bigint, rpcUrl?: string) {
    this.client = new GatewayClient({ chain: net === 'mainnet' ? 'arc' : 'arcTestnet', privateKey, rpcUrl });
    if (this.client.address.toLowerCase() !== agent.account.address.toLowerCase()) throw new Error('Gateway signer must be the vault agent key');
    // Refuse before signing anything priced above the agent's per-purchase cap.
    this.client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
      if (BigInt(r.amount) > this.maxPrice) return { abort: true, reason: `Price ${displayUsdc(BigInt(r.amount))} USDC is above the ${displayUsdc(this.maxPrice)} USDC cap` };
    });
  }

  /** Gateway balance available to spend, in USDC atomic units. */
  async available() {
    return (await this.client.getBalances()).gateway.available;
  }

  /** Tops up from the vault when the Gateway balance cannot cover a purchase at the cap, then waits for Gateway to credit it. */
  async ensureFunds(timeoutMs = 120_000) {
    const start = await this.available();
    if (start >= this.maxPrice) return null;
    const funded = await this.agent.fundGateway(displayUsdc(this.topUp));
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
      if (await this.available() > start) return funded.hash;
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`Vault funded Gateway (${funded.hash}) but the deposit is not available yet; retry shortly`);
  }

  async buy(url: string): Promise<GatewayPurchase> {
    const fundedFromVault = await this.ensureFunds();
    const r = await this.client.pay(url);
    return { status: r.status, data: r.data, paidUSDC: r.formattedAmount, settlement: r.transaction, fundedFromVault };
  }
}
