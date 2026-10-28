import { createPublicClient, createWalletClient, http, erc20Abi, keccak256, toHex, parseEventLogs, BaseError, ContractFunctionRevertedError, type Account, type Address, type Hex, type Chain, type PublicClient, type WalletClient, type Transport } from 'viem';
import { network, USDC, address, usdcAmount } from './config';
import { vaultAbi } from './abi';
import { toCapability } from './capability';

export class ArcExecutionError extends Error {
  constructor(readonly hash: Hex, readonly status: 'reverted' | 'unknown', message: string) { super(message); }
}
/** A payment the vault refused; `reason` is the contract error name (PaymentLimit, RecipientDenied, ...). */
export class ArcPolicyRejection extends Error {
  constructor(readonly reason: string, readonly recipient: string, readonly amount: string) { super(`Vault rejected payment: ${reason}`); }
}
export type ArcEvent = { type: 'paid' | 'rejected' | 'gas' | 'gateway'; vault: Address; agent: Address; recipient?: string; amount?: string; reason?: string; hash?: Hex };
export type ArcAgentOptions = { rpc?: string; onEvent?: (e: ArcEvent) => void | Promise<void>; minGas?: string };

/** Deterministic invoice hash: the same order can never be paid twice. */
export const invoiceId = (invoice: unknown) => keccak256(toHex(typeof invoice === 'string' ? invoice : JSON.stringify(invoice)));

/** Agent-side client. The key only ever calls pay(), topUpGas() and fundGateway(); the vault enforces the owner's policy. */
export class ArcAgent {
  readonly chain: Chain;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  readonly vault: Address;
  private readonly options: ArcAgentOptions;
  constructor(readonly account: Account, vault: string, net: 'mainnet' | 'testnet', rpcOrOptions?: string | ArcAgentOptions) {
    this.options = typeof rpcOrOptions === 'string' ? { rpc: rpcOrOptions } : rpcOrOptions ?? {};
    this.chain = network(net);
    this.vault = address(vault);
    const url = this.options.rpc ?? this.chain.rpcUrls.default.http[0];
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(url, { retryCount: 1, timeout: 15000 }) });
    this.walletClient = createWalletClient({ account, chain: this.chain, transport: http(url, { retryCount: 0 }) });
  }
  private async emit(e: Omit<ArcEvent, 'vault' | 'agent'>) {
    try { await this.options.onEvent?.({ ...e, vault: this.vault, agent: this.account.address }); } catch { /* alerts never block payments */ }
  }
  async state() {
    if (await this.publicClient.getChainId() !== this.chain.id) throw new Error('RPC chain mismatch');
    if (!await this.publicClient.getBytecode({ address: this.vault })) throw new Error('Vault has no bytecode');
    const token = await this.publicClient.readContract({ address: this.vault, abi: vaultAbi, functionName: 'usdc' });
    if (token.toLowerCase() !== USDC.toLowerCase()) throw new Error('Unsupported vault token');
    if (await this.publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' }) !== 6) throw new Error('USDC decimals mismatch');
    const [raw, balance, dailyRemaining] = await Promise.all([
      this.publicClient.readContract({ address: this.vault, abi: vaultAbi, functionName: 'capabilities', args: [this.account.address] }),
      this.publicClient.readContract({ address: this.vault, abi: vaultAbi, functionName: 'balance' }),
      this.publicClient.readContract({ address: this.vault, abi: vaultAbi, functionName: 'dailyRemaining', args: [this.account.address] }),
    ]);
    const c = toCapability(raw);
    return { ...c, balance, dailyRemaining, remainingBudget: c.maxTotal - c.spent };
  }
  /** Checks a payment against the live contract without sending it. Returns the contract error name, or null if it would succeed. */
  async check(recipient: string, amount: string, paymentId: Hex): Promise<string | null> {
    try {
      await this.publicClient.simulateContract({ account: this.account, address: this.vault, abi: vaultAbi, functionName: 'pay', args: [address(recipient), usdcAmount(amount), paymentId] });
      return null;
    } catch (error) {
      const r = error instanceof BaseError ? error.walk(e => e instanceof ContractFunctionRevertedError) : undefined;
      return r instanceof ContractFunctionRevertedError ? r.data?.errorName ?? 'Reverted' : 'RpcError';
    }
  }
  /** Tops up the agent's own gas from its allowance when its native USDC balance falls below `minGas`. */
  async ensureGas(minGas = this.options.minGas ?? '0.02') {
    const native = await this.publicClient.getBalance({ address: this.account.address });
    if (native >= usdcAmount(minGas) * 10n ** 12n) return null;
    const s = await this.state();
    const room = s.gasAllowance > s.gasSpent ? s.gasAllowance - s.gasSpent : 0n;
    const want = usdcAmount(minGas) * 2n;
    const amount = room < want ? room : want;
    if (amount <= 0n) return null;
    const { request } = await this.publicClient.simulateContract({ account: this.account, address: this.vault, abi: vaultAbi, functionName: 'topUpGas', args: [amount] });
    const hash = await this.walletClient.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 90000 });
    await this.emit({ type: 'gas', amount: String(amount), hash });
    return hash;
  }
  /**
   * Moves USDC from the vault into this agent's Circle Gateway balance, within the owner's Gateway allowance,
   * lifetime budget and daily limit. The agent can then pay any x402 seller through Gateway (e.g. with
   * GatewayClient from @circle-fin/x402-batching) without one on-chain transaction per payment.
   */
  async fundGateway(amount: string) {
    const units = usdcAmount(amount);
    let request;
    try {
      ({ request } = await this.publicClient.simulateContract({ account: this.account, address: this.vault, abi: vaultAbi, functionName: 'fundGateway', args: [units] }));
    } catch (error) {
      const r = error instanceof BaseError ? error.walk(e => e instanceof ContractFunctionRevertedError) : undefined;
      if (!(r instanceof ContractFunctionRevertedError)) throw error;
      const reason = r.data?.errorName ?? 'Reverted';
      await this.emit({ type: 'rejected', recipient: 'gateway', amount, reason });
      throw new ArcPolicyRejection(reason, 'gateway', amount);
    }
    const hash = await this.walletClient.writeContract(request);
    let receipt;
    try { receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 90000 }); }
    catch { throw new ArcExecutionError(hash, 'unknown', 'Gateway funding submitted; receipt unavailable. Reconcile hash before retrying.'); }
    if (receipt.status !== 'success') throw new ArcExecutionError(hash, 'reverted', 'Gateway funding reverted');
    const [funded] = parseEventLogs({ abi: vaultAbi, eventName: 'GatewayFunded', logs: receipt.logs });
    await this.emit({ type: 'gateway', amount, hash });
    return { ok: true, hash, amountUnits: String(units), remainingBudget: String(funded?.args.remainingBudget ?? 0n) };
  }
  async pay(recipient: string, amount: string, paymentId: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentId) || /^0x0{64}$/.test(paymentId)) throw new Error('Nonzero bytes32 payment ID required');
    const before = await this.state();
    const args = [address(recipient), usdcAmount(amount), paymentId] as const;
    const reason = await this.check(recipient, amount, paymentId);
    if (reason) { await this.emit({ type: 'rejected', recipient, amount, reason }); throw new ArcPolicyRejection(reason, recipient, amount); }
    // Pre-flight eth_call with the real signer against the deployed contract; the contract stays authoritative.
    const { request } = await this.publicClient.simulateContract({ account: this.account, address: this.vault, abi: vaultAbi, functionName: 'pay', args });
    const hash = await this.walletClient.writeContract(request);
    // Do not retry automatically on timeout: query this hash and usedPaymentIds first.
    let receipt;
    try { receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 90000 }); }
    catch { throw new ArcExecutionError(hash, 'unknown', 'Payment submitted; receipt unavailable. Reconcile hash before retrying.'); }
    if (receipt.status !== 'success') throw new ArcExecutionError(hash, 'reverted', 'Payment reverted');
    const [paid] = parseEventLogs({ abi: vaultAbi, eventName: 'Paid', logs: receipt.logs });
    await this.emit({ type: 'paid', recipient, amount, hash });
    return { ok: true, hash, blockNumber: String(receipt.blockNumber), amountUnits: String(args[1]), recipient: args[0], paymentId, remainingBudget: String(paid?.args.remainingBudget ?? before.remainingBudget - args[1]), spentBefore: String(before.spent) };
  }
}
