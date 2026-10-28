# @velo402/arc-sdk

Agent SDK for [Velo402](https://github.com/Lakshmikanth-3/velo-arc) vaults on Arc. An AI agent gets its own key and a budget; the vault contract enforces the owner's policy on every payment.

```bash
npm install @velo402/arc-sdk viem
```

```ts
import { ArcAgent, fetchWithPayment, invoiceId } from '@velo402/arc-sdk';
import { privateKeyToAccount } from 'viem/accounts';

const agent = new ArcAgent(privateKeyToAccount(process.env.AGENT_KEY), VAULT_ADDRESS, 'testnet', {
  onEvent: e => console.log(e), // { type: 'paid' | 'rejected' | 'gas', ... }
  minGas: '0.02',               // keep 0.02 USDC of gas, refilled from the agent's allowance
});

await agent.state();                                   // budget, daily remaining, expiry, balance
await agent.check(merchant, '0.01', invoiceId(order)); // null if allowed, else the contract error name
await agent.pay(merchant, '0.01', invoiceId(order));   // same invoice can never be paid twice

// HTTP 402: pays the quoted price from the vault and retries with proof.
const { response } = await fetchWithPayment(agent, 'https://velo402.vercel.app/api/x402/arc-stats', {}, req => BigInt(req.maxAmountRequired) <= 50_000n);
```

## What the agent key can do

Only `pay()` and `topUpGas()`. Both are checked by the contract against the owner's policy: active, not expired, recipient allowed (list or opted-in merchant registry), unique invoice, per-payment limit, daily limit, lifetime budget, gas allowance and vault balance. A rejected payment throws `ArcPolicyRejection` with the contract's reason and moves nothing.

## Circle Gateway

```ts
await agent.fundGateway('0.50'); // vault → agent's Circle Gateway balance, within the owner's Gateway allowance
```

The owner first calls `setGatewayAllowance(agent, amount)` on the vault. The agent can then pay any x402 seller through Gateway, for example with `GatewayClient` from `@circle-fin/x402-batching`. A refusal throws `ArcPolicyRejection` (`GatewayLimit`, `TotalLimit`, `DailyLimit`, `Unauthorized`, `Expired`, `GatewayDisabled`).

## HTTP 402 scheme

`velo402-vault`, x402-style. The server answers `402` with `{ x402Version: 1, accepts: [{ scheme, network, payTo, maxAmountRequired, asset, resource, invoice }] }`. The client pays with `paymentId = keccak256(invoice)` and retries with `X-PAYMENT: base64({ txHash, invoice })`. The server verifies on Arc that the transaction moved USDC from a factory vault to `payTo`, for at least the price, bound to that invoice.

## Build

`npm run build` emits `dist/`. `abi.ts`, `config.ts` and `capability.ts` are synced from the app by `pnpm arc:compile`.

MIT licensed.
