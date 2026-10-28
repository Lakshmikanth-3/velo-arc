// Mainnet readiness: runs every suite against Arc testnet and the live site, then a read-only mainnet preflight.
// Nothing is sent on mainnet. Run: pnpm arc:ready   (add --quick to skip the slow live browser suites)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, erc20Abi, encodeDeployData, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcMainnet, USDC, GATEWAY_WALLET } from '../src/lib/arc/config';
import { factoryAbi, registryAbi } from '../src/lib/arc/abi';
import deployment from '../src/lib/arc/testnet-deployment.json';

const SITE = process.env.E2E_BASE_URL ?? 'https://velo402.vercel.app';
const quick = process.argv.includes('--quick');
type Result = { name: string; ok: boolean; detail: string; seconds: number };
const results: Result[] = [];
const env = (file: string) => Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const testnetEnv = env('.env.arc-testnet');
const mainEnv = (() => { try { return env('.env'); } catch { return {} as Record<string, string>; } })();

function run(name: string, cmd: string, extra: Record<string, string> = {}, check?: (out: string) => string | null) {
  const t = Date.now();
  process.stdout.write(`- ${name} ... `);
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', env: { ...process.env, ...extra }, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const failed = r.status !== 0 ? `exit ${r.status}: ${out.split('\n').filter(l => /not ok|Error|fail/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)}` : check?.(out) ?? null;
  const pass = out.match(/# pass (\d+)/g)?.map(m => m.slice(7)).join('+');
  results.push({ name, ok: !failed, detail: failed ?? (pass ? `pass ${pass}` : 'ok'), seconds: Math.round((Date.now() - t) / 1000) });
  console.log(failed ? `FAIL (${failed})` : 'PASS');
}
function record(name: string, ok: boolean, detail: string) { results.push({ name, ok, detail, seconds: 0 }); console.log(`- ${name} ... ${ok ? 'PASS' : 'FAIL'} (${detail})`); }

async function main() {
  const T = { ...testnetEnv, ARC_NETWORK: 'testnet', ARC_VAULT_ADDRESS: deployment.vault, X402_BASE_URL: SITE, E2E_BASE_URL: SITE };
  console.log(`Velo402 mainnet readiness · testnet suites against ${SITE}\n`);

  // 1. Code health
  run('TypeScript typecheck', 'npx tsc --noEmit');
  run('Production build', 'pnpm -s build');
  run('Compiled ABI matches contract source', 'pnpm -s arc:compile && git diff --exit-code -- src/lib/arc/abi.ts ../sdk/src/abi.ts');
  run('No secrets tracked in git', 'git ls-files ..', {}, out => {
    const files = out.split('\n').filter(Boolean);
    const envs = files.filter(f => /(^|\/)\.env/.test(f) && !f.endsWith('.env.example'));
    if (envs.length) return `tracked env files: ${envs.join(', ')}`;
    const grep = spawnSync('git grep -nE "gsk_[A-Za-z0-9]{20,}|PRIVATE_KEY=0x[0-9a-fA-F]{64}" -- ..', { shell: true, encoding: 'utf8' });
    return grep.stdout.trim() ? 'key-like value found in tracked files' : null;
  });

  // 2. Contract security (local EVM)
  for (const seed of ['402', '7', '99991']) run(`Contract + attacker tests (seed ${seed})`, 'pnpm -s arc:test', { ARC_FUZZ_SEED: seed });
  run('Browser UI on local chain', 'pnpm -s arc:test:ui');
  run('Every console control and page link (local chain)', 'npx tsx --test scripts/arc-ui-full.test.ts');

  // 3. Real Arc testnet
  run('Testnet end-to-end (real transactions)', 'npx tsx --test scripts/arc-testnet-e2e.test.ts', T);
  run('HTTP 402 API on live site (incl. forged proofs)', 'npx tsx --test scripts/arc-x402.test.ts', T);
  run('AI agent, scripted: prompt injection blocked by vault', 'npx tsx agent/ai-agent.ts --scripted', T, out =>
    /"blockedByVault":true,"reason":"RecipientDenied"/.test(out) && (out.match(/"status":200/g)?.length ?? 0) >= 2 ? null : 'expected 2 purchases and a blocked injected payment');
  run('AI agent, LLM (Groq, key rotation)', 'npx tsx agent/ai-agent.ts', T, out => {
    if (!/\[llm:/.test(out)) return 'LLM run did not complete';
    if ((out.match(/"status":200/g)?.length ?? 0) < 1) return 'no paid purchase';
    if (/"tool":"pay".*"ok":true/.test(out)) return 'LLM made a direct payment it was not asked for';
    return null;
  });
  if (!quick) {
    run('Live site pages and testnet console', 'npx playwright test e2e/arc-live.spec.ts e2e/arc.spec.ts --project=chromium', T, out => /\d+ passed/.test(out) && !/failed/.test(out) ? null : 'playwright failures');
    run('Browser click-through on live site (testnet)', 'npx tsx --test scripts/arc-browser-testnet.test.ts', T);
  }

  // 4. Mainnet preflight (read-only)
  const m = createPublicClient({ chain: arcMainnet, transport: http(arcMainnet.rpcUrls.default.http[0], { timeout: 15000 }) });
  try {
    record('Mainnet RPC is Arc chain 5042', await m.getChainId() === 5042, `chain ${await m.getChainId()}`);
    record('Mainnet USDC has 6 decimals', await m.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' }) === 6, USDC);
    const key = mainEnv.ARC_DEPLOYER_PRIVATE_KEY;
    const deployer = (key && /^0x[0-9a-fA-F]{64}$/.test(key) ? privateKeyToAccount(key as `0x${string}`).address : mainEnv.ARC_DEPLOYER_ADDRESS) as `0x${string}` | undefined;
    record('Mainnet deployer key in app/.env', !!key && !!deployer, deployer ?? 'ARC_DEPLOYER_PRIVATE_KEY missing');
    if (deployer) {
      if (mainEnv.ARC_DEPLOYER_ADDRESS) record('Deployer key matches ARC_DEPLOYER_ADDRESS', deployer.toLowerCase() === mainEnv.ARC_DEPLOYER_ADDRESS.toLowerCase(), deployer);
      const art = (n: string) => JSON.parse(readFileSync(`../contracts/arc/artifacts/${n}.json`, 'utf8')).bytecode as `0x${string}`;
      const gas = await m.estimateGas({ account: deployer, data: encodeDeployData({ abi: factoryAbi, bytecode: art('ArcVaultFactory'), args: [USDC, GATEWAY_WALLET.mainnet] }) })
        + await m.estimateGas({ account: deployer, data: encodeDeployData({ abi: registryAbi, bytecode: art('MerchantRegistry'), args: [deployer] }) })
        + 1_500_000n; // vault, deposit, authorize, payment, revoke, withdraw
      const price = await m.getGasPrice();
      const need = gas * price * 2n; // 2x buffer for gas spikes
      const balance = await m.getBalance({ address: deployer });
      record('Deployer has enough USDC for deploy + demo', balance >= need, `has ${formatUnits(balance, 18)} USDC, needs about ${formatUnits(need, 18)} (gas ${gas} at ${Number(price) / 1e9} gwei, 2x buffer)`);
    }
    record('Mainnet spend lock is off until you approve', mainEnv.ARC_MAINNET_CONFIRM !== 'I_CONFIRM_MAINNET_SPEND', 'ARC_MAINNET_CONFIRM must be set only for the approved run');
  } catch (e) { record('Mainnet preflight', false, e instanceof Error ? e.message.slice(0, 200) : String(e)); }

  const failed = results.filter(r => !r.ok);
  const report = ['# Mainnet readiness report', '', `Run ${new Date().toISOString()} against ${SITE}. Testnet suites use real Arc testnet transactions; mainnet checks are read-only.`, '', '| Check | Result | Detail | Time |', '| --- | --- | --- | --- |',
    ...results.map(r => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.detail.replace(/\|/g, '/')} | ${r.seconds ? `${r.seconds}s` : ''} |`), '',
    failed.length ? `**Not ready: ${failed.length} check(s) failing.**` : '**Ready for mainnet deployment.**', ''].join('\n');
  writeFileSync('../docs/MAINNET_READINESS.md', report);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Report: docs/MAINNET_READINESS.md`);
  process.exitCode = failed.length ? 1 : 0;
}
main();
