// GatewayBuyer logic with Circle's GatewayClient stubbed: no network, no funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { GatewayBuyer } from '../agent/gateway-buyer';
import type { ArcAgent } from '../agent/arc-sdk';

const key = generatePrivateKey();
const fakeAgent = (funded: string[]) => ({ account: privateKeyToAccount(key), fundGateway: async (amount: string) => { funded.push(amount); return { hash: '0xfund' }; } }) as unknown as ArcAgent;
const stubBalances = (buyer: GatewayBuyer, values: bigint[]) => {
  const client = (buyer as unknown as { client: { getBalances: () => Promise<unknown> } }).client;
  client.getBalances = async () => ({ gateway: { available: values.length > 1 ? values.shift()! : values[0] } });
};

test('refuses a Gateway signer that is not the vault agent', () => {
  const other = privateKeyToAccount(generatePrivateKey());
  assert.throws(() => new GatewayBuyer({ account: other } as unknown as ArcAgent, key, 'testnet', 50_000n, 100_000n), /agent key/);
});

test('does not touch the vault when the Gateway balance covers a purchase at the cap', async () => {
  const funded: string[] = [];
  const buyer = new GatewayBuyer(fakeAgent(funded), key, 'testnet', 50_000n, 100_000n);
  stubBalances(buyer, [50_000n]);
  assert.equal(await buyer.ensureFunds(), null);
  assert.deepEqual(funded, []);
});

test('tops up from the vault and waits until Gateway credits the deposit', async () => {
  const funded: string[] = [];
  const buyer = new GatewayBuyer(fakeAgent(funded), key, 'testnet', 50_000n, 100_000n);
  stubBalances(buyer, [10_000n, 10_000n, 110_000n]);
  assert.equal(await buyer.ensureFunds(30_000), '0xfund');
  assert.deepEqual(funded, ['0.1']);
});

test('reports a deposit that Gateway has not credited in time', async () => {
  const buyer = new GatewayBuyer(fakeAgent([]), key, 'testnet', 50_000n, 100_000n);
  stubBalances(buyer, [0n]);
  await assert.rejects(buyer.ensureFunds(1), /not available yet/);
});
