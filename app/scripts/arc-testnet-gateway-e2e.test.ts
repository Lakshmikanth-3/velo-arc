// Circle Gateway end-to-end on Arc testnet: a vault-funded agent pays a real x402 seller through Gateway.
// Fresh owner/agent each run, funded from the testnet owner in .env.arc-testnet. The seller is a local
// Express server using Circle's createGatewayMiddleware against the Gateway testnet facilitator.
// Run: pnpm arc:testnet:gateway
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { createPublicClient, createWalletClient, http, erc20Abi, parseEther, parseEventLogs, BaseError, ContractFunctionRevertedError, type Abi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, USDC, GATEWAY_WALLET } from '../src/lib/arc/config';
import { vaultAbi, factoryAbi } from '../src/lib/arc/abi';
import { ArcAgent, ArcPolicyRejection } from '../agent/arc-sdk';
import { GatewayBuyer } from '../agent/gateway-buyer';

const rpc = http(arcTestnet.rpcUrls.default.http[0], { retryCount: 2 });
const p = createPublicClient({ chain: arcTestnet, transport: rpc });
const funderKey = process.env.ARC_OWNER_PRIVATE_KEY;
const funder = funderKey && /^0x[0-9a-fA-F]{64}$/.test(funderKey) ? privateKeyToAccount(funderKey as `0x${string}`) : undefined;
const owner = privateKeyToAccount(generatePrivateKey());
const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const seller = privateKeyToAccount(generatePrivateKey()).address;
const ownerWallet = createWalletClient({ account: owner, chain: arcTestnet, transport: rpc });
const txs: Record<string, string> = {};
let factory: `0x${string}`, vault: `0x${string}`;

async function send(label: string, hash: `0x${string}`) {
  txs[label] = hash;
  const receipt = await p.waitForTransactionReceipt({ hash, timeout: 90_000 });
  assert.equal(receipt.status, 'success', `${label} reverted`);
  return receipt;
}
async function ownerCall(label: string, address: `0x${string}`, abi: Abi, functionName: string, args: unknown[]) {
  const { request } = await p.simulateContract({ account: owner, address, abi, functionName, args } as never);
  return send(label, await ownerWallet.writeContract(request as never));
}
async function agentRevert(functionName: string, args: unknown[]) {
  try { await p.simulateContract({ account: agent, address: vault, abi: vaultAbi, functionName, args } as never); return 'NO_REVERT'; }
  catch (e) { const r = e instanceof BaseError ? e.walk(x => x instanceof ContractFunctionRevertedError) : undefined; return r instanceof ContractFunctionRevertedError ? r.data?.errorName : 'UNKNOWN'; }
}

test('Arc testnet: vault-funded agent pays an x402 seller through Circle Gateway', { timeout: 1_200_000 }, async t => {
  assert.ok(funder, 'ARC_OWNER_PRIVATE_KEY missing: run pnpm arc:testnet:setup and fund via faucet');
  const app = express();
  const gateway = createGatewayMiddleware({ sellerAddress: seller, networks: 'eip155:5042002', facilitatorUrl: 'https://gateway-api-testnet.circle.com' });
  app.get('/data', gateway.require('$0.01'), (_req, res) => { res.json({ source: 'local x402 seller', paidVia: 'Circle Gateway' }); });
  app.get('/expensive', gateway.require('$0.10'), (_req, res) => { res.json({ never: true }); });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let buyer: GatewayBuyer;

  try {
    await t.test('fund fresh owner and agent with gas', async () => {
      const w = createWalletClient({ account: funder!, chain: arcTestnet, transport: rpc });
      await send('fundOwner', await w.sendTransaction({ to: owner.address, value: parseEther('1.5') }));
      await send('fundAgent', await w.sendTransaction({ to: agent.address, value: parseEther('0.1') }));
    });

    await t.test('deploy a factory wired to the Gateway Wallet, create and fund a vault', async () => {
      const artifact = JSON.parse(readFileSync('../contracts/arc/artifacts/ArcVaultFactory.json', 'utf8')) as { bytecode: `0x${string}` };
      const r = await send('deployFactory', await ownerWallet.deployContract({ abi: factoryAbi, bytecode: artifact.bytecode, args: [USDC, GATEWAY_WALLET.testnet] }));
      factory = r.contractAddress!;
      const created = await ownerCall('createVault', factory, factoryAbi, 'createVault', []);
      vault = parseEventLogs({ abi: factoryAbi, eventName: 'VaultCreated', logs: created.logs })[0].args.vault;
      assert.equal((await p.readContract({ address: vault, abi: vaultAbi, functionName: 'gatewayWallet' })).toLowerCase(), GATEWAY_WALLET.testnet.toLowerCase());
      await ownerCall('approve', USDC, erc20Abi, 'approve', [vault, 1_000_000n]);
      await ownerCall('deposit', vault, vaultAbi, 'deposit', [1_000_000n]);
    });

    await t.test('authorize agent and set a 0.30 USDC Gateway allowance', async () => {
      const expiresAt = (await p.getBlock()).timestamp + 3600n;
      await ownerCall('authorize', vault, vaultAbi, 'authorize', [agent.address, { maxTotal: 500_000n, maxPayment: 50_000n, maxPerDay: 500_000n, gasAllowance: 0n, expiresAt, useRegistry: false }, [owner.address]]);
      assert.equal(await agentRevert('fundGateway', [1n]), 'GatewayLimit');
      await ownerCall('setGatewayAllowance', vault, vaultAbi, 'setGatewayAllowance', [agent.address, 300_000n]);
      const vaultAgent = new ArcAgent(agent, vault, 'testnet');
      buyer = new GatewayBuyer(vaultAgent, agentKey, 'testnet', 50_000n, 200_000n);
    });

    await t.test('agent moves 0.20 USDC from the vault into Gateway; Gateway credits it', async () => {
      const before = await buyer.available();
      const hash = await buyer.ensureFunds(900_000);
      assert.ok(hash, 'expected a vault top-up');
      txs.fundGateway = hash!;
      assert.equal(await p.readContract({ address: vault, abi: vaultAbi, functionName: 'gatewayFunded', args: [agent.address] }), 200_000n);
      assert.ok(await buyer.available() >= before + 200_000n);
    });

    await t.test('agent buys from the x402 seller through Gateway', async () => {
      const r = await buyer.buy(`${base}/data`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { source: 'local x402 seller', paidVia: 'Circle Gateway' });
      assert.equal(r.fundedFromVault, null, 'balance already covered the purchase');
      assert.ok(r.settlement, 'Gateway returned a settlement reference');
      txs.gatewaySettlement = r.settlement;
    });

    await t.test('price above the agent cap is refused before signing', async () => {
      await assert.rejects(buyer.buy(`${base}/expensive`), /above the 0.05 USDC cap|abort/i);
    });

    await t.test('vault refuses Gateway funding beyond the allowance and after revoke', async () => {
      await assert.rejects(new ArcAgent(agent, vault, 'testnet').fundGateway('0.2'), (e: unknown) => e instanceof ArcPolicyRejection && e.reason === 'GatewayLimit');
      await ownerCall('revoke', vault, vaultAbi, 'revoke', [agent.address]);
      await ownerCall('raiseAllowance', vault, vaultAbi, 'setGatewayAllowance', [agent.address, 1_000_000n]);
      assert.equal(await agentRevert('fundGateway', [1n]), 'Unauthorized');
    });
  } finally {
    server.close();
    writeFileSync('../contracts/arc/deployments/5042002-gateway-e2e.json', JSON.stringify({ chainId: 5042002, factory, vault, owner: owner.address, agent: agent.address, seller, gatewayWallet: GATEWAY_WALLET.testnet, transactions: txs, testedAt: new Date().toISOString() }, null, 2));
  }
});
