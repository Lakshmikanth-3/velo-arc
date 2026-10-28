import { defineChain, getAddress, parseUnits, formatUnits } from 'viem';

export const USDC = '0x3600000000000000000000000000000000000000' as const;
export const USDC_DECIMALS = 6;
/** Circle Gateway Wallet (x402 batched nanopayments), from @circle-fin/x402-batching 4.0.0. */
export const GATEWAY_WALLET = { mainnet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE', testnet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' } as const;
export const GAS_DECIMALS = 18;
export const arcMainnet = defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: GAS_DECIMALS }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } }, blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } } });
export const arcTestnet = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: GAS_DECIMALS }, rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } }, blockExplorers: { default: { name: 'Arc Testnet Explorer', url: 'https://explorer.testnet.arc.io' } }, testnet: true });
export function network(value = 'mainnet') {
  if (value === 'mainnet') return arcMainnet;
  if (value === 'testnet') return arcTestnet;
  throw new Error('Arc network must be mainnet or testnet');
}
export function address(value: string) {
  const result = getAddress(value);
  if (/^0x0{40}$/i.test(result)) throw new Error('Zero address is not permitted');
  return result;
}
export function usdcAmount(value: string, allowZero = false) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error('Use a positive USDC decimal string with at most 6 decimal places');
  const amount = parseUnits(value, USDC_DECIMALS);
  if ((allowZero ? amount < 0n : amount <= 0n) || amount >= 2n ** 256n) throw new Error('USDC amount out of range');
  return amount;
}
export const displayUsdc = (value: bigint) => formatUnits(value, USDC_DECIMALS);
