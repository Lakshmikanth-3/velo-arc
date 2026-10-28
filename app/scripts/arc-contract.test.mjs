import { test } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, defineChain, keccak256, toHex, encodeFunctionData, decodeEventLog, decodeErrorResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifacts } from './arc-compile.mjs';

test('Arc vault: complete flow and enforcement on a local EVM (not Arc evidence)', async t => {
  const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31337 }, wallet: { totalAccounts: 4 } });
  const accounts = Object.values(provider.getInitialAccounts()).map(a => privateKeyToAccount(a.secretKey));
  const chain = defineChain({ id: 31337, name: 'Local EVM', nativeCurrency: { name: 'Local', symbol: 'LOCAL', decimals: 18 }, rpcUrls: { default: { http: ['http://localhost'] } } });
  const publicClient = createPublicClient({ chain, transport: custom(provider) });
  const wallets = accounts.map(account => createWalletClient({ account, chain, transport: custom(provider) }));
  const [owner, agent, recipient, outsider] = accounts;
  const deploy = async (name, args = []) => {
    const hash = await wallets[0].deployContract({ ...artifacts[name], args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };
  const token = await deploy('TestToken');
  const gateway = await deploy('MockGatewayWallet');
  const factory = await deploy('ArcVaultFactory', [token, gateway]);
  const read = (target, name, fn, args = []) => publicClient.readContract({ address: target, abi: artifacts[name].abi, functionName: fn, args });
  const write = async (wallet, target, name, fn, args = []) => {
    const { request } = await publicClient.simulateContract({ account: wallet.account, address: target, abi: artifacts[name].abi, functionName: fn, args });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt;
  };
  const deny = async (wallet, target, name, fn, args, errorName) => {
    // Ganache's custom provider exposes revert bytes on error.data rather than
    // the JSON-RPC wrapper viem expects. Decode the raw revert to assert the reason.
    await assert.rejects(provider.request({ method: 'eth_call', params: [{ from: wallet.account.address, to: target, data: encodeFunctionData({ abi: artifacts[name].abi, functionName: fn, args }) }, 'latest'] }), error => {
      if (errorName) assert.equal(decodeErrorResult({ abi: [...artifacts[name].abi, ...artifacts.ArcVault.abi], data: error.data }).errorName, errorName);
      return true;
    });
  };
  let vault;
  const id = n => keccak256(toHex(String(n)));
  const P = (maxTotal, maxPayment, expiresAt, extra = {}) => ({ maxTotal, maxPayment, maxPerDay: maxTotal, gasAllowance: 0n, expiresAt, useRegistry: false, ...extra });
  const authorize = (maxTotal = 10_000_000n, maxPayment = 3_000_000n, list = [recipient.address], expires = BigInt(Math.floor(Date.now() / 1000) + 3600)) => write(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, P(maxTotal, maxPayment, expires), list]);
  try {
    await t.test('owners can create several vaults; approve and deposit', async () => {
      await write(wallets[0], factory, 'ArcVaultFactory', 'createVault');
      vault = await read(factory, 'ArcVaultFactory', 'vaultOf', [owner.address]);
      assert.equal((await read(vault, 'ArcVault', 'owner')).toLowerCase(), owner.address.toLowerCase());
      await write(wallets[0], factory, 'ArcVaultFactory', 'createVault');
      const all = await read(factory, 'ArcVaultFactory', 'vaultsOf', [owner.address]);
      assert.equal(all.length, 2); assert.equal(all[0], vault); assert.notEqual(all[1], vault);
      await write(wallets[0], token, 'TestToken', 'mint', [owner.address, 20_000_000n]);
      await write(wallets[0], token, 'TestToken', 'approve', [vault, 20_000_000n]);
      await write(wallets[0], vault, 'ArcVault', 'deposit', [12_000_000n]);
      assert.equal(await read(vault, 'ArcVault', 'balance'), 12_000_000n);
    });
    await t.test('valid agent payment emits receipt, consumes budget and rejects duplicate', async () => {
      await authorize();
      const receipt = await write(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 3_000_000n, id(1)]);
      const paid = receipt.logs.filter(l => l.address.toLowerCase() === vault.toLowerCase()).map(l => decodeEventLog({ abi: artifacts.ArcVault.abi, ...l })).find(e => e.eventName === 'Paid');
      assert.equal(paid.args.remainingBudget, 7_000_000n);
      assert.equal(await read(token, 'TestToken', 'balanceOf', [recipient.address]), 3_000_000n);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 1n, id(1)], 'DuplicatePayment');
    });
    await t.test('allowlist, transaction limit, cumulative limit, unauthorized and zero input', async () => {
      await deny(wallets[1], vault, 'ArcVault', 'pay', [outsider.address, 1n, id(2)], 'RecipientDenied');
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 3_000_001n, id(2)], 'PaymentLimit');
      await deny(wallets[3], vault, 'ArcVault', 'pay', [recipient.address, 1n, id(2)], 'Unauthorized');
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 0n, id(2)], 'InvalidInput');
      await write(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 3_000_000n, id(2)]);
      await write(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 3_000_000n, id(3)]);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 2_000_000n, id(4)], 'TotalLimit');
    });
    await t.test('updates preserve spend and invalidate prior recipients; revoke fails closed', async () => {
      await authorize(10_000_000n, 3_000_000n, [outsider.address]);
      assert.equal((await read(vault, 'ArcVault', 'capabilities', [agent.address]))[4], 9_000_000n);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 1n, id(5)], 'RecipientDenied');
      await write(wallets[0], vault, 'ArcVault', 'revoke', [agent.address]);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [outsider.address, 1n, id(5)], 'Unauthorized');
      await deny(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, P(1n, 1n, 9999999999n), [recipient.address]], 'InvalidInput');
    });
    await t.test('withdrawals, insufficient funds, token failure rolls back accounting', async () => {
      await authorize(20_000_000n, 5_000_000n);
      await deny(wallets[1], vault, 'ArcVault', 'withdraw', [1n], 'NotOwner');
      await deny(wallets[3], vault, 'ArcVault', 'revoke', [agent.address], 'NotOwner');
      await deny(wallets[3], vault, 'ArcVault', 'deposit', [1n], 'NotOwner');
      await deny(wallets[3], vault, 'ArcVault', 'authorize', [agent.address, P(1n, 1n, 9999999999n), [recipient.address]], 'NotOwner');
      await deny(wallets[0], vault, 'ArcVault', 'withdraw', [4_000_000n], 'InsufficientFunds');
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 4_000_000n, id(6)], 'InsufficientFunds');
      await write(wallets[0], token, 'TestToken', 'setFail', [true]);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 1n, id(6)]);
      // Broadcast a reverting transaction as well as simulating it.
      const hash = await wallets[1].writeContract({ address: vault, abi: artifacts.ArcVault.abi, functionName: 'pay', args: [recipient.address, 1n, id(6)], gas: 250000n });
      assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'reverted');
      assert.equal(await read(vault, 'ArcVault', 'usedPaymentIds', [agent.address, id(6)]), false);
      assert.equal((await read(vault, 'ArcVault', 'capabilities', [agent.address]))[4], 9_000_000n);
      await write(wallets[0], token, 'TestToken', 'setFail', [false]);
    });
    await t.test('malicious token callback cannot reenter pay or withdrawal', async () => {
      await write(wallets[0], vault, 'ArcVault', 'authorize', [token, P(100n, 100n, 9999999999n), [recipient.address]]);
      await write(wallets[0], token, 'TestToken', 'setCallback', [vault, encodeFunctionData({ abi: artifacts.ArcVault.abi, functionName: 'pay', args: [recipient.address, 1n, id('reentry')] })]);
      await write(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 1n, id(7)]);
      assert.equal(await read(token, 'TestToken', 'reentrySucceeded'), false);
      assert.equal((await read(vault, 'ArcVault', 'capabilities', [token]))[4], 0n);
      await write(wallets[0], token, 'TestToken', 'setCallback', [vault, encodeFunctionData({ abi: artifacts.ArcVault.abi, functionName: 'withdraw', args: [1n] })]);
      await write(wallets[0], vault, 'ArcVault', 'withdraw', [1n]);
      assert.equal(await read(token, 'TestToken', 'reentrySucceeded'), false);
    });
    await t.test('expires at exact boundary and invalid authorizations rejected', async () => {
      const now = (await publicClient.getBlock()).timestamp;
      await authorize(20_000_000n, 5_000_000n, [recipient.address], now + 10n);
      await provider.request({ method: 'evm_increaseTime', params: [11] });
      await provider.request({ method: 'evm_mine', params: [] });
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 1n, id(8)], 'Expired');
      await deny(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, P(20_000_000n, 1n, 9999999999n), []], 'InvalidInput');
      await deny(wallets[0], vault, 'ArcVault', 'authorize', [owner.address, P(20_000_000n, 1n, 9999999999n), [recipient.address]], 'InvalidInput');
    });
    await t.test('daily limit resets each UTC day; gas top-up is bounded and counted', async () => {
      await write(wallets[0], token, 'TestToken', 'mint', [owner.address, 10_000_000n]);
      await write(wallets[0], token, 'TestToken', 'approve', [vault, 10_000_000n]);
      await write(wallets[0], vault, 'ArcVault', 'deposit', [10_000_000n]);
      // Earlier tests spent today; start a fresh UTC day so the daily window is clean.
      await provider.request({ method: 'evm_increaseTime', params: [86400] }); await provider.request({ method: 'evm_mine', params: [] });
      const exp = (await publicClient.getBlock()).timestamp + 5n * 86400n;
      await write(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, P(20_000_000n, 2_000_000n, exp, { maxPerDay: 3_000_000n, gasAllowance: 500_000n }), [recipient.address]]);
      const spent0 = (await read(vault, 'ArcVault', 'capabilities', [agent.address]))[4];
      await write(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 2_000_000n, id('d1')]);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 1_500_000n, id('d2')], 'DailyLimit');
      await write(wallets[1], vault, 'ArcVault', 'topUpGas', [400_000n]);
      await deny(wallets[1], vault, 'ArcVault', 'topUpGas', [200_000n], 'GasLimit');
      await deny(wallets[3], vault, 'ArcVault', 'topUpGas', [1n], 'GasLimit');
      const c = await read(vault, 'ArcVault', 'capabilities', [agent.address]);
      assert.equal(c[4] - spent0, 2_400_000n); assert.equal(c[5], 400_000n);
      assert.equal(await read(vault, 'ArcVault', 'dailyRemaining', [agent.address]), 600_000n);
      await provider.request({ method: 'evm_increaseTime', params: [86400] }); await provider.request({ method: 'evm_mine', params: [] });
      assert.equal(await read(vault, 'ArcVault', 'dailyRemaining', [agent.address]), 3_000_000n);
      await write(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 1_500_000n, id('d2')]);
    });
    await t.test('single recipients can be added and removed; agent may not be its own recipient', async () => {
      await deny(wallets[1], vault, 'ArcVault', 'pay', [outsider.address, 1n, id('r1')], 'RecipientDenied');
      await write(wallets[0], vault, 'ArcVault', 'setRecipient', [agent.address, outsider.address, true]);
      await write(wallets[1], vault, 'ArcVault', 'pay', [outsider.address, 1n, id('r1')]);
      await write(wallets[0], vault, 'ArcVault', 'setRecipient', [agent.address, outsider.address, false]);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [outsider.address, 1n, id('r2')], 'RecipientDenied');
      await deny(wallets[0], vault, 'ArcVault', 'setRecipient', [agent.address, agent.address, true], 'InvalidInput');
      await deny(wallets[1], vault, 'ArcVault', 'setRecipient', [agent.address, outsider.address, true], 'NotOwner');
    });
    await t.test('merchant registry is opt-in and curator-controlled', async () => {
      const registry = await deploy('MerchantRegistry', [owner.address]);
      await write(wallets[0], registry, 'MerchantRegistry', 'setMerchant', [outsider.address, true, 'Data API']);
      await deny(wallets[3], registry, 'MerchantRegistry', 'setMerchant', [wallets[3].account.address, true, 'x'], 'NotCurator');
      await deny(wallets[1], vault, 'ArcVault', 'pay', [outsider.address, 1n, id('g1')], 'RecipientDenied');
      await write(wallets[0], vault, 'ArcVault', 'setRegistry', [registry]);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [outsider.address, 1n, id('g1')], 'RecipientDenied');
      const exp = (await publicClient.getBlock()).timestamp + 3600n;
      await write(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, P(20_000_000n, 2_000_000n, exp, { useRegistry: true }), []]);
      await write(wallets[1], vault, 'ArcVault', 'pay', [outsider.address, 1n, id('g1')]);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 1n, id('g2')], 'RecipientDenied');
      await write(wallets[0], registry, 'MerchantRegistry', 'setMerchant', [outsider.address, false, 'Data API']);
      await deny(wallets[1], vault, 'ArcVault', 'pay', [outsider.address, 1n, id('g3')], 'RecipientDenied');
      await deny(wallets[1], vault, 'ArcVault', 'setRegistry', [registry], 'NotOwner');
      await deny(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, P(20_000_000n, 2_000_000n, exp), []], 'InvalidInput');
      await deny(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, P(20_000_000n, 2_000_000n, exp, { maxPerDay: 1n }), [recipient.address]], 'InvalidInput');
      await deny(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, P(20_000_000n, 2_000_000n, exp, { gasAllowance: 30_000_000n }), [recipient.address]], 'InvalidInput');
    });
    await t.test('Gateway funding is bounded by its allowance, budget and revocation, and credits the agent', async () => {
      assert.equal((await read(vault, 'ArcVault', 'gatewayWallet')).toLowerCase(), gateway.toLowerCase());
      await write(wallets[0], token, 'TestToken', 'mint', [owner.address, 5_000_000n]);
      await write(wallets[0], token, 'TestToken', 'approve', [vault, 5_000_000n]);
      await write(wallets[0], vault, 'ArcVault', 'deposit', [5_000_000n]);
      const spent0 = (await read(vault, 'ArcVault', 'capabilities', [agent.address]))[4];
      const exp = (await publicClient.getBlock()).timestamp + 3600n;
      await write(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, P(spent0 + 2_000_000n, 1_000_000n, exp), [recipient.address]]);
      await deny(wallets[1], vault, 'ArcVault', 'fundGateway', [1n], 'GatewayLimit');
      await deny(wallets[1], vault, 'ArcVault', 'setGatewayAllowance', [agent.address, 1_000_000n], 'NotOwner');
      await deny(wallets[0], vault, 'ArcVault', 'setGatewayAllowance', [outsider.address, 1_000_000n], 'InvalidInput');
      await write(wallets[0], vault, 'ArcVault', 'setGatewayAllowance', [agent.address, 1_000_000n]);
      const before = await read(vault, 'ArcVault', 'balance');
      const receipt = await write(wallets[1], vault, 'ArcVault', 'fundGateway', [600_000n]);
      const funded = receipt.logs.filter(l => l.address.toLowerCase() === vault.toLowerCase()).map(l => decodeEventLog({ abi: artifacts.ArcVault.abi, ...l })).find(e => e.eventName === 'GatewayFunded');
      assert.equal(funded.args.remainingBudget, 1_400_000n);
      assert.equal(await read(gateway, 'MockGatewayWallet', 'availableBalance', [agent.address]), 600_000n);
      assert.equal(before - await read(vault, 'ArcVault', 'balance'), 600_000n);
      assert.equal(await read(token, 'TestToken', 'allowance', [vault, gateway]), 0n);
      await deny(wallets[1], vault, 'ArcVault', 'fundGateway', [500_000n], 'GatewayLimit');
      await deny(wallets[3], vault, 'ArcVault', 'fundGateway', [1n], 'GatewayLimit');
      // Gateway funding shares the lifetime budget with payments: 1.1M paid leaves 300k of budget for 400k of allowance.
      await write(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 1_000_000n, id('gw1')]);
      await write(wallets[1], vault, 'ArcVault', 'pay', [recipient.address, 100_000n, id('gw2')]);
      await deny(wallets[1], vault, 'ArcVault', 'fundGateway', [400_000n], 'TotalLimit');
      await write(wallets[1], vault, 'ArcVault', 'fundGateway', [300_000n]);
      assert.equal(await read(vault, 'ArcVault', 'gatewayFunded', [agent.address]), 900_000n);
      await write(wallets[0], vault, 'ArcVault', 'revoke', [agent.address]);
      await write(wallets[0], vault, 'ArcVault', 'setGatewayAllowance', [agent.address, 5_000_000n]);
      await deny(wallets[1], vault, 'ArcVault', 'fundGateway', [1n], 'Unauthorized');
    });
    await t.test('Gateway funding is disabled when the factory has no Gateway Wallet', async () => {
      const plain = await deploy('ArcVaultFactory', [token, '0x0000000000000000000000000000000000000000']);
      await write(wallets[0], plain, 'ArcVaultFactory', 'createVault');
      const v = await read(plain, 'ArcVaultFactory', 'vaultOf', [owner.address]);
      await deny(wallets[0], v, 'ArcVault', 'setGatewayAllowance', [agent.address, 1n], 'GatewayDisabled');
      await deny(wallets[1], v, 'ArcVault', 'fundGateway', [1n], 'GatewayDisabled');
    });
  } finally { await provider.disconnect(); }
});
