# Velo402 on Arc

**Velo402 gives autonomous AI agents restricted authority to spend USDC through an owner-controlled vault.** Owners define spending limits, authorized recipients and expiration rules, and can revoke permissions. The Arc deployment provides programmable, policy-enforced payments with verifiable on-chain transactions.

- **Live app (Arc mainnet):** https://velo402.vercel.app/arc
- **Security proof:** https://velo402.vercel.app/security
- **Developers / SDK / HTTP 402 API:** https://velo402.vercel.app/developers
- **Builder:** https://github.com/Lakshmikanth-3

## Live on Arc mainnet (chain 5042)

| What | Address / transaction |
| --- | --- |
| ArcVaultFactory | [`0x333af5f858a1cc267b6ab16e83bcb2fe28f8b2b1`](https://explorer.arc.io/address/0x333af5f858a1cc267b6ab16e83bcb2fe28f8b2b1) (deploy tx [`0x4bf4f62e…9225f1e`](https://explorer.arc.io/tx/0x4bf4f62ef5104d956e18d37af1e2661e25c982b31b927dbe05742c63d9225f1e)) |
| MerchantRegistry | [`0x8ab3bc42d0d6630395cc9eea8f44de007efa026f`](https://explorer.arc.io/address/0x8ab3bc42d0d6630395cc9eea8f44de007efa026f) |
| Vault used by the AI agent | [`0xD0e065D4978F7614C3d6dA5b162fd25ed45c3C8F`](https://explorer.arc.io/address/0xD0e065D4978F7614C3d6dA5b162fd25ed45c3C8F) |
| First AI-agent payment (0.01 USDC, via registry merchant) | [`0xee745efa…6ee1eedd`](https://explorer.arc.io/tx/0xee745efaace3a156f09ae07b4d9e1e47204075d8cf192114c378f01e6ee1eedd) |
| AI agent buying data over HTTP 402 (2 × 0.01 USDC) | [`0x4470348e…ab4446bf4`](https://explorer.arc.io/tx/0x4470348e6f53a9c648bdbc3e6e4ceee1d91786bbd3cd22420401879ab4446bf4), [`0x5111969c…a8dafef8f`](https://explorer.arc.io/tx/0x5111969c433bda26c9c80a8cdb6a3ab3c22653cbab8956b40107397a8dafef8f) |
| Console walkthrough payment (0.02 USDC, recorded in the demo video) | [`0x3ef19008…f11ff26e`](https://explorer.arc.io/tx/0x3ef190083bf8322e8514e6b24c43830915912358d134c4f801983268f11ff26e) |

All mainnet records: [`contracts/arc/deployments/5042.json`](contracts/arc/deployments/5042.json), [`5042-setup.json`](contracts/arc/deployments/5042-setup.json) and the AI agent transcript [`5042-ai-agent-run.log`](contracts/arc/deployments/5042-ai-agent-run.log). On mainnet the vault also rejected an injected 5 USDC payment to an attacker (`RecipientDenied`) and an over-limit payment (`PaymentLimit`) without moving funds.

## Built for Arc Microgrants

Velo402 was built and submitted to [Arc Microgrants](https://dorahacks.io/hackathon/arc-microgrants/build), which funds projects that are **deployed and working on Arc mainnet**. Every requirement below links to its proof.

| Program requirement | How Velo402 meets it | Proof |
| --- | --- | --- |
| Deployed and working on Arc mainnet | Factory, registry and a funded vault on chain 5042; real agent payments | [Factory](https://explorer.arc.io/address/0x333af5f858a1cc267b6ab16e83bcb2fe28f8b2b1) · [agent payment](https://explorer.arc.io/tx/0xee745efaace3a156f09ae07b4d9e1e47204075d8cf192114c378f01e6ee1eedd) |
| Live link reviewers can open | Web console defaults to Arc mainnet | https://velo402.vercel.app/arc |
| Public repo | This repository, MIT licensed | [LICENSE](LICENSE) |
| Short description and Arc use | Top of this README and the submission answers | [docs/ARC_MICROGRANTS_SUBMISSION.md](docs/ARC_MICROGRANTS_SUBMISSION.md) |
| Public builder profile | GitHub | https://github.com/Lakshmikanth-3 |
| Real Arc component, not a mockup | Solidity contracts on Arc, USDC settlement, explorer receipts | [contracts/arc/deployments/5042.json](contracts/arc/deployments/5042.json) |
| Not testnet-only | Mainnet records alongside testnet test runs | [5042-setup.json](contracts/arc/deployments/5042-setup.json) · [AI agent transcript](contracts/arc/deployments/5042-ai-agent-run.log) |
| Not previously funded by Circle or Arc | First submission of this project | Declared in the submission |



| Stage | Evidence in this repo |
| --- | --- |
| Contracts and security tests | [ArcVault.sol](contracts/arc/ArcVault.sol), [arc-contract.test.mjs](app/scripts/arc-contract.test.mjs), [arc-adversarial.test.mjs](app/scripts/arc-adversarial.test.mjs) |
| Testnet deployment and end-to-end | [5042002.json](contracts/arc/deployments/5042002.json), [5042002-e2e.json](contracts/arc/deployments/5042002-e2e.json), [ARC_TESTNET_REPORT.md](docs/ARC_TESTNET_REPORT.md) |
| Live-site browser run | [5042002-browser.json](contracts/arc/deployments/5042002-browser.json), [screenshot](contracts/arc/deployments/5042002-browser.png) |
| Mainnet readiness | [MAINNET_READINESS.md](docs/MAINNET_READINESS.md) |
| Mainnet deployment and setup | [5042.json](contracts/arc/deployments/5042.json), [5042-setup.json](contracts/arc/deployments/5042-setup.json) |
| AI agent on mainnet | [5042-ai-agent-run.log](contracts/arc/deployments/5042-ai-agent-run.log) |

## Demo video (5:22)

Title → the problem (Bybit, about $1.5B, Feb 2025; the Freysa AI agent, about $47K, Nov 2024) → the solution and why the agent cannot overspend → why Arc → **live walkthrough on Arc mainnet** with real USDC (create vault, deposit, authorize with a daily limit, agent pays, three attacks rejected, revoke, withdraw, explorer receipt) → the AI agent paying an HTTP 402 API on mainnet and ignoring a prompt injection → architecture → end. Re-record with `app/scripts/arc-demo-record.ts`.

---

## The problem

AI agents increasingly need to pay for things: APIs, data, compute, other agents. Today you either give an agent a private key (it can spend everything) or you keep a human in the loop for every payment (it is not autonomous). Prompt injection makes the first option dangerous: one malicious web page or tool result can tell the agent to send funds elsewhere.

- **Bybit, February 2025:** signers were tricked into approving a malicious transaction; about **$1.5 billion** was stolen in one transfer. The keys never leaked; the approval was manipulated.
- **Freysa AI agent, November 2024:** an agent built never to release its prize pool was talked into it by one message; about **$47,000** left the wallet.

```mermaid
flowchart LR
  subgraph Today["Today: two bad options"]
    K[Agent holds the key] -->|one prompt injection| X[Wallet drained]
    H[Human approves each payment] --> S[Not autonomous]
  end
  subgraph V["Velo402"]
    A[Agent signs payment] --> C{Vault checks owner policy<br/>on-chain}
    C -->|all rules pass| P[USDC paid + receipt]
    C -->|any rule fails| R[Revert, nothing moves]
  end
```

## The solution

The owner puts USDC in a **vault contract** on Arc and grants an agent a **capability**:

| Rule | Example |
| --- | --- |
| Lifetime budget | 5 USDC total |
| Per-payment ceiling | 0.50 USDC per payment |
| Daily limit | 1 USDC per UTC day, so a stolen key drains slowly and the owner has time to revoke |
| Recipient allowlist | only `0xAPI…`, `0xData…`, editable one at a time |
| Merchant registry (opt-in) | any merchant approved in a curated on-chain registry |
| Gas allowance | the agent may draw up to 0.2 USDC for its own gas (USDC is Arc's gas token) |
| Circle Gateway allowance | the agent may move up to 1 USDC into its own Circle Gateway balance, to pay any x402 seller |
| Expiry | valid for 24 hours |
| Revocation | owner can cancel at any moment |

The agent signs its own payments, so it stays autonomous. The vault contract checks every rule **inside the same transaction that moves the USDC**. If a rule fails, the transaction reverts and nothing moves. A manipulated agent, or a thief with the agent's key, can only ever do what the owner allowed.

### Paying any x402 API through Circle Gateway

Vault payments only reach recipients the owner listed. To let an agent buy from **any** x402 seller, the owner sets a Gateway allowance with `setGatewayAllowance(agent, amount)`. The agent calls `fundGateway(amount)`, and the vault deposits that USDC into Circle's Gateway Wallet (`depositFor`) credited to the agent. The agent then pays sellers with gas-free, batched Gateway nanopayments.

Gateway only accepts payments signed by a normal wallet, not by a contract (no ERC-1271), so the vault cannot sign those payments itself. Instead it caps how much the agent can ever move into Gateway. That deposit counts against the lifetime budget and the daily limit, and stops on expiry or revocation. Whatever the agent has already moved into Gateway is the most it can spend there, and revoking does not pull it back. Gateway Wallet addresses come from Circle's `@circle-fin/x402-batching` 4.0.0 (Arc mainnet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`).

> The contracts listed under "Live on Arc mainnet" are the first version, without Gateway funding. The Gateway version is tested locally (`pnpm arc:test`) and needs a new mainnet deployment.

## Why Arc

- **USDC is the gas token.** The agent needs only USDC: no second token to buy, price or top up.
- **Dollar-denominated budgets.** Limits, fees and payments are all in the same stable unit.
- **Fast, cheap finality** suits many small machine-to-machine payments (the "402 Payment Required" pattern the name refers to).
- **Standard EVM:** Solidity, viem and any EVM wallet work unchanged.

## What's included

- **Contracts:** vault, factory (several vaults per owner) and merchant registry.
- **AI agent** ([`app/agent/ai-agent.ts`](app/agent/ai-agent.ts)): an LLM agent with `get_budget`, `buy_resource` and `pay` tools. Works with any OpenAI-compatible API (Groq free tier by default, or Ollama locally with no key).
- **HTTP 402 pay-per-request API** ([`/api/x402/...`](app/src/app/api/x402)): returns `402` with an invoice; the agent pays from its vault; the server verifies the USDC transfer on Arc before serving data.
- **Agent SDK** ([`sdk/`](sdk)): `@velo402/arc-sdk`, with `pay`, `check`, `ensureGas`, `fundGateway`, `invoiceId` and `fetchWithPayment`.
- **Owner alerts:** webhook (Discord, Slack, Zapier), Telegram, and live in-app alerts.
- **Console:** multi-wallet discovery (EIP-6963), multiple vaults, policy templates, spending dashboard by agent and recipient, explorer fallback for history.
- **Developers page** (`/developers`): quickstart, comparison with other agent wallets, use cases, roadmap.

---

## Architecture

```mermaid
flowchart TB
  O["Owner wallet<br/>(browser or Safe multisig)"]
  AG["AI agent<br/>Velo402 SDK, own key"]
  API["Paid API (HTTP 402)<br/>/api/x402/*"]
  UI["Web console<br/>velo402.vercel.app"]
  AL["Alerts<br/>webhook, Telegram, in-app"]

  subgraph ARC["Arc mainnet (chain 5042)"]
    F["ArcVaultFactory<br/>many vaults per owner"]
    V["ArcVault<br/>USDC + capability per agent:<br/>budget, per-payment, daily,<br/>recipients, gas allowance, expiry"]
    R["MerchantRegistry<br/>curated merchants"]
    U["USDC (ERC-20 + gas token)"]
    E["Arc RPC / Explorer"]
  end

  O -- "createVault()" --> F
  F -- deploys --> V
  O -- "deposit, authorize, setRecipient,<br/>setRegistry, revoke, withdraw" --> V
  AG -- "pay(to, amount, invoiceHash)<br/>topUpGas(amount)" --> V
  V -- "approved?" --> R
  V -- transfers --> U
  AG -- "GET, 402, pay, retry with proof" --> API
  API -- "verify Paid event" --> E
  V -- "events: Funded, Authorized, Paid,<br/>GasToppedUp, Revoked, Withdrawn" --> E
  UI -- "reads balances and events" --> E
  O --> UI
  E --> AL
```

### Working flow: owner, agent and vault

```mermaid
sequenceDiagram
  autonumber
  actor Owner
  participant Factory as ArcVaultFactory
  participant Vault as ArcVault
  actor Agent as AI agent
  participant M as Merchant / API

  Owner->>Factory: createVault()
  Factory-->>Owner: new vault address
  Owner->>Vault: approve + deposit(USDC)
  Owner->>Vault: authorize(agent, policy, recipients)
  Agent->>Vault: pay(merchant, 0.01, invoiceHash)
  Vault->>Vault: check every rule
  Vault->>M: transfer 0.01 USDC
  Vault-->>Agent: Paid event (receipt)
  Agent->>Vault: pay(attacker, 5, ...) (prompt injection)
  Vault-->>Agent: revert RecipientDenied, nothing moves
  Owner->>Vault: revoke(agent)
  Agent->>Vault: pay(...)
  Vault-->>Agent: revert Unauthorized
  Owner->>Vault: withdraw(remaining)
```

### What `pay()` checks, in order

```mermaid
flowchart TD
  S(["pay(recipient, amount, invoiceHash)"]) --> A{capability active?}
  A -- no --> E1[Unauthorized]
  A -- yes --> B{not expired?}
  B -- no --> E2[Expired]
  B -- yes --> C{recipient allowed?<br/>allowlist or registry}
  C -- no --> E3[RecipientDenied]
  C -- yes --> D{amount greater than 0 and<br/>invoice unused?}
  D -- no --> E4[InvalidInput / DuplicatePayment]
  D -- yes --> F{amount ≤ per-payment limit?}
  F -- no --> E5[PaymentLimit]
  F -- yes --> G{amount ≤ remaining budget?}
  G -- no --> E6[TotalLimit]
  G -- yes --> H{amount ≤ remaining today?}
  H -- no --> E7[DailyLimit]
  H -- yes --> I{amount ≤ vault balance?}
  I -- no --> E8[InsufficientFunds]
  I -- yes --> OK([record spend, transfer USDC, emit Paid])
```

### HTTP 402 pay-per-request flow

```mermaid
sequenceDiagram
  autonumber
  participant A as AI agent (SDK)
  participant API as Paid API
  participant V as ArcVault
  participant Arc as Arc RPC

  A->>API: GET /api/x402/arc-stats
  API-->>A: 402 Payment Required {payTo, price, invoice}
  A->>V: pay(payTo, price, keccak256(invoice))
  V-->>A: tx hash (Paid event)
  A->>API: GET + X-PAYMENT {txHash, invoice}
  API->>Arc: read receipt: Paid from a factory vault,<br/>to payTo, amount >= price, invoice matches
  Arc-->>API: verified
  API-->>A: 200 OK + data
```

### Internal components

| Path | What it is |
| --- | --- |
| [`contracts/arc/ArcVault.sol`](contracts/arc/ArcVault.sol) | Vault, factory and merchant registry. OpenZeppelin `SafeERC20` and `ReentrancyGuard`. Immutable: no admin, no upgrades. |
| [`sdk/`](sdk) | `@velo402/arc-sdk`: verifies chain, bytecode, token and decimals, pre-checks then sends `pay()`, never auto-retries (avoids double payment), HTTP 402 client. |
| [`app/agent/ai-agent.ts`](app/agent/ai-agent.ts) | LLM agent with payment tools. |
| [`app/agent/watch.ts`](app/agent/watch.ts) · [`alerts.ts`](app/agent/alerts.ts) | Owner alerts to webhook and Telegram. |
| [`app/src/app/api/x402`](app/src/app/api/x402) | Pay-per-request API with on-chain payment verification. |
| [`app/agent/arc-runner.ts`](app/agent/arc-runner.ts) | CLI agent that uses the SDK. Mainnet spends need an explicit confirmation variable. |
| [`app/src/components/ArcConsole.tsx`](app/src/components/ArcConsole.tsx) | Owner and agent console: connect wallet, create/fund vault, authorize, pay, revoke, event history. |
| [`app/src/app/security`](app/src/app/security/page.tsx) | Threat model with mainnet and testnet receipts. |
| [`app/scripts/arc-deploy.ts`](app/scripts/arc-deploy.ts) · [`arc-mainnet-setup.ts`](app/scripts/arc-mainnet-setup.ts) | Preflight, deploy of factory and registry, mainnet vault and agent setup. |
| [`app/scripts/*.test.*`](app/scripts) | Contract, adversarial, SDK, UI and live testnet tests. |

### External dependencies

| Dependency | Use |
| --- | --- |
| Arc mainnet (chain 5042) / testnet (5042002) | Official RPC `rpc.mainnet.arc.io` / `rpc.testnet.arc.io` |
| USDC ERC-20 interface `0x3600…0000` | 6-decimal token the vault holds; native gas uses the same balance at 18 decimals |
| Arc Explorer | Every receipt in the UI links to it |
| Any injected EVM wallet | Signs owner and agent transactions in the browser |
| Circle faucet | Free testnet USDC |
| Vercel | Hosts the web app |

### Payment flow, step by step

1. **Owner** calls `factory.createVault()` and receives a vault bound to their address.
2. **Owner** approves the exact amount and calls `vault.deposit(amount)`.
3. **Owner** calls `vault.authorize(agent, policy, recipients[])` with `policy = { maxTotal, maxPayment, maxPerDay, gasAllowance, expiresAt, useRegistry }`. A new allowlist version is created; spend already used is kept. Single recipients can be added or removed later.
4. **Agent** calls `vault.pay(recipient, amount, invoiceHash)`. The contract checks, in order: active → not expired → recipient allowed → non-zero → invoice unused → ≤ per-payment ceiling → ≤ remaining budget → ≤ remaining today → ≤ balance. Then it records spend and transfers USDC. `topUpGas(amount)` follows the same budget and daily rules plus the gas allowance.
5. **Owner** can `revoke(agent)` at any time and `withdraw(amount)` remaining funds back to the owner address.

---

## Security: the agent cannot be manipulated into overspending

The agent key can call only `pay()` and `topUpGas()`, and both enforce the owner's policy on-chain. Full threat model: [`/security`](https://velo402.vercel.app/security) and [`docs/ARC_SECURITY.md`](docs/ARC_SECURITY.md).

| Attack | Blocked by |
| --- | --- |
| Pay more than allowed per payment | `PaymentLimit` |
| Spend fast after a key theft | `DailyLimit` |
| Drain through gas top-ups | `GasLimit` |
| Follow a prompt injection to pay an attacker | `RecipientDenied` (shown live by the AI agent run) |
| Drain the vault over many payments | `TotalLimit` (spend stored on-chain) |
| Pay itself or an attacker | `RecipientDenied` (allowlist) |
| Replay a payment | `DuplicatePayment` |
| Pay after expiry / revocation | `Expired` / `Unauthorized` |
| Raise its own limits, add recipients, change registry, withdraw, un-revoke | `NotOwner` |
| Reentrancy | `ReentrancyGuard` |

**Proof:**

- `scripts/arc-adversarial.test.mjs` runs hundreds of random attack transactions per seed (oversized amounts, foreign recipients, replayed IDs, gas drains, owner-only calls, day rollovers, revocations). After **every** round it checks that on-chain spend equals the sum of permitted payments and gas top-ups, stays within budget and gas allowance, the attacker holds zero and the agent holds only its permitted gas.
- `scripts/arc-testnet-e2e.test.ts` repeats the attacks against the real Arc testnet with real transactions.
- `scripts/arc-x402.test.ts` proves forged, tampered and cross-resource payment proofs are rejected by the API.

**Not yet:** an independent audit. The contracts are small and heavily tested; an audit is the next milestone before large balances.

---

## Run it

```bash
cd app
pnpm install
cp .env.example .env.local      # fill in NEXT_PUBLIC_ARC_* values
pnpm dev                        # http://localhost:3000
```

### Tests

```bash
pnpm arc:test            # contract flow + adversarial invariant test (local EVM)
ARC_FUZZ_SEED=7 pnpm arc:test   # re-run the attacker with another seed
pnpm arc:testnet:setup   # create dedicated testnet keys in ignored .env.arc-testnet
pnpm arc:testnet:e2e     # full end-to-end on Arc testnet with real transactions
X402_BASE_URL=http://localhost:3000 pnpm arc:testnet:x402   # pay-per-request API, incl. forged proofs
pnpm arc:testnet:browser # clicks through the live site on Arc testnet
pnpm arc:ready           # everything above + read-only mainnet preflight -> docs/MAINNET_READINESS.md
pnpm arc:test:ui-full    # every console button and page link, in a real browser
E2E_BASE_URL=https://velo402.vercel.app pnpm test:e2e e2e/arc-live.spec.ts   # live site checks
```

### Test manually in the browser (Arc testnet)

1. Install an EVM wallet (MetaMask or Rabby) and create **two** accounts: *Owner* and *Agent*.
2. Get free test USDC for both from https://faucet.circle.com (choose Arc Testnet).
3. Open https://velo402.vercel.app/testnet and click **Connect EVM wallet** with the *Owner* account. If asked, click **Switch to Arc Testnet** and approve it in the wallet.
4. **Create my vault** and confirm. The vault address fills in.
5. Enter `1` as the amount, then **Approve exact amount and deposit**. Vault balance shows 1 USDC.
6. Pick a policy template or paste the *Agent* address, set budget `0.5`, per payment `0.2`, put the *Owner* address as the permitted recipient, choose an expiry an hour ahead, then **Authorize / update**.
7. Switch the wallet to the *Agent* account and reconnect. Enter amount `0.1`, recipient = Owner, any payment ID, then **Pay USDC**. A `Paid` event appears with a receipt link.
8. Try to break it as the agent: amount `0.3` (over the per-payment limit), a different recipient, or the same payment ID again. Each is rejected before signing and would revert on-chain.
9. Switch back to *Owner*, click **Revoke immediately**, then try paying as the agent again: rejected.
10. As *Owner*, **Withdraw to owner** to recover the remaining USDC.

### Run the AI agent

```bash
# Free LLM: create a key at console.groq.com (no card), or run Ollama locally.
LLM_API_KEYS=gsk_a,gsk_b,gsk_c ARC_NETWORK=testnet ARC_VAULT_ADDRESS=0x... pnpm arc:ai-agent
# Several keys rotate automatically on rate limits. --every 30 runs a task every 30 minutes.
# Ollama: LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3.1
# No LLM: add --scripted to run the same tools in a fixed order.
```

### Alerts

Set `ALERT_WEBHOOK_URL` and/or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, then `ARC_VAULT_ADDRESS=0x... pnpm arc:watch`. The SDK also sends an alert for every blocked payment.

### Deploy to mainnet (what was run)

```bash
pnpm arc:ready                                              # all suites + mainnet preflight
ARC_NETWORK=mainnet ARC_MAINNET_CONFIRM=I_CONFIRM_MAINNET_SPEND npx tsx --env-file=.env scripts/arc-deploy.ts --broadcast
ARC_MAINNET_CONFIRM=I_CONFIRM_MAINNET_SPEND npx tsx --env-file=.env scripts/arc-mainnet-setup.ts   # vault, merchant, agent, first payment
```

Total mainnet cost for deployment, setup and the recorded demo was about 0.13 USDC in gas.

### Deploy

See [`docs/ARC_DEPLOYMENT.md`](docs/ARC_DEPLOYMENT.md). Mainnet spending requires `ARC_MAINNET_CONFIRM=I_CONFIRM_MAINNET_SPEND`, set deliberately for each run.

---

## Repository layout

```
contracts/arc/          Solidity vault, factory, registry, compiled artifacts, deployment records
sdk/                    @velo402/arc-sdk agent SDK
app/                    Next.js web app, x402 API, AI agent, scripts and tests
docs/                   Deployment, security and testnet reports
```

## License

MIT
