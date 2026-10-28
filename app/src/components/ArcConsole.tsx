'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowUpRight, BarChart3, Bell, Info, History, LockKeyhole, Send, ShieldCheck, Wallet } from 'lucide-react';
import { createPublicClient, createWalletClient, custom, http, erc20Abi, decodeEventLog, keccak256, toHex, type Address, type EIP1193Provider, type Hash, type Hex } from 'viem';
import { network, USDC, address, usdcAmount, displayUsdc } from '@/lib/arc/config';
import { vaultAbi, factoryAbi } from '@/lib/arc/abi';
import { toCapability, dailyRemaining, type Capability } from '@/lib/arc/capability';
import { paymentError } from '@/lib/arc/errors';
import { templates } from '@/lib/arc/templates';

type Injected = EIP1193Provider & { on?: (event: string, listener: () => void) => void; removeListener?: (event: string, listener: () => void) => void };
type Announced = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Injected };
type Row = { hash: Hash; event: string; block: bigint; detail: string; args: Record<string, unknown> };
const short = (a: unknown) => typeof a === 'string' ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const usdc = (v: unknown) => `${displayUsdc(BigInt(v as bigint))} USDC`;
function describeEvent(name: string, a: Record<string, unknown>) {
  switch (name) {
    case 'Funded': return `${short(a.sender)} deposited ${usdc(a.amount)}`;
    case 'Authorized': return `Agent ${short(a.agent)} may spend ${usdc(a.maxTotal)} total, ${usdc(a.maxPayment)} per payment, ${usdc(a.maxPerDay)} per day, until ${new Date(Number(a.expiresAt) * 1000).toLocaleString()} · ${(a.recipients as unknown[]).length} recipient(s)${a.useRegistry ? ' + merchant registry' : ''}`;
    case 'RecipientSet': return `${a.allowed ? 'Allowed' : 'Removed'} recipient ${short(a.recipient)} for agent ${short(a.agent)}`;
    case 'RegistrySet': return `Merchant registry set to ${short(a.registry)}`;
    case 'Paid': return `Agent ${short(a.agent)} paid ${usdc(a.amount)} to ${short(a.recipient)} · ${usdc(a.remainingBudget)} budget left`;
    case 'GasToppedUp': return `Agent ${short(a.agent)} drew ${usdc(a.amount)} for gas · ${usdc(a.remainingBudget)} budget left`;
    case 'Revoked': return `Agent ${short(a.agent)} revoked`;
    case 'Withdrawn': return `${usdc(a.amount)} withdrawn to owner ${short(a.recipient)}`;
    case 'GatewayAllowanceSet': return `Agent ${short(a.agent)} may move up to ${usdc(a.allowance)} into Circle Gateway`;
    case 'GatewayFunded': return `Agent ${short(a.agent)} moved ${usdc(a.amount)} into its Circle Gateway balance · ${usdc(a.remainingBudget)} budget left`;
    default: return name;
  }
}
const newInvoiceId = () => `inv-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;

export default function ArcConsole({ networkName, rpcUrl, factoryAddress = '', initialVault = '', initialAgent = '' }: { networkName: 'mainnet' | 'testnet'; rpcUrl?: string; factoryAddress?: string; initialVault?: string; initialAgent?: string }) {
  const chain = network(networkName);
  const rpc = rpcUrl ?? chain.rpcUrls.default.http[0];
  const client = useMemo(() => createPublicClient({ chain, transport: http(rpc, { retryCount: 0, timeout: 15000 }) }), [chain, rpc]);
  const [wallets, setWallets] = useState<Announced[]>([]);
  const [walletId, setWalletId] = useState('');
  const [factoryText, setFactoryText] = useState(factoryAddress);
  const [account, setAccount] = useState<Address>();
  const [connectedChain, setConnectedChain] = useState<number>();
  const [vault, setVault] = useState(initialVault);
  const [myVaults, setMyVaults] = useState<readonly Address[]>([]);
  const [agent, setAgent] = useState(initialAgent);
  const [recipient, setRecipient] = useState('');
  const [recipients, setRecipients] = useState('');
  const [single, setSingle] = useState('');
  const [total, setTotal] = useState('1');
  const [perPayment, setPerPayment] = useState('0.1');
  const [perDay, setPerDay] = useState('');
  const [gas, setGas] = useState('0');
  const [gatewayCap, setGatewayCap] = useState('0');
  // undefined: vault predates Gateway funding; enabled=false: deployed without a Gateway Wallet.
  const [gateway, setGateway] = useState<{ enabled: boolean; allowance?: bigint; funded?: bigint }>();
  const [useRegistry, setUseRegistry] = useState(false);
  const [registryText, setRegistryText] = useState('');
  const [expires, setExpires] = useState('');
  const [amount, setAmount] = useState('0.01');
  const [paymentId, setPaymentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Connect an EVM wallet to begin.');
  const [hash, setHash] = useState<Hash>();
  const [balance, setBalance] = useState<bigint>();
  const [owner, setOwner] = useState<Address>();
  const [policy, setPolicy] = useState<Capability>();
  const [now, setNow] = useState(0n);
  const [history, setHistory] = useState<Row[]>([]);
  const [historyFrom, setHistoryFrom] = useState<bigint>();
  const [alerts, setAlerts] = useState<string[]>([]);
  const seen = useRef<Set<string>>(new Set());

  // EIP-6963: discover every installed wallet, not only window.ethereum.
  useEffect(() => {
    const onAnnounce = (e: Event) => { const d = (e as CustomEvent<Announced>).detail; setWallets(w => w.some(x => x.info.uuid === d.info.uuid) ? w : [...w, d]); };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
  }, []);
  const provider = (): Injected | undefined => wallets.find(w => w.info.uuid === walletId)?.provider ?? (window as unknown as { ethereum?: Injected }).ethereum;
  useEffect(() => {
    const p = provider();
    const reset = () => { setAccount(undefined); setConnectedChain(undefined); setOwner(undefined); setVault(''); setBalance(undefined); setPolicy(undefined); setHistory([]); setHash(undefined); setMessage('Wallet changed. Reconnect to refresh account and network.'); };
    p?.on?.('accountsChanged', reset);
    p?.on?.('chainChanged', reset);
    return () => { p?.removeListener?.('accountsChanged', reset); p?.removeListener?.('chainChanged', reset); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId, wallets.length]);
  // Live in-app alerts: poll the vault while a vault is loaded.
  useEffect(() => {
    if (!vault || historyFrom === undefined) return;
    const t = setInterval(() => { void loadLogs(undefined, true).catch(() => {}); }, 15000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, historyFrom]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setHash(undefined); setMessage('Working… confirm any transaction in your wallet.');
    try { await action(); } catch (error) { setMessage(paymentError(error)); }
    finally { setBusy(false); }
  }
  async function signer() {
    const p = provider();
    if (!p || !account) throw new Error('Connect an injected EVM wallet');
    const wallet = createWalletClient({ chain, transport: custom(p) });
    const [current] = await wallet.getAddresses();
    if (current?.toLowerCase() !== account.toLowerCase()) throw new Error('Wallet account changed; reconnect');
    if (await wallet.getChainId() !== chain.id) throw new Error(`Switch wallet to ${chain.name} (${chain.id})`);
    if (await client.getChainId() !== chain.id) throw new Error('RPC network mismatch');
    return wallet;
  }
  async function validateVault() {
    const v = address(vault);
    if (!await client.getBytecode({ address: v })) throw new Error('Vault has no deployed bytecode');
    const token = await client.readContract({ address: v, abi: vaultAbi, functionName: 'usdc' });
    if (token.toLowerCase() !== USDC.toLowerCase()) throw new Error('Vault token is not Arc USDC');
    if (await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' }) !== 6) throw new Error('USDC decimal mismatch');
    return v;
  }
  async function confirmed(tx: Hash) {
    setHash(tx); setMessage('Transaction submitted; waiting for confirmation…');
    const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: 90000 });
    if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${tx}`);
    setMessage(`Confirmed in block ${receipt.blockNumber}`);
  }
  // Public RPCs occasionally fail or lag a block right after a confirmation; retry before reporting.
  async function refresh(before?: bigint) {
    for (let attempt = 0; ; attempt++) {
      try { return await refreshOnce(before); }
      catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 2500)); }
    }
  }
  async function refreshOnce(before?: bigint) {
    const v = await validateVault();
    const [b, o, block] = await Promise.all([client.readContract({ address: v, abi: vaultAbi, functionName: 'balance' }), client.readContract({ address: v, abi: vaultAbi, functionName: 'owner' }), client.getBlock()]);
    setBalance(b); setOwner(o); setNow(block.timestamp);
    if (agent) setPolicy(toCapability(await client.readContract({ address: v, abi: vaultAbi, functionName: 'capabilities', args: [address(agent)] })));
    await loadGateway(v);
    await loadLogs(before);
  }
  async function loadGateway(v: Address) {
    let wallet: Address;
    try { wallet = await client.readContract({ address: v, abi: vaultAbi, functionName: 'gatewayWallet' }); }
    catch { setGateway(undefined); return; }
    const enabled = wallet !== '0x0000000000000000000000000000000000000000';
    if (!enabled || !agent) { setGateway({ enabled }); return; }
    const [allowance, funded] = await Promise.all([
      client.readContract({ address: v, abi: vaultAbi, functionName: 'gatewayAllowance', args: [address(agent)] }),
      client.readContract({ address: v, abi: vaultAbi, functionName: 'gatewayFunded', args: [address(agent)] }),
    ]);
    setGateway({ enabled, allowance, funded });
  }
  const toRow = (l: { transactionHash: Hash; blockNumber: bigint; eventName: string; args: unknown }): Row => ({ hash: l.transactionHash, block: l.blockNumber, event: l.eventName, args: l.args as Record<string, unknown>, detail: describeEvent(l.eventName, l.args as Record<string, unknown>) });
  // RPC log reads, with the Arc explorer (Blockscout) API as a fallback indexer.
  async function loadLogs(before?: bigint, live = false) {
    const v = address(vault);
    const latest = before ?? await client.getBlockNumber({ cacheTime: 0 });
    const start = latest > 19999n ? latest - 19999n : 0n;
    let rows: Row[];
    try {
      const logs = [];
      for (let from = start; from <= latest; from += 5000n) {
        const to = from + 4999n < latest ? from + 4999n : latest;
        logs.push(...await client.getContractEvents({ address: v, abi: vaultAbi, fromBlock: from, toBlock: to }));
      }
      rows = logs.reverse().map(toRow);
    } catch {
      const res = await fetch(`${chain.blockExplorers.default.url}/api/v2/addresses/${v}/logs`);
      if (!res.ok) throw new Error('History unavailable from RPC and explorer');
      const items = (await res.json()).items as { transaction_hash: Hash; block_number: number; topics: (Hex | null)[]; data: Hex }[];
      rows = items.flatMap(i => { try { const d = decodeEventLog({ abi: vaultAbi, topics: i.topics.filter(Boolean) as [Hex, ...Hex[]], data: i.data }); return [toRow({ transactionHash: i.transaction_hash, blockNumber: BigInt(i.block_number), eventName: d.eventName, args: d.args })]; } catch { return []; } });
    }
    const fresh = rows.filter(r => !seen.current.has(`${r.hash}${r.event}`));
    fresh.forEach(r => seen.current.add(`${r.hash}${r.event}`));
    if (live && fresh.length) { setAlerts(a => [...fresh.map(r => `${r.event}: ${r.detail}`), ...a].slice(0, 6)); setHistory(h => [...fresh, ...h]); return; }
    if (!live) { setHistory(old => before === undefined ? rows : [...old, ...rows]); setHistoryFrom(start); }
  }
  async function write(fn: string, args: readonly unknown[], to?: Address) {
    const wallet = await signer();
    const { request } = await client.simulateContract({ account: account!, address: to ?? await validateVault(), abi: vaultAbi, functionName: fn, args } as never);
    await confirmed(await wallet.writeContract(request as never)); await refresh();
  }
  async function mutate(fn: 'deposit' | 'withdraw' | 'revoke' | 'authorize' | 'pay' | 'topUpGas' | 'fundGateway') {
    const v = await validateVault();
    if (fn === 'deposit') {
      const wallet = await signer(); const units = usdcAmount(amount);
      const { request } = await client.simulateContract({ account: account!, address: USDC, abi: erc20Abi, functionName: 'approve', args: [v, units] });
      await confirmed(await wallet.writeContract(request));
      return write('deposit', [units], v);
    }
    if (fn === 'withdraw' || fn === 'topUpGas' || fn === 'fundGateway') return write(fn, [usdcAmount(amount)], v);
    if (fn === 'revoke') return write(fn, [address(agent)], v);
    if (fn === 'authorize') {
      const seconds = Math.floor(Date.parse(expires) / 1000);
      if (!Number.isFinite(seconds) || seconds <= Date.now() / 1000) throw new Error('Choose a future expiry');
      const list = recipients.split(',').map(a => a.trim()).filter(Boolean).map(a => address(a));
      const p = { maxTotal: usdcAmount(total), maxPayment: usdcAmount(perPayment), maxPerDay: usdcAmount(perDay || total), gasAllowance: usdcAmount(gas || '0', true), expiresAt: BigInt(seconds), useRegistry };
      return write(fn, [address(agent), p, list], v);
    }
    const id = paymentId.trim() || newInvoiceId(); setPaymentId(id);
    return write('pay', [address(recipient), usdcAmount(amount), keccak256(toHex(id))], v);
  }
  function applyTemplate(name: string) {
    const t = templates.find(x => x.name === name); if (!t) return;
    setTotal(t.total); setPerPayment(t.perPayment); setPerDay(t.perDay); setGas(t.gas);
    const d = new Date(Date.now() + t.hours * 3600000); const pad = (n: number) => String(n).padStart(2, '0');
    setExpires(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    setMessage(`Template applied: ${t.name}. Add recipients, then authorize.`);
  }
  // Dashboard aggregates from loaded events.
  const stats = useMemo(() => {
    const byAgent = new Map<string, bigint>(), byRecipient = new Map<string, bigint>();
    const agents = new Set<string>();
    for (const r of history) {
      if (r.event === 'Authorized') agents.add(String(r.args.agent));
      if (r.event !== 'Paid' && r.event !== 'GasToppedUp' && r.event !== 'GatewayFunded') continue;
      const a = String(r.args.agent), amt = BigInt(r.args.amount as bigint);
      byAgent.set(a, (byAgent.get(a) ?? 0n) + amt);
      const to = r.event === 'Paid' ? String(r.args.recipient) : r.event === 'GatewayFunded' ? 'gateway' : 'gas';
      byRecipient.set(to, (byRecipient.get(to) ?? 0n) + amt);
    }
    return { byAgent, byRecipient, agents: [...agents] };
  }, [history]);
  const bars = (m: Map<string, bigint>, label: (k: string) => string) => { const max = [...m.values()].reduce((a, b) => a > b ? a : b, 1n); return [...m.entries()].map(([k, v]) => <div key={k} className="arc-bar-row"><span>{label(k)}</span><div className="arc-bar"><i style={{ width: `${Number(v * 100n / max)}%` }} /></div><b>{displayUsdc(v)}</b></div>); };

  const isOwner = !!account && !!owner && account.toLowerCase() === owner.toLowerCase();
  const wrongChain = !!account && connectedChain !== chain.id;
  const field = (label: string, value: string, set: (s: string) => void, type = 'text', hint?: string) => <label className="arc-field">{label}<input type={type} value={value} onChange={e => set(e.target.value)} placeholder={hint ?? (type === 'text' && label.toLowerCase().includes('address') ? '0x…' : undefined)} autoComplete="off" spellCheck={false} /></label>;
  const button = (label: string, action: () => Promise<void>, disabled = false, variant = '') => <button className={`btn ${variant}`} disabled={busy || disabled} onClick={() => void run(action)}>{label}</button>;
  const dayLeft = policy && now ? dailyRemaining(policy, now) : undefined;
  return <div className="arc-console">
    <div className="arc-page-heading"><div><span className="arc-eyebrow">{networkName === 'testnet' ? 'DEVELOPMENT / LIVE TESTNET' : 'PAYMENTS / OWNER WORKSPACE'}</span><h1>Arc Agent Vault</h1><p>Owner funds. Agent pays. Contracts enforce the limits.</p></div><Link href="/security" className="arc-badge">Security proof <ArrowUpRight size={13} /></Link></div>
    <div className="arc-notice"><AlertTriangle size={16} /><span>{networkName === 'testnet' ? 'Arc Testnet. Get free test USDC from faucet.circle.com.' : 'Payments are final once confirmed. Verify the factory address before funding.'}</span></div>
    <div className="arc-stat-grid"><div className="arc-stat"><span>VAULT BALANCE</span><strong>{balance === undefined ? '—' : displayUsdc(balance)} <small>USDC available</small></strong><small>{balance === undefined ? 'Load state to read balance' : 'Available: ' + displayUsdc(balance) + ' USDC'}</small></div><div className="arc-stat"><span>AGENT CAPABILITY</span><strong>{policy ? policy.active ? 'Active' : 'Revoked' : 'Not loaded'}</strong><small>{policy ? `Active: ${String(policy.active)}` : 'Owner-defined permissions'}</small></div><div className="arc-stat"><span>REMAINING BUDGET</span><strong>{policy ? displayUsdc(policy.maxTotal - policy.spent) : '—'}</strong><small>{policy ? `Remaining: ${displayUsdc(policy.maxTotal - policy.spent)} USDC · today ${dayLeft === undefined ? '—' : displayUsdc(dayLeft)}` : 'Lifetime budget less spending'}</small></div><div className="arc-stat"><span>PAYMENT NETWORK</span><strong>{networkName === 'testnet' ? 'Arc Testnet' : 'Arc Mainnet'}</strong><small>Chain {chain.id} · USDC</small></div></div>
    <div role="status" aria-live="polite" className="arc-status"><Info size={16} /><div>{message}{hash && <p><a href={`${chain.blockExplorers.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">Transaction: {hash}</a></p>}</div></div>
    {alerts.length > 0 && <div className="arc-alerts" aria-live="polite"><Bell size={16} /><div>{alerts.map((a, i) => <p key={i}>{a}</p>)}</div><button className="btn secondary" onClick={() => setAlerts([])}>Clear</button></div>}
    <div className="arc-console-grid"><div className="arc-panel-stack">
    <section id="arc-connect"><div className="arc-panel-head"><span className="arc-panel-icon"><Wallet size={18} /></span><div><h2>Connect your wallet</h2><p>01 / Your wallet signs every transaction</p></div></div><div className="arc-wallet-row"><span className="arc-badge">{account ? 'Connected' : 'Disconnected'}</span><span className="arc-address">{account ?? 'No wallet connected'}</span></div>
      {wallets.length > 1 && <label className="arc-field">Wallet<select value={walletId} onChange={e => setWalletId(e.target.value)}><option value="">Default browser wallet</option>{wallets.map(w => <option key={w.info.uuid} value={w.info.uuid}>{w.info.name}</option>)}</select></label>}
      <div className="arc-actions">
      {button('Connect EVM wallet', async () => { const p = provider(); if (!p) throw new Error('Install an EVM wallet (MetaMask, Rabby, Coinbase Wallet) or open this page in a mobile wallet browser'); const w = createWalletClient({ chain, transport: custom(p) }); const [a] = await w.requestAddresses(); setAccount(a); setConnectedChain(await w.getChainId()); if (factoryText) { try { setMyVaults(await client.readContract({ address: address(factoryText), abi: factoryAbi, functionName: 'vaultsOf', args: [a] })); } catch { /* factory not loaded */ } } setMessage('Wallet connected. Switch network if needed, then load or create a vault.'); })}
      {wrongChain && button(`Switch to ${chain.name}`, async () => { const w = createWalletClient({ transport: custom(provider()!) }); try { await w.switchChain({ id: chain.id }); } catch { await w.addChain({ chain }); await w.switchChain({ id: chain.id }); } setMessage('Network changed. Reconnect your wallet.'); })}
    </div></section>
    <section id="arc-vault"><div className="arc-panel-head"><span className="arc-panel-icon"><LockKeyhole size={18} /></span><div><h2>Create or load vault</h2><p>02 / Fund a vault that you control</p></div></div><div className="arc-fields">
      {field('Factory address (verified deployment)', factoryText, setFactoryText)}
      {button('Create my vault', async () => { const w = await signer(); const f = address(factoryText); if (!await client.getBytecode({ address: f })) throw new Error('Factory not deployed'); if ((await client.readContract({ address: f, abi: factoryAbi, functionName: 'usdc' })).toLowerCase() !== USDC.toLowerCase()) throw new Error('Factory token mismatch'); const { request } = await client.simulateContract({ account: account!, address: f, abi: factoryAbi, functionName: 'createVault' }); await confirmed(await w.writeContract(request)); const all = await client.readContract({ address: f, abi: factoryAbi, functionName: 'vaultsOf', args: [account!] }); setMyVaults(all); setVault(all[all.length - 1]); }, !account || wrongChain || !factoryText)}{(!account || wrongChain) && <p className="arc-hint">{!account ? 'Connect your wallet in step 01 first.' : `Switch your wallet to ${chain.name} first (button in step 01).`}</p>}
      {!factoryText && <p>Factory address is not configured. Deploy and configure a factory before creating vaults.</p>}
      {myVaults.length > 0 && <label className="arc-field">My vaults<select value={vault} onChange={e => { setVault(e.target.value); setHistory([]); setPolicy(undefined); }}><option value="">Select a vault</option>{myVaults.map((v, i) => <option key={v} value={v}>Vault {i + 1} · {short(v)}</option>)}</select></label>}
      {field('Vault address', vault, v => { setVault(v); setOwner(undefined); setBalance(undefined); setHistory([]); setPolicy(undefined); })}
      {button('Refresh on-chain state and history', async () => { await refresh(); setMessage('On-chain state refreshed'); }, !vault)}
      <dl className="arc-info-list"><div><dt>Vault owner</dt><dd className="arc-address">{owner ?? 'Load vault to inspect owner'}</dd></div></dl>
      {vault && <a href={`${chain.blockExplorers.default.url}/address/${vault}`} target="_blank" rel="noreferrer">Inspect vault on Arc Explorer</a>}
      {field('Deposit / withdrawal / payment amount (USDC)', amount, setAmount)}
      <div className="arc-actions">{button('Approve exact amount and deposit', () => mutate('deposit'), !isOwner || wrongChain)} {button('Withdraw to owner', () => mutate('withdraw'), !isOwner || wrongChain, 'secondary')}</div><p>Amounts use ERC-20 USDC with 6 decimals. Native gas uses 18 decimals. Only the loaded vault owner can deposit or withdraw. The owner may be a multisig such as Safe.</p>
    </div></section></div><div className="arc-panel-stack">
    <section id="arc-revoke"><div className="arc-panel-head"><span className="arc-panel-icon"><ShieldCheck size={18} /></span><div><h2>Agent permissions</h2><p>03 / Define the boundaries before spending</p></div></div><div className="arc-fields">
      <label className="arc-field">Policy template<select defaultValue="" onChange={e => applyTemplate(e.target.value)}><option value="">Custom</option>{templates.map(t => <option key={t.name} value={t.name}>{t.name} · {t.summary}</option>)}</select></label>
      {field('Agent EVM address', agent, a => { setAgent(a); setPolicy(undefined); })}
      <div className="arc-field-pair">{field('Lifetime total budget (USDC)', total, setTotal)} {field('Maximum per payment (USDC)', perPayment, setPerPayment)}</div>
      <div className="arc-field-pair">{field('Daily limit (USDC)', perDay, setPerDay, 'text', 'defaults to lifetime budget')} {field('Gas allowance (USDC)', gas, setGas)}</div>
      {field('Permitted recipients (comma separated)', recipients, setRecipients)} {field('Expiry (your local time)', expires, setExpires, 'datetime-local')}
      <label className="arc-check"><input type="checkbox" checked={useRegistry} onChange={e => setUseRegistry(e.target.checked)} /> Also allow merchants approved in the vault&apos;s merchant registry</label>
      <p>Updates preserve the amount already spent. Remaining budget is the total ceiling minus lifetime spending. The daily limit resets every UTC day.</p>
      <div className="arc-actions">{button('Authorize / update', () => mutate('authorize'), !isOwner || wrongChain)} {button('Revoke immediately', () => mutate('revoke'), !isOwner || wrongChain, 'danger')}</div>
      {policy && <p>Spent: {displayUsdc(policy.spent)} USDC · Gas drawn: {displayUsdc(policy.gasSpent)} USDC · Expires: {new Date(Number(policy.expiresAt) * 1000).toLocaleString()}</p>}
      <div className="arc-divider" />
      {field('Single recipient address', single, setSingle)}
      <div className="arc-actions">{button('Allow recipient', () => write('setRecipient', [address(agent), address(single), true]), !isOwner || wrongChain || !single)} {button('Remove recipient', () => write('setRecipient', [address(agent), address(single), false]), !isOwner || wrongChain || !single, 'secondary')}</div>
      {field('Merchant registry address', registryText, setRegistryText)}
      {button('Set merchant registry', () => write('setRegistry', [registryText ? address(registryText) : '0x0000000000000000000000000000000000000000']), !isOwner || wrongChain, 'secondary')}
      <div className="arc-divider" />
      {field('Circle Gateway allowance (USDC, lifetime)', gatewayCap, setGatewayCap)}
      {button('Set Gateway allowance', () => write('setGatewayAllowance', [address(agent), usdcAmount(gatewayCap || '0', true)]), !isOwner || wrongChain || !agent || !gateway?.enabled, 'secondary')}
      <p>{gateway === undefined ? 'This vault was deployed before Circle Gateway funding. Create a vault from the current factory to use it.' : !gateway.enabled ? 'Circle Gateway funding is disabled for this vault.' : `The agent can move up to this much into its own Circle Gateway balance and pay any x402 seller with it. It counts against the lifetime budget and daily limit; once moved, revoking does not pull it back.${gateway.allowance === undefined ? '' : ` Moved: ${displayUsdc(gateway.funded ?? 0n)} of ${displayUsdc(gateway.allowance)} USDC.`}`}</p>
    </div></section>
    <section id="arc-payments"><div className="arc-panel-head"><span className="arc-panel-icon"><Send size={18} /></span><div><h2>Execute a payment</h2><p>04 / Sign with the authorized agent wallet</p></div></div><div className="arc-fields"><p>Connect the authorized agent wallet, load the vault and pay. Leave the invoice ID empty to generate one; it is hashed on-chain so the same invoice can never be paid twice. A server agent can use the Velo402 SDK.</p>
      {field('Payment recipient', recipient, setRecipient)} {field('Unique invoice / payment ID', paymentId, setPaymentId, 'text', 'auto-generated if empty')}
      <div className="arc-actions">{button('Pay USDC', () => mutate('pay'), !account || wrongChain || !vault)} {button('Draw gas from allowance', () => mutate('topUpGas'), !account || wrongChain || !vault, 'secondary')} {button('Fund Circle Gateway balance', () => mutate('fundGateway'), !account || wrongChain || !vault || !gateway?.enabled, 'secondary')}</div>
    </div></section></div></div>
    <section id="arc-dashboard"><div className="arc-panel-head"><span className="arc-panel-icon"><BarChart3 size={18} /></span><div><h2>Spending dashboard</h2><p>From loaded contract events · {stats.agents.length} agent(s) authorized</p></div></div>
      {stats.byAgent.size === 0 ? <p>No agent spending in the loaded window.</p> : <div className="arc-info-grid"><div><h3 className="arc-mini">By agent</h3>{bars(stats.byAgent, short)}</div><div><h3 className="arc-mini">By recipient</h3>{bars(stats.byRecipient, k => k === 'gas' ? 'Agent gas' : k === 'gateway' ? 'Circle Gateway' : short(k))}</div></div>}
    </section>
    <section id="arc-history"><div className="arc-panel-head"><span className="arc-panel-icon"><History size={18} /></span><div><h2>Contract event history</h2><p>Confirmed activity, read directly from Arc</p></div></div><p>Loaded from block {historyFrom === undefined ? 'unknown' : String(historyFrom)}. New events appear here and as alerts while this page is open.</p>
      {history.length === 0 ? <div className="arc-empty"><History size={24} /><strong>No events loaded</strong><p>Load a vault and refresh its on-chain state to inspect activity.</p></div> : history.map((row, i) => <div key={`${row.hash}-${i}`} className="arc-event"><a href={`${chain.blockExplorers.default.url}/tx/${row.hash}`} target="_blank" rel="noreferrer">{row.event} · block {String(row.block)} ↗</a><p className="arc-event-detail">{row.detail}</p></div>)}
      {historyFrom !== undefined && historyFrom > 0n && button('Load earlier events', () => refresh(historyFrom - 1n))}
    </section>
  </div>;
}
