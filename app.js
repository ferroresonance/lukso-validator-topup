/*
  LUKSO Validator Top Up
  - Mainnet only (chain ID 42)
  - Canonical deposit contract
  - Existing-validator top-up semantics:
      pubkey = validator pubkey
      withdrawal_credentials = 32 zero bytes
      signature = 96 zero bytes
      amount = top-up amount in Gwei (uint64 SSZ, little endian)
  - deposit_data_root is computed locally using SSZ hash_tree_root rules.
*/

const CHAIN_ID = 42n;
const CHAIN_ID_HEX = '0x2a';
const DEPOSIT_CONTRACT = '0xCAfe00000000000000000000000000000000CAfe';
const RPC_URL = 'https://42.rpc.thirdweb.com';
const EXPLORER_BASE = 'https://explorer.execution.mainnet.lukso.network';

const DEPOSIT_ABI = [
  'function deposit(bytes pubkey, bytes withdrawal_credentials, bytes signature, bytes32 deposit_data_root) payable'
];

const ZERO_32_HEX = '0x' + '00'.repeat(32);
const ZERO_96_HEX = '0x' + '00'.repeat(96);

let browserProvider = null;
let signer = null;
let connectedAccount = null;
let currentRoot = null;
let busy = false;

const $ = (id) => document.getElementById(id);
const els = {
  connectButton: $('connectButton'),
  walletStatus: $('walletStatus'),
  networkWarning: $('networkWarning'),
  pubkey: $('pubkey'),
  pubkeyStatus: $('pubkeyStatus'),
  pubkeyLength: $('pubkeyLength'),
  amount: $('amount'),
  amountStatus: $('amountStatus'),
  reviewAmount: $('reviewAmount'),
  depositRoot: $('depositRoot'),
  acknowledge: $('acknowledge'),
  topupButton: $('topupButton'),
  statusCard: $('statusCard'),
  statusTitle: $('statusTitle'),
  statusText: $('statusText'),
  txLink: $('txLink')
};

function normalizeHex(value) {
  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function normalizePubkey(value) {
  const clean = normalizeHex(value);
  return clean.startsWith('0x') ? clean : `0x${clean}`;
}

function hexByteLength(value) {
  const clean = normalizeHex(value).replace(/^0x/, '');
  if (!clean) return 0;
  return Math.ceil(clean.length / 2);
}

function validPubkey(value) {
  return /^0x[0-9a-fA-F]{96}$/.test(normalizePubkey(value));
}

function parseTopupAmount() {
  const raw = els.amount.value.trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(raw)) {
    throw new Error('Enter a valid amount with no more than 9 decimal places.');
  }
  const gwei = ethers.parseUnits(raw, 9);
  if (gwei < 1_000_000_000n) {
    throw new Error('Minimum top-up is 1 LYX.');
  }
  const maxUint64 = (1n << 64n) - 1n;
  if (gwei > maxUint64) {
    throw new Error('Amount is too large for the deposit contract SSZ uint64 amount field.');
  }
  const wei = ethers.parseUnits(raw, 18);
  return { raw, gwei, wei };
}

function hexToBytes(hex) {
  const clean = normalizeHex(hex).replace(/^0x/, '');
  if (clean.length % 2 !== 0) throw new Error('Invalid hex length.');
  if (!/^[0-9a-f]*$/i.test(clean)) throw new Error('Invalid hex characters.');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(hash);
}

function padTo32(bytes) {
  if (bytes.length > 32) throw new Error('Chunk too large.');
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

function uint64LittleEndianRoot(value) {
  const out = new Uint8Array(32);
  let n = BigInt(value);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new Error('Amount does not fit uint64.');
  return out;
}

async function hashPair(left, right) {
  if (left.length !== 32 || right.length !== 32) throw new Error('SSZ pair must contain 32-byte roots.');
  return sha256(concatBytes(left, right));
}

async function bytes48Root(bytes48) {
  if (bytes48.length !== 48) throw new Error('Validator pubkey must be 48 bytes.');
  const chunk0 = bytes48.slice(0, 32);
  const chunk1 = padTo32(bytes48.slice(32, 48));
  return hashPair(chunk0, chunk1);
}

async function bytes96Root(bytes96) {
  if (bytes96.length !== 96) throw new Error('Signature must be 96 bytes.');
  const c0 = bytes96.slice(0, 32);
  const c1 = bytes96.slice(32, 64);
  const c2 = bytes96.slice(64, 96);
  const zero = new Uint8Array(32);
  const left = await hashPair(c0, c1);
  const right = await hashPair(c2, zero);
  return hashPair(left, right);
}

async function computeTopupDepositRoot(pubkeyHex, amountGwei) {
  const pubkeyBytes = hexToBytes(pubkeyHex);
  const withdrawalCredentials = new Uint8Array(32);
  const signature = new Uint8Array(96);

  const pubkeyRoot = await bytes48Root(pubkeyBytes);
  const withdrawalRoot = withdrawalCredentials; // bytes32 is one SSZ chunk
  const amountRoot = uint64LittleEndianRoot(amountGwei);
  const signatureRoot = await bytes96Root(signature);

  const left = await hashPair(pubkeyRoot, withdrawalRoot);
  const right = await hashPair(amountRoot, signatureRoot);
  return bytesToHex(await hashPair(left, right));
}

function shortAddress(address) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function setNotice(message = '', kind = 'warn') {
  if (!message) {
    els.networkWarning.className = 'notice hidden';
    els.networkWarning.textContent = '';
    return;
  }
  els.networkWarning.className = `notice ${kind}`;
  els.networkWarning.textContent = message;
}

function showStatus(title, text, kind = '') {
  els.statusCard.classList.remove('hidden');
  els.statusTitle.textContent = title;
  els.statusTitle.className = `status-title ${kind}`;
  els.statusText.textContent = text;
}

function hideTxLink() {
  els.txLink.classList.add('hidden');
  els.txLink.removeAttribute('href');
}

function showTxLink(hash) {
  els.txLink.href = `${EXPLORER_BASE}/tx/${hash}`;
  els.txLink.classList.remove('hidden');
}

async function ensureLuksoNetwork() {
  if (!window.ethereum) throw new Error('MetaMask was not detected in this browser.');

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN_ID_HEX }]
    });
  } catch (error) {
    if (error?.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_ID_HEX,
          chainName: 'LUKSO',
          nativeCurrency: { name: 'LYX', symbol: 'LYX', decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: ['https://explorer.lukso.network']
        }]
      });
    } else {
      throw error;
    }
  }
}

async function refreshWallet() {
  if (!window.ethereum) {
    els.walletStatus.textContent = 'MetaMask not detected';
    els.connectButton.disabled = true;
    setNotice('Open this page in a browser with the MetaMask extension enabled.', 'bad');
    updateForm();
    return;
  }

  const accounts = await window.ethereum.request({ method: 'eth_accounts' });
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  const chainOk = BigInt(chainHex) === CHAIN_ID;

  connectedAccount = accounts?.[0] || null;
  if (connectedAccount) {
    els.walletStatus.textContent = `${shortAddress(connectedAccount)} · ${connectedAccount}`;
    els.connectButton.textContent = 'Reconnect / switch account';
  } else {
    els.walletStatus.textContent = 'Not connected';
    els.connectButton.textContent = 'Connect MetaMask';
  }

  if (connectedAccount && !chainOk) {
    setNotice(`Wallet is connected to chain ${BigInt(chainHex).toString()}. Switch to LUKSO Mainnet (42) before topping up.`, 'warn');
  } else {
    setNotice('');
  }

  if (connectedAccount && chainOk) {
    browserProvider = new ethers.BrowserProvider(window.ethereum);
    signer = await browserProvider.getSigner();
  } else {
    browserProvider = null;
    signer = null;
  }
  updateForm();
}

async function connectWallet() {
  try {
    if (!window.ethereum) throw new Error('MetaMask was not detected.');
    els.connectButton.disabled = true;
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    await ensureLuksoNetwork();
    await refreshWallet();
  } catch (error) {
    showStatus('Wallet connection failed', error?.message || String(error), 'bad');
  } finally {
    els.connectButton.disabled = false;
  }
}

async function updateForm() {
  const normalized = normalizePubkey(els.pubkey.value);
  const byteLength = hexByteLength(normalized);
  els.pubkeyLength.textContent = `${Math.min(byteLength, 999)} / 48 bytes`;

  let pubkeyOk = false;
  if (!els.pubkey.value.trim()) {
    els.pubkeyStatus.textContent = 'No validator pubkey entered.';
    els.pubkeyStatus.className = 'muted';
  } else if (validPubkey(normalized)) {
    pubkeyOk = true;
    els.pubkeyStatus.textContent = 'Valid 48-byte validator pubkey.';
    els.pubkeyStatus.className = 'good';
  } else {
    els.pubkeyStatus.textContent = 'Validator pubkey must be exactly 48 bytes (96 hex characters).';
    els.pubkeyStatus.className = 'bad';
  }

  let amountOk = false;
  let amount = null;
  try {
    amount = parseTopupAmount();
    amountOk = true;
    els.amountStatus.textContent = `${amount.raw} LYX = ${amount.gwei.toString()} Gwei for the SSZ deposit amount.`;
    els.amountStatus.className = 'field-footer good';
    els.reviewAmount.textContent = `${amount.raw} LYX`;
  } catch (error) {
    els.amountStatus.textContent = error.message;
    els.amountStatus.className = 'field-footer bad';
    els.reviewAmount.textContent = '—';
  }

  currentRoot = null;
  if (pubkeyOk && amountOk) {
    try {
      currentRoot = await computeTopupDepositRoot(normalized, amount.gwei);
      els.depositRoot.textContent = currentRoot;
    } catch (error) {
      els.depositRoot.textContent = `Root calculation error: ${error.message}`;
    }
  } else {
    els.depositRoot.textContent = pubkeyOk ? 'Enter a valid amount' : 'Enter a valid validator pubkey';
  }

  const ready = Boolean(
    !busy &&
    connectedAccount &&
    signer &&
    pubkeyOk &&
    amountOk &&
    currentRoot &&
    els.acknowledge.checked
  );
  els.topupButton.disabled = !ready;
}

async function submitTopup() {
  if (busy) return;
  hideTxLink();

  try {
    busy = true;
    await updateForm();
    els.topupButton.disabled = true;

    if (!window.ethereum) throw new Error('MetaMask was not detected.');
    await ensureLuksoNetwork();

    browserProvider = new ethers.BrowserProvider(window.ethereum);
    signer = await browserProvider.getSigner();
    connectedAccount = await signer.getAddress();

    const network = await browserProvider.getNetwork();
    if (network.chainId !== CHAIN_ID) throw new Error('Wallet is not on LUKSO Mainnet (chain 42).');

    const pubkey = normalizePubkey(els.pubkey.value);
    if (!validPubkey(pubkey)) throw new Error('Invalid validator public key.');
    const amount = parseTopupAmount();
    const depositRoot = await computeTopupDepositRoot(pubkey, amount.gwei);

    const code = await browserProvider.getCode(DEPOSIT_CONTRACT);
    if (!code || code === '0x') {
      throw new Error('No bytecode was found at the configured deposit contract. Transaction blocked.');
    }

    const walletBalance = await browserProvider.getBalance(connectedAccount);
    if (walletBalance <= amount.wei) {
      throw new Error(`Wallet balance is not enough for ${amount.raw} LYX plus transaction gas.`);
    }

    const contract = new ethers.Contract(DEPOSIT_CONTRACT, DEPOSIT_ABI, signer);

    showStatus(
      'Checking transaction',
      `Wallet: ${connectedAccount}\nValidator: ${pubkey}\nAmount: ${amount.raw} LYX\nDeposit root: ${depositRoot}\nContract: ${DEPOSIT_CONTRACT}`
    );

    const estimatedGas = await contract.deposit.estimateGas(
      pubkey,
      ZERO_32_HEX,
      ZERO_96_HEX,
      depositRoot,
      { value: amount.wei }
    );

    const gasLimit = (estimatedGas * 120n) / 100n;

    showStatus(
      'Confirm in MetaMask',
      `MetaMask should open now.\n\nValidator: ${pubkey}\nTop up: ${amount.raw} LYX\nEstimated gas: ${estimatedGas.toString()}\nGas limit: ${gasLimit.toString()}\nContract: ${DEPOSIT_CONTRACT}`,
      'warn'
    );

    const tx = await contract.deposit(
      pubkey,
      ZERO_32_HEX,
      ZERO_96_HEX,
      depositRoot,
      { value: amount.wei, gasLimit }
    );

    showStatus(
      'Transaction submitted',
      `Transaction hash:\n${tx.hash}\n\nWaiting for an execution-layer confirmation…`
    );
    showTxLink(tx.hash);

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Transaction was mined but did not succeed. Hash: ${tx.hash}`);
    }

    showStatus(
      'Top-up transaction confirmed',
      `Execution-layer transaction succeeded.\n\nTransaction hash:\n${tx.hash}\n\nBlock: ${receipt.blockNumber}\nValidator: ${pubkey}\nAmount sent: ${amount.raw} LYX\n\nThe validator balance update is handled by the consensus layer after the deposit is processed.`,
      'good'
    );
    showTxLink(tx.hash);
  } catch (error) {
    const message = error?.shortMessage || error?.reason || error?.message || String(error);
    const rejected = error?.code === 4001 || /user rejected|user denied/i.test(message);
    showStatus(rejected ? 'Transaction cancelled' : 'Top-up failed', message, rejected ? 'warn' : 'bad');
  } finally {
    busy = false;
    await refreshWallet().catch(() => {});
    await updateForm();
  }
}

els.connectButton.addEventListener('click', connectWallet);
els.pubkey.addEventListener('input', updateForm);
els.amount.addEventListener('input', updateForm);
els.acknowledge.addEventListener('change', updateForm);
els.topupButton.addEventListener('click', submitTopup);

if (window.ethereum) {
  window.ethereum.on?.('accountsChanged', refreshWallet);
  window.ethereum.on?.('chainChanged', refreshWallet);
}

refreshWallet().catch((error) => {
  showStatus('Wallet check failed', error?.message || String(error), 'bad');
});
updateForm();
