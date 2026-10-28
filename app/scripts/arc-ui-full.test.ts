// Every console control, driven through the real UI against a local EVM with Arc USDC at its real address.
// Also crawls every page and checks every internal link and API route the frontend uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, expect, type Page } from '@playwright/test';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, http, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, USDC } from '../src/lib/arc/config';
import { vaultAbi, factoryAbi, registryAbi } from '../src/lib/arc/abi';
import { toCapability } from '../src/lib/arc/capability';

const PORT = 13013;
test('frontend: every control and link works end to end', { timeout: 300_000 }, async t => {
  const server = ganache.server({ logging: { quiet: true }, chain: { chainId: arcTestnet.id } });
  await server.listen(18549, '127.0.0.1');
  const rpc = 'http://127.0.0.1:18549';
  const [owner, agent, merchant, stranger] = Object.values(server.provider.getInitialAccounts()).map(a => privateKeyToAccount(a.secretKey as Hex));
  const p = createPublicClient({ chain: arcTestnet, transport: http(rpc) });
  const wallet = createWalletClient({ account: owner, chain: arcTestnet, transport: http(rpc) });
  const art = (n: string) => JSON.parse(readFileSync(`../contracts/arc/artifacts/${n}.json`, 'utf8')) as { abi: Abi; bytecode: Hex; deployedBytecode: Hex };
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.provider.request({ method: 'evm_setAccountCode', params: [USDC, art('TestToken').deployedBytecode] });
    await p.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: USDC, abi: art('TestToken').abi, functionName: 'mint', args: [owner.address, 5_000_000n] }) });
    const factory = (await p.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: factoryAbi, bytecode: art('ArcVaultFactory').bytecode, args: [USDC, '0x0000000000000000000000000000000000000000'] }) })).contractAddress!;
    const registry = (await p.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: registryAbi, bytecode: art('MerchantRegistry').bytecode, args: [owner.address] }) })).contractAddress!;
    await p.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'setMerchant', args: [merchant.address, true, 'Test merchant'] }) });

    const require = createRequire(import.meta.url);
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '-p', String(PORT)], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ARC_UI_TEST: '1', NEXT_PUBLIC_ARC_NETWORK: 'testnet', NEXT_PUBLIC_ARC_RPC_URL: rpc, NEXT_PUBLIC_ARC_FACTORY_ADDRESS: factory } });
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://localhost:${PORT}/arc`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 500)); }
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    let selected = owner.address;
    await page.exposeFunction('localWalletRequest', async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [selected];
      if (method === 'eth_sendTransaction') {
        const tx = (params?.[0] ?? {}) as Record<string, unknown>;
        if (!tx.gas) tx.gas = `0x${(BigInt(String(await server.provider.request({ method: 'eth_estimateGas', params: [tx] } as never))) * 130n / 100n).toString(16)}`;
        params = [tx];
      }
      return server.provider.request({ method, params: params ?? [] } as never);
    });
    await page.addInitScript('window.ethereum = { request: (r) => window.localWalletRequest(r), on() {}, removeListener() {} };');
    const status = page.getByRole('status');
    const click = async (name: string) => page.getByRole('button', { name, exact: true }).click();
    const done = async (text: string | RegExp = 'Confirmed') => expect(status).toContainText(text, { timeout: 30_000 });
    const fill = (label: string, v: string) => page.getByLabel(label, { exact: true }).fill(v);
    const connect = async (who: `0x${string}`) => { selected = who; await click('Connect EVM wallet'); await done('Wallet connected'); };
    const cap = async (vault: `0x${string}`) => toCapability(await p.readContract({ address: vault, abi: vaultAbi, functionName: 'capabilities', args: [agent.address] }));
    let vault: `0x${string}`;

    await t.test('pages render and every internal link resolves', async () => {
      for (const path of ['/', '/arc', '/testnet', '/infrastructure', '/security', '/developers']) {
        const res = await page.goto(`http://localhost:${PORT}${path}`);
        assert.equal(res?.status(), 200, path);
        const hrefs = await page.$$eval('a[href^="/"]', as => [...new Set(as.map(a => (a as HTMLAnchorElement).getAttribute('href')!.split('#')[0]))]);
        for (const h of hrefs) assert.equal((await fetch(`http://localhost:${PORT}${h || '/'}`)).status, 200, `${path} -> ${h}`);
      }
      assert.equal((await fetch(`http://localhost:${PORT}/api/x402/arc-stats`)).status, 402, 'x402 API reachable');
      assert.equal((await fetch(`http://localhost:${PORT}/api/x402/nope`)).status, 404);
      // Phone layout: the sidebar collapses into a menu button that opens and closes navigation.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`http://localhost:${PORT}/arc`);
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('link', { name: 'Security proof' }).first().click();
      await expect(page).toHaveURL(/\/security$/);
      await page.setViewportSize({ width: 1440, height: 1000 });
    });

    await t.test('connect, disabled-state hints, create two vaults, vault picker', async () => {
      await page.goto(`http://localhost:${PORT}/arc`);
      await expect(page.getByText('Connect your wallet in step 01 first.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create my vault' })).toBeDisabled();
      await connect(owner.address);
      await click('Create my vault'); await done();
      await click('Create my vault'); await done();
      const all = await p.readContract({ address: factory, abi: factoryAbi, functionName: 'vaultsOf', args: [owner.address] });
      assert.equal(all.length, 2);
      await expect(page.getByLabel('My vaults')).toBeVisible();
      await page.getByLabel('My vaults').selectOption(all[0]);
      vault = all[0];
      await click('Refresh on-chain state and history'); await done('On-chain state refreshed');
      await expect(page.locator('.arc-info-list').first()).toContainText(owner.address);
    });

    await t.test('deposit and withdraw', async () => {
      await fill('Deposit / withdrawal / payment amount (USDC)', '1'); await click('Approve exact amount and deposit');
      await expect(page.getByText(/Available: 1 USDC/)).toBeVisible({ timeout: 30_000 });
      await fill('Deposit / withdrawal / payment amount (USDC)', '0.2'); await click('Withdraw to owner');
      await expect(page.getByText(/Available: 0.8 USDC/)).toBeVisible({ timeout: 30_000 });
    });

    await t.test('policy template fills limits; authorize sets every field on-chain', async () => {
      await page.getByLabel('Policy template').selectOption('API agent');
      await expect(page.getByLabel('Lifetime total budget (USDC)')).toHaveValue('5');
      await expect(page.getByLabel('Daily limit (USDC)')).toHaveValue('1');
      await fill('Agent EVM address', agent.address);
      await fill('Lifetime total budget (USDC)', '0.5'); await fill('Maximum per payment (USDC)', '0.1');
      await fill('Daily limit (USDC)', '0.3'); await fill('Gas allowance (USDC)', '0.05');
      await fill('Permitted recipients (comma separated)', owner.address);
      await click('Authorize / update');
      await expect(page.getByText(/Active: true/)).toBeVisible({ timeout: 30_000 });
      const c = await cap(vault);
      assert.deepEqual([c.maxTotal, c.maxPayment, c.maxPerDay, c.gasAllowance, c.useRegistry], [500_000n, 100_000n, 300_000n, 50_000n, false]);
    });

    await t.test('allow and remove a single recipient; set merchant registry', async () => {
      await fill('Single recipient address', stranger.address); await click('Allow recipient'); await done();
      assert.equal(await p.readContract({ address: vault, abi: vaultAbi, functionName: 'allowed', args: [agent.address, stranger.address] }), true);
      await click('Remove recipient'); await done();
      assert.equal(await p.readContract({ address: vault, abi: vaultAbi, functionName: 'allowed', args: [agent.address, stranger.address] }), false);
      await fill('Merchant registry address', registry); await click('Set merchant registry'); await done();
      assert.equal((await p.readContract({ address: vault, abi: vaultAbi, functionName: 'registry' })).toLowerCase(), registry.toLowerCase());
      await page.getByLabel(/Also allow merchants approved/).check(); await click('Authorize / update'); await done();
      assert.equal((await cap(vault)).useRegistry, true);
      assert.equal(await p.readContract({ address: vault, abi: vaultAbi, functionName: 'allowed', args: [agent.address, merchant.address] }), true);
    });

    await t.test('agent pays with auto invoice ID, pays registry merchant, draws gas; rejections show reasons', async () => {
      await connect(agent.address);
      await fill('Deposit / withdrawal / payment amount (USDC)', '0.1'); await fill('Payment recipient', owner.address); await fill('Unique invoice / payment ID', '');
      await click('Pay USDC'); await done();
      await expect(page.getByLabel('Unique invoice / payment ID')).toHaveValue(/^inv-/);
      await fill('Unique invoice / payment ID', ''); await fill('Payment recipient', merchant.address); await click('Pay USDC'); await done();
      await fill('Deposit / withdrawal / payment amount (USDC)', '0.05'); await click('Draw gas from allowance'); await done();
      assert.equal((await cap(vault)).gasSpent, 50_000n);
      await click('Draw gas from allowance'); await done(/gas allowance/);
      await fill('Deposit / withdrawal / payment amount (USDC)', '0.2'); await fill('Unique invoice / payment ID', 'x1'); await click('Pay USDC'); await done(/per-payment limit/);
      await fill('Deposit / withdrawal / payment amount (USDC)', '0.1'); await fill('Unique invoice / payment ID', 'x2'); await click('Pay USDC'); await done(/daily limit/);
      await fill('Payment recipient', stranger.address); await fill('Unique invoice / payment ID', 'x3'); await click('Pay USDC'); await done(/recipient is not permitted/);
      assert.equal((await cap(vault)).spent, 250_000n);
    });

    await t.test('dashboard, history and live alerts', async () => {
      await click('Refresh on-chain state and history'); await done('On-chain state refreshed');
      const dash = page.locator('#arc-dashboard');
      await expect(dash).toContainText('By agent'); await expect(dash).toContainText('Agent gas');
      for (const ev of ['Funded', 'Authorized', 'RecipientSet', 'RegistrySet', 'Paid', 'GasToppedUp', 'Withdrawn']) await expect(page.locator('#arc-history')).toContainText(ev);
      // An event created outside the page shows up as a live alert.
      const w = createWalletClient({ account: owner, chain: arcTestnet, transport: http(rpc) });
      await p.waitForTransactionReceipt({ hash: await w.writeContract({ address: vault, abi: vaultAbi, functionName: 'revoke', args: [agent.address] }) });
      await expect(page.locator('.arc-alerts')).toContainText('Revoked', { timeout: 30_000 });
      await click('Clear'); await expect(page.locator('.arc-alerts')).toHaveCount(0);
    });

    await t.test('owner revoke button and refused payment', async () => {
      await connect(owner.address);
      await click('Authorize / update'); await expect(page.getByText(/Active: true/)).toBeVisible({ timeout: 30_000 });
      await click('Revoke immediately'); await expect(page.getByText(/Active: false/)).toBeVisible({ timeout: 30_000 });
      await connect(agent.address);
      await fill('Payment recipient', owner.address); await fill('Deposit / withdrawal / payment amount (USDC)', '0.01'); await fill('Unique invoice / payment ID', 'after-revoke');
      await click('Pay USDC'); await done('Unauthorized');
    });

    await t.test('no browser errors', () => { assert.deepEqual(errors, []); });
  } finally { await browser?.close(); child?.kill(); await server.close(); }
});
