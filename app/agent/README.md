# Velo402 agents on Arc

Scripts that run an AI agent against a Velo402 vault on Arc, and alert the owner about what it does. The agent holds its own key, but the vault contract decides every payment, so a manipulated agent still cannot spend outside the owner's policy.

The SDK they use is [`sdk/`](../../sdk) (re-exported by [`arc-sdk.ts`](arc-sdk.ts)).

| Script | Command | What it does |
| --- | --- | --- |
| [`arc-runner.ts`](arc-runner.ts) | `pnpm arc:agent` | Prints the agent's vault state (budget, daily remaining, expiry). Add `--execute` to make a payment. |
| [`ai-agent.ts`](ai-agent.ts) | `pnpm arc:ai-agent` | An LLM agent that buys data from the HTTP 402 API, paying from the vault. One paid resource contains a prompt injection; the vault rejects the injected payment either way. |
| [`watch.ts`](watch.ts) | `pnpm arc:watch` | Owner side: polls the vault and forwards every `Paid`, `GasToppedUp` and `Revoked` event to the alert channels. |
| [`alerts.ts`](alerts.ts) | (library) | Sends alerts to a generic webhook (Discord, Slack, Zapier) and/or Telegram. |

## Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `ARC_NETWORK` | all | `mainnet` or `testnet`. Defaults: runner `mainnet`, AI agent and watcher `testnet`; set it explicitly. |
| `ARC_AGENT_PRIVATE_KEY` | runner, AI agent | A dedicated agent key, never the owner's |
| `ARC_VAULT_ADDRESS` | all | The vault that authorized this agent |
| `ARC_RPC_URL` | runner | Optional RPC override |
| `X402_BASE_URL` | AI agent | Base URL of the HTTP 402 API, e.g. `https://velo402.vercel.app` |
| `LLM_BASE_URL`, `LLM_API_KEYS`, `LLM_MODEL` | AI agent | Any OpenAI-compatible API (Groq by default; Ollama locally). Without them, run with `--scripted`. |
| `ALERT_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | watcher | All optional |

## Example

```bash
ARC_NETWORK=mainnet ARC_VAULT_ADDRESS=0x... ARC_AGENT_PRIVATE_KEY=0x... \
X402_BASE_URL=https://velo402.vercel.app pnpm arc:ai-agent --scripted
```

The mainnet run recorded in the main README is in [`contracts/arc/deployments/5042-ai-agent-run.log`](../../contracts/arc/deployments/5042-ai-agent-run.log).
