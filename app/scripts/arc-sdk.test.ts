import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, USDC } from '../src/lib/arc/config';
import { factoryAbi, vaultAbi } from '../src/lib/arc/abi';
import { ArcAgent } from '../agent/arc-sdk';

test('Arc SDK reads real local state, submits payment and fails closed after revocation', async () => {
  const server = ganache.server({ logging: { quiet: true }, chain: { chainId: arcTestnet.id } });
  await server.listen(0, '127.0.0.1');
  const port = (server.address() as { port: number }).port;
  const rpc = `http://127.0.0.1:${port}`;
  const accounts = Object.values(server.provider.getInitialAccounts()).map(a => privateKeyToAccount(a.secretKey as Hex));
  const [owner, signer, recipient] = accounts;
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });
  const wallet = createWalletClient({ chain: arcTestnet, account: owner, transport: http(rpc) });
  const load = (name: string) => JSON.parse(readFileSync(`../contracts/arc/artifacts/${name}.json`, 'utf8')) as { abi: Abi; bytecode: Hex; deployedBytecode: Hex };
  try {
    const token = load('TestToken');
    await server.provider.request({ method: 'evm_setAccountCode', params: [USDC, token.deployedBytecode] });
    const write = async (request: Parameters<typeof wallet.writeContract>[0]) => {
      const hash = await wallet.writeContract(request);
      assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success');
    };
    const factoryHash = await wallet.deployContract({ abi: factoryAbi, bytecode: load('ArcVaultFactory').bytecode, args: [USDC, '0x0000000000000000000000000000000000000000'] });
    const factory = (await publicClient.waitForTransactionReceipt({ hash: factoryHash })).contractAddress!;
    await write({ address: factory, abi: factoryAbi, functionName: 'createVault' });
    const vault = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'vaultOf', args: [owner.address] });
    await write({ address: USDC, abi: token.abi, functionName: 'mint', args: [owner.address, 1_000_000n] });
    await write({ address: USDC, abi: token.abi, functionName: 'approve', args: [vault, 1_000_000n] });
    await write({ address: vault, abi: vaultAbi, functionName: 'deposit', args: [1_000_000n] });
    await write({ address: vault, abi: vaultAbi, functionName: 'authorize', args: [signer.address, { maxTotal: 1_000_000n, maxPayment: 100_000n, maxPerDay: 1_000_000n, gasAllowance: 0n, expiresAt: (await publicClient.getBlock()).timestamp + 1000n, useRegistry: false }, [recipient.address]] });
    const sdk = new ArcAgent(signer, vault, 'testnet', rpc);
    assert.equal((await sdk.state()).balance, 1_000_000n);
    const payment = await sdk.pay(recipient.address, '0.01', keccak256(toHex('sdk-invoice')));
    assert.equal(payment.remainingBudget, '990000');
    assert.equal(payment.amountUnits, '10000');
    await assert.rejects(sdk.pay(recipient.address, '0.01', keccak256(toHex('sdk-invoice'))));
    await assert.rejects(sdk.pay(recipient.address, '0.0000001', keccak256(toHex('precision'))));
    await write({ address: vault, abi: vaultAbi, functionName: 'revoke', args: [signer.address] });
    await assert.rejects(sdk.pay(recipient.address, '0.01', keccak256(toHex('revoked'))));
    await assert.rejects(new ArcAgent(signer, vault, 'mainnet', rpc).state(), /RPC chain mismatch/);
    assert.equal((await sdk.state()).spent, 10000n);
  } finally { await server.close(); }
});
