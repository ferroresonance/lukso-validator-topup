# LUKSO Validator Top Up

A public page for topping up an existing LUKSO Mainnet validator with your own wallet.

Live page: https://ferroresonance.github.io/lukso-validator-topup/

## What it does

- Connects to the wallet in the browser with `eth_requestAccounts`.
- Uses LUKSO Mainnet, chain ID `42`.
- Accepts an existing validator BLS public key (48 bytes).
- Accepts a top-up of at least 1 LYX, with up to 9 decimals.
- Builds the standard existing-validator top-up locally:
  - validator pubkey = the pubkey you paste
  - withdrawal credentials = 32 zero bytes
  - signature = 96 zero bytes
  - amount = the top-up in Gwei
- Computes the SSZ `deposit_data_root` in the browser.
- Calls the canonical deposit contract `0xCAfe00000000000000000000000000000000CAfe`.
- The connected wallet signs and pays the LYX.

The page does not ask for a seed phrase, a validator keystore, or a withdrawal key. It does not create new validators, and it does not switch `0x01` credentials to `0x02` or consolidate validators.

## Before you send

1. Check the validator pubkey in the LUKSO consensus explorer.
2. Confirm the wallet is on LUKSO, chain ID 42.
3. Confirm the LYX amount in the wallet prompt.
4. Confirm the transaction target is `0xCAfe00000000000000000000000000000000CAfe`.

Anyone who opens the page can top up any pubkey they paste. The LYX leaves the wallet that confirms the transaction.

The page loads ethers.js `6.15.0` from jsDelivr. The deposit root is computed locally.
