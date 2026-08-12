# Ledger

A personal bill and debt tracker that keeps the math honest when something goes unpaid.

Most bill apps flip a checkbox to "paid" and roll the due date forward. Skip a month and that month disappears. Ledger keeps every billing cycle as its own record with its own balance, so a missed payment stays on the books and accrues while the next cycle posts on top of it.

Everything runs in the browser. There is no server and no account. Data stays on the device it was entered on.

---

## What it does

**Tracks what is actually owed.** Enter a bill once with its amount, due date, and repeat interval. Every cycle posts itself from then on. Miss July's payment and the app tells you that you are two cycles behind and what the combined balance is, rather than quietly losing it.

**Calculates late fees and interest.** Set an APR and grace period per bill. Once grace expires, interest compounds daily on the unpaid total. An optional flat late fee lands once per missed cycle. A live counter shows what the delay costs per day.

**Handles partial payments.** Pay any amount on any date. Payments allocate to fees first, then interest, then principal, which is standard creditor practice. Backdate a payment and the balance recalculates as though it landed that day.

**Splits bills by paycheck.** Set a pay schedule and Ledger groups bills into the check that has to cover them, instead of lumping them by calendar month. Add take-home pay and each period shows the surplus or the shortfall.

**Backs itself up.** Full JSON export and restore, plus CSV for spreadsheets. Storage is per browser with no sync, so the backup file is the only real safety net.

---

## Quick start

```bash
npm install
npm run dev
```

Then open the URL Vite prints, usually `http://localhost:5173`.

```bash
npm run build     # production build into dist/
npm run preview   # serve the build locally to check it
```

Requires Node 18 or newer.

---

## Deploying

**Netlify.** Connect the repo, set build command `npm run build` and publish directory `dist`. Nothing else to configure.

**GitHub Pages.** Run `npm run build` and publish the `dist` folder. `vite.config.js` sets `base: "./"` so the build works from a subpath without changes.

**Anywhere else.** `dist/` is plain static files. Any web server or a Raspberry Pi behind nginx will serve it.

---

## How storage works

The app calls an async `window.storage` API. Inside the Claude artifact sandbox the host provides it. Everywhere else, `src/storage.js` installs a `localStorage`-backed implementation with the same interface, namespaced under `ledger:`.

The shim never overwrites a host-provided implementation, so one copy of `Ledger.jsx` runs correctly in both environments. If storage is unavailable entirely, such as Safari private mode, the app detects it and shows a banner rather than pretending writes succeeded.

Swapping in a real backend means replacing `src/storage.js` and nothing else.

---

## Project layout

```
index.html          entry document
vite.config.js      build config
src/
  main.jsx          mounts the app, installs the storage shim first
  Ledger.jsx        the entire application
  storage.js        localStorage implementation of window.storage
  index.css         page reset and safe-area padding
```

---

## A note on the math

`ledgerFor()`, `postCharges()`, and `buildPeriods()` carry a test suite covering daily compounding against hand-computed values, grace period suppression, partial payments mid-period, fee-before-principal allocation, overpayment credit, month-end clamping (a bill due the 31st correctly falls to Feb 28 and returns to the 31st in March), and pay period alignment across four schedules.

Charges snapshot the terms in force when they post. Changing a bill's APR today does not retroactively rewrite last year's balance. Editing terms offers an explicit opt-in to reprice open charges.

If you refactor these functions, verify the behavior still holds. It is easy to "clean up" the accrual loop and silently break compounding.

---

## Accuracy and scope

The fee and interest figures are estimates. Real billers vary in ways this app does not model: some cap fees by state law, some waive a first offense, some post charges on the statement date rather than the due date, and some apply payments in a different order. Treat the biller's statement as the source of truth and use Ledger to know what to expect and when.

This is a tracking tool, not financial advice.

---

## Privacy

No analytics, no network calls, no third-party services. Nothing leaves the browser.

Two things worth doing:

- Store the last four digits of an account rather than the full number in the notes field. Enough to identify a bill, useless to anyone who gets the data.
- Backup and CSV exports contain real balances. `.gitignore` already excludes `ledger-backup-*.json` and `ledger-*.csv`; keep it that way.

---

## License

MIT. See [LICENSE](LICENSE).
