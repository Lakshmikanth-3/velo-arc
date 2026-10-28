// HTTP 402 pay-per-request flow against a running app on Arc testnet, including forged and replayed proofs.
// Run: X402_BASE_URL=http://localhost:3000 pnpm arc:testnet:x402
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import deployment from '../src/lib/arc/testnet-deployment.json';
import { ArcAgent, fetchWithPayment, encodePayment, PAYMENT_HEADER } from '../agent/arc-sdk';

const BASE = process.env.X402_BASE_URL ?? 'https://velo402.vercel.app';
const agent = new ArcAgent(privateKeyToAccount(process.env.ARC_AGENT_PRIVATE_KEY as Hex), deployment.vault, 'testnet');
const get = (path: string, proof?: { txHash: Hex; invoice: string }) => fetch(`${BASE}${path}?network=testnet`, { headers: proof ? { [PAYMENT_HEADER]: encodePayment(proof) } : {} });

test('x402: challenge, pay, verify, and reject forged or reused proofs', { timeout: 300_000 }, async t => {
  let proof: { txHash: Hex; invoice: string };
  await t.test('unpaid request gets a 402 challenge with a velo402-vault invoice', async () => {
    const r = await get('/api/x402/arc-stats');
    assert.equal(r.status, 402);
    const c = await r.json();
    assert.equal(c.accepts[0].scheme, 'velo402-vault');
    assert.equal(c.accepts[0].payTo.toLowerCase(), deployment.merchant.toLowerCase());
  });
  await t.test('agent pays from its vault and receives real Arc data', async () => {
    const { response, paid, requirement } = await fetchWithPayment(agent, `${BASE}/api/x402/arc-stats?network=testnet`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.chainId, 5042002);
    assert.ok(Number(body.data.block) > 0);
    proof = { txHash: paid!.hash, invoice: requirement!.invoice };
  });
  await t.test('a proof for one resource cannot unlock another', async () => {
    assert.equal((await get('/api/x402/untrusted-article', proof)).status, 402);
  });
  await t.test('a tampered invoice is rejected', async () => {
    assert.equal((await get('/api/x402/arc-stats', { ...proof, invoice: proof.invoice.replace(/:[0-9a-f-]{36}:/, ':00000000-0000-0000-0000-000000000000:') })).status, 402);
  });
  await t.test('a transaction that is not a vault payment to the merchant is rejected', async () => {
    const other = deployment.deploymentHash as Hex;
    assert.equal((await get('/api/x402/arc-stats', { txHash: other, invoice: proof.invoice })).status, 402);
  });
  await t.test('malformed proofs are rejected', async () => {
    const r = await fetch(`${BASE}/api/x402/arc-stats?network=testnet`, { headers: { [PAYMENT_HEADER]: 'not-base64-json' } });
    assert.equal(r.status, 400);
  });
});
