# Upgrade notes

Changes that move figures in an existing install. Nothing here needs a manual step unless it says so.

## 2026-10-10 — consolidation release

- **Stale Cardano reward rows are superseded automatically on the next sync.** Rewards used to share one id per
  epoch, whatever their type. A leader, refund or treasury/reserves reward now has an id of its own, and the old row
  of an epoch without a member reward is removed on the next sync, so it is not counted twice. No re-sync from
  scratch is needed.
- **Pool deposit refunds become transfer/acquisition rows instead of income.** A returned pool deposit is your own
  money coming back: it is now a transfer into the reward pot, and the tax report acquires the coins at market
  rather than listing them as unclassified income.
- **Treasury and reserves rewards now count as income.** They were unclassified before; they are now taxed as other
  income (Germany: §22 Nr. 3 EStG).
- **Reward fees are deducted (Germany) or disposed (Austria).** A fee paid to receive a reward is a disposal of the
  fee coins in both countries. Germany also deducts it as Werbungskosten, netted against the year's §22 Nr. 3
  income (rule set 1.6.0); Austria deducts nothing under the flat tax (rule set 1.2.0).
