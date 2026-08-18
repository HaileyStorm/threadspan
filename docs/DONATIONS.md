# Supporting Threadspan

Threadspan is free to use. Donations are optional, have no effect on features or support, and help pay for development time and GPU testing.

Always compare the full destination shown by your wallet or provider with the value here before sending. Cryptocurrency and provider-credit transfers can be difficult or impossible to reverse.

## Cryptocurrency

### Bitcoin

`1K628QLEh3sS8sEdzZfvuqqHRecVckSgaJ`

![Bitcoin donation QR code](../ui/assets/donate-btc.svg)

### Cardano

`addr1q9fd05jktgv49094z8hvjp6cqvn7npt8hfzjna4dvhezmvpgl92x5cevqghl4ng0we2es4xjp59gvm3nttdzwf9ym6lqr3628x`

![Cardano donation QR code](../ui/assets/donate-cardano.svg)

### Ethereum

`0x78b6adac22415568A7F725a865206ccFd1a82F4c`

![Ethereum donation QR code](../ui/assets/donate-ethereum.svg)

The Ethereum address is provided without a chain-specific promise. Check that your intended network and asset are compatible before sending.

## Vast.ai credit

Vast.ai credit can be transferred to `HaileyCollet@gmail.com` for Threadspan's GPU testing costs.

In the Vast.ai console:

1. Sign in and open **Billing**.
2. Choose **Transfer Credits**.
3. Enter `HaileyCollet@gmail.com` as the recipient and choose the amount.
4. Compare the full email again before confirming.

The CLI equivalent is:

```bash
vastai transfer credit HaileyCollet@gmail.com AMOUNT
```

`AMOUNT` is the dollar amount of Vast.ai credit to transfer. Keep the normal confirmation prompt; do not use a confirmation-skipping option for a donation.

Use your existing Vast.ai sign-in or CLI authentication. Threadspan does not ask for, receive, or store a Vast.ai API key.

**Warning:** Vast.ai documents credit transfers as irreversible. A mistyped recipient may not be recoverable. Review Vast.ai's official [billing guide](https://docs.vast.ai/guides/reference/billing) and [`transfer credit` CLI reference](https://docs.vast.ai/cli/reference/transfer-credit) before sending.

## Buy Me a Coffee

The verified public maintainer page is [buymeacoffee.com/threadspan](https://buymeacoffee.com/threadspan). It supports one-time contributions and memberships through Buy Me a Coffee's hosted payment flow; Threadspan never receives payout credentials or card details.

## Privacy and boundaries

Threadspan does not collect donor identities, amounts, wallet activity, or donation telemetry. The installer may show one quiet, dismissible support card once per installer session near the start of setup. Its server-owned recovery/session claim survives page reload and staged updater relaunch; donation content is not part of the installed runtime. There are no donation popups, nags, auto-polling, background donation requests, wallet or provider keys, payment SDKs, account setup, automatic transfers, or financial controls in Threadspan.

No donation monitor exists today. Possible future maintainer tooling is limited to provider-native balance or low-credit emails and an optional maintainer-only local monitor. Any such monitor would remain opt-in, private, credential-safe, separate from the installer and runtime HUD, and unable to charge donors or initiate transfers.
