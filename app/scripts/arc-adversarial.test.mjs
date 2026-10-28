// Compromised-agent proof: assume the agent's key is fully stolen or the AI is prompt-injected.
// The attacker sends arbitrary transactions; the owner's policy must hold after every single one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, defineChain, keccak256, toHex, encodeFunctionData, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifacts } from './arc-compile.mjs';

const ROUNDS = Number(process.env.ARC_FUZZ_ROUNDS ?? 300);
let seed = Number(process.env.ARC_FUZZ_SEED ?? 402);
const rand = n => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };

test(`compromised agent cannot exceed owner policy (${ROUNDS} adversarial rounds, seed ${seed})`, { timeout: 600_000 }, async () => {
  const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31337 }, wallet: { totalAccounts: 5 } });
  const accounts = Object.values(provider.getInitialAccounts()).map(a => privateKeyToAccount(a.secretKey));
  const chain = defineChain({ id: 31337, name: 'Local EVM', nativeCurrency: { name: 'Local', symbol: 'LOCAL', decimals: 18 }, rpcUrls: { default: { http: ['http://localhost'] } } });
  const pc = createPublicClient({ chain, transport: custom(provider) });
  const wallets = accounts.map(account => createWalletClient({ account, chain, transport: custom(provider) }));
  const [owner, agent, allowedA, allowedB, attacker] = accounts;
  // Ganache's receipt status is unreliable via a custom transport; success is judged by emitted events and state.
  const send = async (wallet, to, name, fn, args = []) => {
    try {
      const hash = await wallet.sendTransaction({ to, data: encodeFunctionData({ abi: artifacts[name].abi, functionName: fn, args }), gas: 5_000_000n });
      return await pc.waitForTransactionReceipt({ hash });
    } catch (e) { if (process.env.DBG) console.log('SENDERR', fn, e.shortMessage ?? e.message); return { status: 'reverted', logs: [] }; }
  };
  const read = (to, name, fn, args = []) => pc.readContract({ address: to, abi: artifacts[name].abi, functionName: fn, args });
  const deploy = async (name, args = []) => (await pc.waitForTransactionReceipt({ hash: await wallets[0].deployContract({ ...artifacts[name], args }) })).contractAddress;
  const now = async () => (await pc.getBlock()).timestamp;

  const token = await deploy('TestToken');
  const factory = await deploy('ArcVaultFactory', [token, '0x0000000000000000000000000000000000000000']);
  await send(wallets[0], factory, 'ArcVaultFactory', 'createVault');
  const vault = await read(factory, 'ArcVaultFactory', 'vaultOf', [owner.address]);
  await send(wallets[0], token, 'TestToken', 'mint', [owner.address, 1_000_000_000n]);
  await send(wallets[0], token, 'TestToken', 'approve', [vault, 1_000_000_000n]);
  await send(wallets[0], vault, 'ArcVault', 'deposit', [100_000_000n]);

  // Owner's policy, tracked off-chain as the source of truth the contract must match.
  const policy = { maxTotal: 0n, maxPayment: 0n, maxPerDay: 0n, gasAllowance: 0n, expiresAt: 0n, recipients: new Set(), active: false, spent: 0n, gasSpent: 0n, day: -1n, daySpent: 0n };
  const dayRoom = t => { const d = t / 86400n; const used = d === policy.day ? policy.daySpent : 0n; return policy.maxPerDay > used ? policy.maxPerDay - used : 0n; };
  const record = (t, amount) => { const d = t / 86400n; if (d !== policy.day) { policy.day = d; policy.daySpent = 0n; } policy.daySpent += amount; policy.spent += amount; };
  const used = new Set();
  const authorize = async () => {
    const maxPayment = BigInt(1 + rand(5)) * 1_000_000n;
    const maxTotal = policy.spent + maxPayment * BigInt(1 + rand(4));
    const expiresAt = (await now()) + BigInt(60 + rand(600));
    const maxPerDay = maxPayment * BigInt(1 + rand(3));
    const gasAllowance = BigInt(rand(4)) * 200_000n;
    const list = rand(2) ? [allowedA.address] : [allowedA.address, allowedB.address];
    const r = await send(wallets[0], vault, 'ArcVault', 'authorize', [agent.address, { maxTotal, maxPayment, maxPerDay, gasAllowance, expiresAt, useRegistry: false }, list]);
    assert.ok(r.logs.length > 0, 'owner authorize succeeds');
    Object.assign(policy, { maxTotal, maxPayment, maxPerDay, gasAllowance, expiresAt, recipients: new Set(list), active: true });
  };
  await authorize();

  const stats = { paid: 0, blocked: 0 };
  for (let round = 0; round < ROUNDS; round++) {
    const move = rand(100);
    const ownerBefore = await read(token, 'TestToken', 'balanceOf', [owner.address]);
    if (move < 6) await authorize();
    else if (move < 9) { await send(wallets[0], vault, 'ArcVault', 'revoke', [agent.address]); policy.active = false; }
    else if (move < 14) await provider.request({ method: 'evm_increaseTime', params: [rand(4) ? rand(400) : 86400] }), await provider.request({ method: 'evm_mine', params: [] });
    else if (move < 30) {
      // Agent (or an outsider using the agent's leaked context) tries owner-only escalation.
      const who = rand(2) ? wallets[1] : wallets[4];
      const attempts = [
        ['authorize', [who.account.address, { maxTotal: 10n ** 30n, maxPayment: 10n ** 30n, maxPerDay: 10n ** 30n, gasAllowance: 10n ** 30n, expiresAt: (await now()) + 10n ** 6n, useRegistry: true }, [attacker.address]]],
        ['withdraw', [1n]], ['revoke', [agent.address]], ['deposit', [1n]],
        ['setRecipient', [agent.address, attacker.address, true]], ['setRegistry', [attacker.address]],
      ];
      const [fn, args] = attempts[rand(attempts.length)];
      const capBefore = await read(vault, 'ArcVault', 'capabilities', [who.account.address]);
      const r = await send(who, vault, 'ArcVault', fn, args);
      assert.equal(r.logs.length, 0, `escalation ${fn} must not change state`);
      assert.deepEqual(await read(vault, 'ArcVault', 'capabilities', [who.account.address]), capBefore);
      stats.blocked++;
    } else if (move < 40) {
      // Agent tries to drain through its gas allowance.
      const amount = [0n, 1n, 100_000n, policy.gasAllowance, policy.gasAllowance + 1n, 10n ** 30n][rand(6)];
      const t0 = await now();
      const r = await send(wallets[1], vault, 'ArcVault', 'topUpGas', [amount]);
      const t = await now();
      const topped = r.logs.some(l => { try { return decodeEventLog({ abi: artifacts.ArcVault.abi, ...l }).eventName === 'GasToppedUp'; } catch { return false; } });
      const permitted = policy.active && t0 + 5n < policy.expiresAt && amount > 0n && amount <= policy.gasAllowance - policy.gasSpent
        && amount <= policy.maxTotal - policy.spent && amount <= dayRoom(t) && amount <= await read(vault, 'ArcVault', 'balance') + amount;
      if (topped) { assert.ok(policy.active && amount > 0n && policy.gasSpent + amount <= policy.gasAllowance && amount <= dayRoom(t), `round ${round}: gas top-up escaped policy`); record(t, amount); policy.gasSpent += amount; stats.paid++; }
      else { if (permitted) assert.fail(`round ${round}: valid gas top-up wrongly rejected`); stats.blocked++; }
    } else {
      // Agent tries a payment with attacker-chosen parameters.
      const recipient = [allowedA, allowedB, attacker, agent, owner][rand(5)].address;
      const amount = [0n, 1n, policy.maxPayment, policy.maxPayment + 1n, BigInt(rand(6_000_000)), policy.maxTotal, 10n ** 30n][rand(7)];
      const reuse = used.size && rand(5) === 0;
      const id = reuse ? [...used][rand(used.size)] : keccak256(toHex(`round-${round}`));
      const caller = rand(10) === 0 ? wallets[4] : wallets[1];
      const t = await now();
      const balBefore = await read(vault, 'ArcVault', 'balance');
      const r = await send(caller, vault, 'ArcVault', 'pay', [recipient, amount, id]);
      const tx = await now();
      // Independent model of what the policy permits.
      const permitted = caller === wallets[1] && policy.active && t + 5n < policy.expiresAt && policy.recipients.has(recipient) && amount > 0n
        && !used.has(id) && amount <= policy.maxPayment && amount <= policy.maxTotal - policy.spent && amount <= dayRoom(tx) && amount <= balBefore;
      const paid = r.logs.map(l => { try { return decodeEventLog({ abi: artifacts.ArcVault.abi, ...l }); } catch { return null; } }).find(e => e?.eventName === 'Paid');
      if (paid) {
        assert.ok(caller === wallets[1], 'only the agent can ever pay');
        assert.ok(policy.active && policy.recipients.has(recipient) && amount > 0n && amount <= policy.maxPayment && amount <= dayRoom(tx) && !used.has(id), `round ${round}: payment escaped policy`);
        record(tx, amount); used.add(id); stats.paid++;
        assert.equal(paid.args.amount, amount);
      } else {
        if (permitted) assert.fail(`round ${round}: valid payment wrongly rejected`);
        stats.blocked++;
      }
    }
    // Invariants after every round.
    const c = await read(vault, 'ArcVault', 'capabilities', [agent.address]);
    assert.equal(c[4], policy.spent, 'on-chain spend equals sum of permitted payments and gas top-ups');
    assert.ok(c[4] <= c[0], 'spend never exceeds lifetime budget');
    assert.ok(c[5] <= c[3], 'gas drawn never exceeds gas allowance');
    assert.equal(await read(token, 'TestToken', 'balanceOf', [attacker.address]), 0n, 'attacker never receives funds');
    assert.equal(await read(token, 'TestToken', 'balanceOf', [agent.address]), policy.gasSpent, 'agent receives only its permitted gas top-ups');
    assert.equal(await read(vault, 'ArcVault', 'registry'), '0x0000000000000000000000000000000000000000', 'registry cannot be changed by non-owners');
    assert.ok(await read(token, 'TestToken', 'balanceOf', [owner.address]) >= ownerBefore, 'owner wallet is never drained');
  }
  assert.ok(stats.paid >= 3 && stats.blocked > 50, `coverage: ${JSON.stringify(stats)}`);
  console.log(`adversarial rounds: ${ROUNDS}, permitted payments: ${stats.paid}, blocked attacks: ${stats.blocked}`);
});
