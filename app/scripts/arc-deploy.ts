import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, erc20Abi, encodeDeployData, formatUnits, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { network, USDC, GATEWAY_WALLET, address } from '../src/lib/arc/config';
import { factoryAbi, registryAbi } from '../src/lib/arc/abi';

async function main() {
  const chain = network(process.env.ARC_NETWORK ?? 'mainnet');
  const transport = http(process.env.ARC_RPC_URL ?? chain.rpcUrls.default.http[0], { retryCount: 0, timeout: 15000 });
  const publicClient = createPublicClient({ chain, transport });
  if (await publicClient.getChainId() !== chain.id) throw new Error('RPC chain mismatch');
  const gateway = chain.id === 5042 ? GATEWAY_WALLET.mainnet : GATEWAY_WALLET.testnet;
  const decimals = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' });
  if (decimals !== 6) throw new Error('USDC ERC-20 decimals mismatch');
  const artifact = JSON.parse(readFileSync('../contracts/arc/artifacts/ArcVaultFactory.json', 'utf8')) as { bytecode: `0x${string}` };
  const key = process.env.ARC_DEPLOYER_PRIVATE_KEY;
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Invalid deployer key');
  const account = key ? privateKeyToAccount(key as `0x${string}`) : undefined;
  const deployer = address(process.env.ARC_DEPLOYER_ADDRESS ?? account?.address ?? '');
  if (account && account.address.toLowerCase() !== deployer.toLowerCase()) throw new Error('Deployer address mismatch');
  const balance = await publicClient.getBalance({ address: deployer });
  const data = encodeDeployData({ abi: factoryAbi, bytecode: artifact.bytecode, args: [USDC, gateway] });
  const gas = await publicClient.estimateGas({ account: deployer, data });
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  if (!maxFeePerGas) throw new Error('Fee estimate unavailable');
  const gasLimit = gas * 120n / 100n;
  const maximumCost = gasLimit * maxFeePerGas;
  console.log(JSON.stringify({ network: chain.name, chainId: chain.id, deployer, nativeBalanceUSDC: formatUnits(balance, 18), gas: String(gasLimit), maxFeePerGas: String(maxFeePerGas), estimatedMaximumGasUSDC: formatUnits(maximumCost, 18), usdc: USDC, erc20Decimals: decimals, broadcast: false }, null, 2));
  if (balance <= maximumCost) throw new Error('Insufficient native USDC for gas estimate plus reserve');
  if (!process.argv.includes('--broadcast')) return;
  if (!account) throw new Error('A dedicated secure deployer signer is required');
  if (chain.id === 5042 && process.env.ARC_MAINNET_CONFIRM !== 'I_CONFIRM_MAINNET_SPEND') throw new Error('Separate mainnet confirmation required');
  const path = `../contracts/arc/deployments/${chain.id}.json`;
  try { readFileSync(path); throw new Error('Deployment manifest already exists. Reconcile it before redeploying.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const wallet = createWalletClient({ account, chain, transport });
  const hash = await wallet.deployContract({ abi: factoryAbi, bytecode: artifact.bytecode, args: [USDC, gateway], gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n });
  mkdirSync('../contracts/arc/deployments', { recursive: true });
  const manifest = { chainId: chain.id, officialRpc: chain.rpcUrls.default.http[0], deployer, usdc: USDC, gatewayWallet: gateway, erc20Decimals: 6, gasDecimals: 18, deploymentHash: hash, compiler: '0.8.30', optimizerRuns: 200, evmVersion: 'paris', submittedAt: new Date().toISOString(), status: 'pending' };
  // Save hash before waiting so a timeout can be reconciled without a second broadcast.
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  console.log(`Submitted deployment: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90000 });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Deployment failed; reconcile saved manifest');
  const factory = receipt.contractAddress;
  const code = await publicClient.getBytecode({ address: factory });
  if (!code || code === '0x') throw new Error('Post-deployment bytecode missing');
  if ((await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'usdc' })).toLowerCase() !== USDC.toLowerCase()) throw new Error('Post-deployment token mismatch');
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const confirmed = { ...manifest, status: 'confirmed', factory, blockNumber: String(receipt.blockNumber), deployedAt: new Date(Number(block.timestamp) * 1000).toISOString(), runtimeCodeHash: keccak256(code) };
  writeFileSync(path, JSON.stringify(confirmed, null, 2));
  console.log(`Confirmed factory: ${factory}`);
  // Merchant registry: a curated list vault owners can opt into. Curator defaults to the deployer.
  const regArtifact = JSON.parse(readFileSync('../contracts/arc/artifacts/MerchantRegistry.json', 'utf8')) as { bytecode: `0x${string}` };
  const curator = address(process.env.ARC_REGISTRY_CURATOR ?? deployer);
  const regHash = await wallet.deployContract({ abi: registryAbi, bytecode: regArtifact.bytecode, args: [curator] });
  writeFileSync(path, JSON.stringify({ ...confirmed, registryDeploymentHash: regHash }, null, 2));
  const regReceipt = await publicClient.waitForTransactionReceipt({ hash: regHash, timeout: 90000 });
  if (regReceipt.status !== 'success' || !regReceipt.contractAddress) throw new Error('Registry deployment failed; factory is deployed and recorded');
  writeFileSync(path, JSON.stringify({ ...confirmed, registryDeploymentHash: regHash, registry: regReceipt.contractAddress, registryCurator: curator }, null, 2));
  console.log(`Confirmed merchant registry: ${regReceipt.contractAddress}`);
}
main().catch(error => { console.error(error instanceof Error && !/0x[0-9a-fA-F]{64}/.test(error.message) ? error.message : 'Arc deployment/preflight failed. Reconcile saved hash and configuration.'); process.exitCode = 1; });
