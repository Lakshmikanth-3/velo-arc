import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, expect } from '@playwright/test';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, http, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, USDC } from '../src/lib/arc/config';
import { vaultAbi, factoryAbi } from '../src/lib/arc/abi';

// Disposable LOCAL EVM with testnet chain ID. Never evidence of real Arc execution.
test('browser owner creates/funds vault, authorizes agent; agent pays; owner revokes', { timeout: 120000 }, async () => {
  const server = ganache.server({ logging: { quiet: true }, chain: { chainId: arcTestnet.id } });
  await server.listen(18548, '127.0.0.1');
  const rpc = 'http://127.0.0.1:18548';
  const accounts = Object.values(server.provider.getInitialAccounts()).map(a => privateKeyToAccount(a.secretKey as Hex));
  const [owner, agent, recipient] = accounts;
  const p = createPublicClient({ chain: arcTestnet, transport: http(rpc) });
  const wallet = createWalletClient({ account: owner, chain: arcTestnet, transport: http(rpc) });
  const token = JSON.parse(readFileSync('../contracts/arc/artifacts/TestToken.json', 'utf8')) as { abi: Abi; deployedBytecode: Hex };
  const artifact = JSON.parse(readFileSync('../contracts/arc/artifacts/ArcVaultFactory.json', 'utf8')) as { bytecode: Hex };
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.provider.request({ method: 'evm_setAccountCode', params: [USDC, token.deployedBytecode] });
    const mint = await wallet.writeContract({ address: USDC, abi: token.abi, functionName: 'mint', args: [owner.address, 1_000_000n] });
    await p.waitForTransactionReceipt({ hash: mint });
    const hash = await wallet.deployContract({ abi: factoryAbi, bytecode: artifact.bytecode, args: [USDC, '0x0000000000000000000000000000000000000000'] });
    const factory = (await p.waitForTransactionReceipt({ hash })).contractAddress!;
    const require = createRequire(import.meta.url);
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '-p', '13012'], {
      windowsHide: true, stdio: 'ignore', env: { ...process.env, ARC_UI_TEST: '1', NEXT_PUBLIC_ARC_NETWORK: 'testnet', NEXT_PUBLIC_ARC_RPC_URL: rpc, NEXT_PUBLIC_ARC_FACTORY_ADDRESS: factory },
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch('http://localhost:13012/arc', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* Server starting. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'local frontend started');
    browser = await chromium.launch();
    const page = await browser.newPage();
    let selected = owner.address;
    // The local RPC owns disposable unlocked accounts. No private keys enter the browser.
    await page.exposeFunction('localWalletRequest', async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [selected];
      if (method === 'eth_sendTransaction') {
        const tx = (params?.[0] ?? {}) as Record<string, unknown>;
        // Real injected wallets estimate gas. Ganache otherwise defaults to 90k,
        // which is insufficient for factory-created vaults.
        if (!tx.gas) {
          const estimated = await server.provider.request({ method: 'eth_estimateGas', params: [tx] } as Parameters<typeof server.provider.request>[0]);
          tx.gas = `0x${(BigInt(String(estimated)) * 120n / 100n).toString(16)}`;
        }
        params = [tx];
      }
      return server.provider.request({ method, params: params ?? [] } as Parameters<typeof server.provider.request>[0]);
    });
    await page.addInitScript('window.ethereum = { request: (request) => window.localWalletRequest(request) };');
    await page.goto('http://localhost:13012/arc');
    await page.getByRole('button', { name: 'Connect EVM wallet' }).click();
    await expect(page.getByRole('status')).toContainText('Wallet connected');
    await page.getByRole('button', { name: 'Create my vault' }).click();
    await expect(page.getByRole('status')).toContainText('Confirmed', { timeout: 20000 });
    await page.getByRole('button', { name: 'Refresh on-chain state and history' }).click();
    await expect(page.getByRole('status')).toContainText('On-chain state refreshed');
    await page.getByLabel('Deposit / withdrawal / payment amount (USDC)').fill('0.1');
    await page.getByRole('button', { name: 'Approve exact amount and deposit' }).click();
    await expect(page.getByText(/Available: 0.1 USDC/)).toBeVisible({ timeout: 20000 });
    await page.getByLabel('Agent EVM address').fill(agent.address);
    await page.getByLabel('Lifetime total budget (USDC)').fill('0.1');
    await page.getByLabel('Maximum per payment (USDC)').fill('0.01');
    await page.getByLabel('Permitted recipients (comma separated)').fill(recipient.address);
    const expiry = await page.evaluate('(() => { const d = new Date(Date.now() + 3600000); const pad = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; })()');
    await page.getByLabel('Expiry (your local time)').fill(String(expiry));
    await page.getByRole('button', { name: 'Authorize / update' }).click();
    await expect(page.getByText(/Active: true/)).toBeVisible({ timeout: 20000 });
    selected = agent.address;
    await page.getByRole('button', { name: 'Connect EVM wallet' }).click();
    await expect(page.getByRole('status')).toContainText('Wallet connected');
    await page.getByLabel('Deposit / withdrawal / payment amount (USDC)').fill('0.01');
    await page.getByLabel('Payment recipient').fill(recipient.address);
    await page.getByLabel('Unique invoice / payment ID').fill('browser-local-payment');
    await page.getByRole('button', { name: 'Pay USDC' }).click();
    await expect(page.getByText(/Remaining: 0.09 USDC/)).toBeVisible({ timeout: 20000 });
    const vault = await p.readContract({ address: factory, abi: factoryAbi, functionName: 'vaultOf', args: [owner.address] });
    assert.equal((await p.readContract({ address: vault, abi: vaultAbi, functionName: 'capabilities', args: [agent.address] }))[4], 10000n);
    selected = owner.address;
    await page.getByRole('button', { name: 'Connect EVM wallet' }).click();
    await expect(page.getByRole('status')).toContainText('Wallet connected');
    await page.getByRole('button', { name: 'Revoke immediately' }).click();
    await expect(page.getByText(/Active: false/)).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('link', { name: /Revoked · block/ })).toBeVisible();
    selected = agent.address;
    await page.getByRole('button', { name: 'Connect EVM wallet' }).click();
    await expect(page.getByRole('status')).toContainText('Wallet connected');
    await page.getByLabel('Unique invoice / payment ID').fill('browser-revoked');
    await page.getByRole('button', { name: 'Pay USDC' }).click();
    await expect(page.getByRole('status')).toContainText('Unauthorized', { timeout: 20000 });
    await page.screenshot({ path: '../../arc-local-console.png', fullPage: true });
  } finally { await browser?.close(); child?.kill(); await server.close(); }
});
