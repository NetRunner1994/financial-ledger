import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";

/* ================================================================
   LEDGER — bill and debt tracker

   Bills are templates. They post Charges. Each Charge carries its own
   principal, payments, AND a snapshot of the terms in force when it
   posted, so editing a rate today never rewrites last year's math.

   Payments allocate fees -> interest -> principal. Interest compounds
   daily on the outstanding total once grace expires.
   ================================================================ */

const KEY = "ledger:data:v3";
const LEGACY = ["runway:data:v2", "runway:bills:v1"];
const SCHEMA = 3;

const C = {
  bg: "#0F1319",
  panel: "#171C25",
  panel2: "#1E242F",
  line: "#2A3240",
  lineSoft: "#222937",
  ink: "#E9ECF2",
  dim: "#8A94A6",
  dimmer: "#5C6577",
  accent: "#7B8CFF",
  overdue: "#FF5C5C",
  soon: "#F2B33D",
  upcoming: "#5A9FD4",
  paid: "#4CC08D",
};

const MONO = `"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`;
const SANS = `"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

const REPEATS = [
  { id: "once", label: "One time" },
  { id: "weekly", label: "Weekly" },
  { id: "biweekly", label: "Every 2 weeks" },
  { id: "monthly", label: "Monthly" },
  { id: "quarterly", label: "Quarterly" },
  { id: "yearly", label: "Yearly" },
];

const PAY_FREQ = [
  { id: "weekly", label: "Weekly" },
  { id: "biweekly", label: "Every 2 weeks" },
  { id: "semimonthly", label: "1st & 15th" },
  { id: "monthly", label: "Monthly" },
];

/* ---------------- dates (local time only) ---------------- */

const fmtISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

const parseISO = (s) => {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

const todayISO = () => fmtISO(new Date());

/** positive when b is after a */
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

const addDaysISO = (iso, n) => {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return fmtISO(d);
};

const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();

const addMonthsISO = (iso, n, anchor) => {
  const d = parseISO(iso);
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  t.setDate(Math.min(anchor || d.getDate(), lastDay(t.getFullYear(), t.getMonth())));
  return fmtISO(t);
};

const advance = (iso, repeat, anchor, steps = 1) => {
  switch (repeat) {
    case "weekly":
      return addDaysISO(iso, 7 * steps);
    case "biweekly":
      return addDaysISO(iso, 14 * steps);
    case "monthly":
      return addMonthsISO(iso, steps, anchor);
    case "quarterly":
      return addMonthsISO(iso, 3 * steps, anchor);
    case "yearly":
      return addMonthsISO(iso, 12 * steps, anchor);
    default:
      return iso;
  }
};

/** nth occurrence counted from the bill's first due date */
const occurrenceN = (bill, n) =>
  advance(bill.startDate, bill.repeat, bill.anchorDay, n);

/** push weekend due dates to the following Monday */
const shiftBusiness = (iso, on) => {
  if (!on) return iso;
  const d = parseISO(iso).getDay();
  if (d === 6) return addDaysISO(iso, 2);
  if (d === 0) return addDaysISO(iso, 1);
  return iso;
};

const shortDate = (iso) =>
  parseISO(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const longDate = (iso) =>
  parseISO(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

const money = (n) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const uid = () => Math.random().toString(36).slice(2, 10);

/* ================================================================
   THE LEDGER
   ================================================================ */

/** terms in force for a charge: its own snapshot, or the bill as fallback */
const termsOf = (charge, bill) =>
  charge.terms || {
    apr: bill.apr || 0,
    graceDays: bill.graceDays || 0,
    flatFee: bill.flatFee || 0,
  };

function ledgerFor(charge, bill, today) {
  const t = termsOf(charge, bill);
  const grace = Math.max(0, Number(t.graceDays) || 0);
  const graceEnd = addDaysISO(charge.dueDate, grace);
  const rate = Math.max(0, Number(t.apr) || 0) / 100 / 365;
  const flat = Math.max(0, Number(t.flatFee) || 0);

  let principal = Number(charge.principal) || 0;
  let fees = 0;
  let interest = 0;

  const pays = [...(charge.payments || [])]
    .filter((p) => Number(p.amount) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const paidTotal = r2(pays.reduce((s, p) => s + Number(p.amount || 0), 0));

  const apply = (amt) => {
    let rem = Number(amt) || 0;
    const f = Math.min(fees, rem);
    fees -= f;
    rem -= f;
    const i = Math.min(interest, rem);
    interest -= i;
    rem -= i;
    principal -= rem;
  };

  const outstanding = () => principal + fees + interest;
  const settled = (closedOn) => ({
    principal: 0,
    fees: 0,
    interest: 0,
    total: 0,
    paidTotal,
    credit: r2(Math.max(0, -outstanding())),
    closed: true,
    closedOn,
    daysLate: 0,
    dailyCost: 0,
  });

  // anything paid on or before the grace deadline costs nothing extra
  let idx = 0;
  while (idx < pays.length && daysBetween(pays[idx].date, graceEnd) >= 0) {
    apply(pays[idx].amount);
    idx++;
  }
  if (outstanding() <= 0.005)
    return settled(idx > 0 ? pays[idx - 1].date : charge.dueDate);

  // inside grace, or not due yet
  if (daysBetween(graceEnd, today) < 0)
    return {
      principal: r2(principal),
      fees: 0,
      interest: 0,
      total: r2(principal),
      paidTotal,
      credit: 0,
      closed: false,
      closedOn: null,
      daysLate: 0,
      dailyCost: 0,
    };

  // past grace: flat fee once, then daily compounding
  if (flat > 0) fees += flat;

  let cursor = graceEnd;
  let closedOn = null;
  const stops = pays.slice(idx).map((p) => ({ ...p, kind: "pay" }));
  stops.push({ date: today, kind: "now" });

  for (const stop of stops) {
    const at = daysBetween(today, stop.date) > 0 ? today : stop.date;
    const span = daysBetween(cursor, at);
    if (span > 0) {
      if (rate > 0) {
        const base = outstanding();
        if (base > 0) interest += base * Math.pow(1 + rate, span) - base;
      }
      cursor = at;
    }
    if (stop.kind === "pay") {
      apply(stop.amount);
      if (outstanding() <= 0.005) {
        closedOn = stop.date;
        break;
      }
    }
  }
  if (closedOn) return settled(closedOn);

  const total = Math.max(0, outstanding());
  return {
    principal: r2(Math.max(0, principal)),
    fees: r2(Math.max(0, fees)),
    interest: r2(Math.max(0, interest)),
    total: r2(total),
    paidTotal,
    credit: 0,
    closed: false,
    closedOn: null,
    daysLate: Math.max(0, daysBetween(graceEnd, today)),
    dailyCost: r2(total * rate),
  };
}

/* ---------------- charge posting ---------------- */

const snapshot = (bill) => ({
  apr: Number(bill.apr) || 0,
  graceDays: Number(bill.graceDays) || 0,
  flatFee: Number(bill.flatFee) || 0,
});

function postCharges(bill, existing, today) {
  const have = new Set(
    existing.filter((c) => c.billId === bill.id).map((c) => c.dueDate)
  );
  const made = [];
  for (let n = 0; n < 600; n++) {
    const due = shiftBusiness(occurrenceN(bill, n), bill.shiftWeekend);
    if (!have.has(due)) {
      made.push({
        id: uid(),
        billId: bill.id,
        dueDate: due,
        principal: Number(bill.amount) || 0,
        payments: [],
        terms: snapshot(bill),
        postedOn: today,
      });
      have.add(due);
    }
    if (bill.repeat === "once") break;
    if (daysBetween(today, due) >= 0) break;
  }
  return made;
}

function projectAhead(bill, fromISO, days) {
  const out = [];
  if (bill.repeat === "once") return out;
  const end = addDaysISO(fromISO, days - 1);
  for (let n = 0; n < 600; n++) {
    const due = shiftBusiness(occurrenceN(bill, n), bill.shiftWeekend);
    if (daysBetween(due, end) < 0) break;
    if (daysBetween(fromISO, due) >= 0) out.push(due);
  }
  return out;
}

/* ---------------- paycheck periods ---------------- */

/** every payday from startISO through endISO for a given schedule */
function paydaysBetween(pay, startISO, endISO) {
  const out = [];
  if (!pay || !pay.anchor) return out;
  if (pay.freq === "semimonthly") {
    let d = parseISO(startISO);
    let y = d.getFullYear();
    let m = d.getMonth() - 1;
    for (let i = 0; i < 60; i++) {
      const mm = ((m % 12) + 12) % 12;
      const yy = y + Math.floor(m / 12);
      [1, 15].forEach((day) => {
        const iso = fmtISO(new Date(yy, mm, day));
        if (daysBetween(startISO, iso) >= 0 && daysBetween(iso, endISO) >= 0)
          out.push(iso);
      });
      m++;
      if (daysBetween(fmtISO(new Date(yy, mm, 1)), endISO) < 0) break;
    }
    return out.sort();
  }
  const anchorDay = parseISO(pay.anchor).getDate();
  // walk back from the anchor to before the window, then forward
  let n = 0;
  let cur = pay.anchor;
  while (daysBetween(startISO, cur) > 0 && n < 400) {
    n++;
    cur = advance(pay.anchor, pay.freq, anchorDay, -n);
  }
  let step = -n;
  for (let i = 0; i < 400; i++) {
    const iso = advance(pay.anchor, pay.freq, anchorDay, step);
    if (daysBetween(iso, endISO) < 0) break;
    if (daysBetween(startISO, iso) >= 0) out.push(iso);
    step++;
  }
  return out;
}

/** build periods running payday -> day before next payday */
function buildPeriods(pay, today, count = 3) {
  if (!pay || !pay.anchor) return [];
  const from = addDaysISO(today, -45);
  const to = addDaysISO(today, 120);
  const days = paydaysBetween(pay, from, to);
  if (!days.length) return [];
  let startIdx = 0;
  for (let i = 0; i < days.length; i++) {
    if (daysBetween(days[i], today) >= 0) startIdx = i;
    else break;
  }
  const out = [];
  for (let i = startIdx; i < days.length - 1 && out.length < count; i++) {
    out.push({
      payday: days[i],
      start: days[i],
      end: addDaysISO(days[i + 1], -1),
      income: Number(pay.amount) || 0,
    });
  }
  return out;
}

/* ---------------- per-bill rollup ---------------- */

function summarize(bill, charges, today) {
  const rows = charges
    .filter((c) => c.billId === bill.id)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((c) => ({ charge: c, led: ledgerFor(c, bill, today) }));

  const open = rows.filter((x) => !x.led.closed);
  const late = open.filter((x) => x.led.daysLate > 0);

  let status = "clear";
  let nextDue = null;
  if (open.length) {
    nextDue = open[0].charge.dueDate;
    status = late.length
      ? "overdue"
      : daysBetween(today, nextDue) <= 7
      ? "soon"
      : "upcoming";
  }

  return {
    rows,
    open,
    owed: r2(open.reduce((s, x) => s + x.led.total, 0)),
    fees: r2(open.reduce((s, x) => s + x.led.fees, 0)),
    interest: r2(open.reduce((s, x) => s + x.led.interest, 0)),
    daily: r2(open.reduce((s, x) => s + x.led.dailyCost, 0)),
    pastDue: r2(late.reduce((s, x) => s + x.led.total, 0)),
    missedCount: late.length,
    maxDaysLate: late.reduce((m, x) => Math.max(m, x.led.daysLate), 0),
    lifetimePaid: r2(rows.reduce((s, x) => s + x.led.paidTotal, 0)),
    status,
    nextDue,
  };
}

const STATUS = {
  overdue: { label: "Overdue", color: C.overdue },
  soon: { label: "Due soon", color: C.soon },
  upcoming: { label: "Upcoming", color: C.upcoming },
  clear: { label: "Clear", color: C.paid },
};

/* ================================================================
   APP
   ================================================================ */

export default function Ledger() {
  const [bills, setBills] = useState([]);
  const [charges, setCharges] = useState([]);
  const [pay, setPay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [storageOk, setStorageOk] = useState(true);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [toast, setToast] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef(null);

  const today = todayISO();

  const save = useCallback(async (b, c, p) => {
    if (typeof window === "undefined" || !window.storage) return;
    try {
      await window.storage.set(
        KEY,
        JSON.stringify({ schema: SCHEMA, bills: b, charges: c, pay: p })
      );
    } catch (e) {
      setStorageOk(false);
    }
  }, []);

  const commit = useCallback(
    (b, c, p) => {
      setBills(b);
      setCharges(c);
      if (p !== undefined) setPay(p);
      save(b, c, p === undefined ? pay : p);
    },
    [save, pay]
  );

  /* ---- load, migrate, post anything that came due ---- */
  useEffect(() => {
    let alive = true;
    (async () => {
      if (typeof window === "undefined" || !window.storage) {
        if (alive) {
          setStorageOk(false);
          setLoading(false);
        }
        return;
      }
      let b = [];
      let c = [];
      let p = null;
      try {
        const res = await window.storage.get(KEY);
        const d = res && res.value ? JSON.parse(res.value) : null;
        if (d) {
          b = Array.isArray(d.bills) ? d.bills : [];
          c = Array.isArray(d.charges) ? d.charges : [];
          p = d.pay || null;
        }
      } catch (e) {
        /* nothing saved yet */
      }
      if (!b.length) {
        for (const k of LEGACY) {
          try {
            const old = await window.storage.get(k);
            const d = old && old.value ? JSON.parse(old.value) : null;
            if (!d) continue;
            if (Array.isArray(d)) {
              b = d.map((x) => ({
                id: x.id || uid(),
                name: x.name,
                amount: x.amount,
                startDate: x.dueDate,
                anchorDay: parseISO(x.dueDate).getDate(),
                repeat: x.repeat || "monthly",
                apr: 0,
                flatFee: 0,
                graceDays: 0,
                shiftWeekend: false,
                autopay: !!x.autopay,
                notes: x.notes || "",
              }));
            } else if (Array.isArray(d.bills)) {
              b = d.bills;
              c = Array.isArray(d.charges) ? d.charges : [];
            }
            if (b.length) break;
          } catch (e) {
            /* skip */
          }
        }
      }
      // backfill term snapshots on charges written before v3
      const byBill = Object.fromEntries(b.map((x) => [x.id, x]));
      c = c.map((ch) =>
        ch.terms || !byBill[ch.billId]
          ? ch
          : { ...ch, terms: snapshot(byBill[ch.billId]) }
      );

      const fresh = [];
      b.forEach((bill) => fresh.push(...postCharges(bill, [...c, ...fresh], today)));
      const next = [...c, ...fresh];
      if (!alive) return;
      setBills(b);
      setCharges(next);
      setPay(p);
      setLoading(false);
      if (fresh.length || b.length) save(b, next, p);
    })();
    return () => {
      alive = false;
    };
  }, [save, today]);

  const flash = (msg) => {
    const id = uid();
    setToast({ msg, id });
    setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 5000);
  };

  /* ---- actions ---- */

  const saveBill = (data, applyToOpen) => {
    const bill = {
      id: data.id || uid(),
      name: data.name.trim(),
      amount: Math.max(0, parseFloat(data.amount) || 0),
      startDate: data.startDate,
      anchorDay: parseISO(data.startDate).getDate(),
      repeat: data.repeat,
      apr: Math.max(0, parseFloat(data.apr) || 0),
      flatFee: Math.max(0, parseFloat(data.flatFee) || 0),
      graceDays: Math.max(0, parseInt(data.graceDays, 10) || 0),
      shiftWeekend: !!data.shiftWeekend,
      autopay: !!data.autopay,
      notes: (data.notes || "").trim(),
      totalBalance:
        data.totalBalance !== "" && data.totalBalance != null
          ? Math.max(0, parseFloat(data.totalBalance) || 0)
          : null,
      creditLimit:
        data.creditLimit !== "" && data.creditLimit != null
          ? Math.max(0, parseFloat(data.creditLimit) || 0)
          : null,
    };
    const isNew = !bills.some((x) => x.id === bill.id);
    const nextBills = isNew
      ? [...bills, bill]
      : bills.map((x) => (x.id === bill.id ? bill : x));

    let nextCharges = charges;
    if (applyToOpen && !isNew) {
      const snap = snapshot(bill);
      nextCharges = charges.map((ch) => {
        if (ch.billId !== bill.id) return ch;
        const led = ledgerFor(ch, bill, today);
        return led.closed ? ch : { ...ch, terms: snap };
      });
    }
    nextCharges = [...nextCharges, ...postCharges(bill, nextCharges, today)];
    commit(nextBills, nextCharges);
    setView(isNew ? null : { type: "detail", id: bill.id });
  };

  const addPayment = (chargeId, amount, date) => {
    const amt = r2(parseFloat(amount) || 0);
    if (amt <= 0) return;
    commit(
      bills,
      charges.map((c) =>
        c.id === chargeId
          ? { ...c, payments: [...(c.payments || []), { id: uid(), amount: amt, date }] }
          : c
      )
    );
    flash(`${money(amt)} recorded`);
  };

  const removePayment = (chargeId, payId) =>
    commit(
      bills,
      charges.map((c) =>
        c.id === chargeId
          ? { ...c, payments: c.payments.filter((p) => p.id !== payId) }
          : c
      )
    );

  const setChargeAmount = (chargeId, amount) =>
    commit(
      bills,
      charges.map((c) =>
        c.id === chargeId ? { ...c, principal: Math.max(0, parseFloat(amount) || 0) } : c
      )
    );

  const removeBill = (id) => {
    const b = bills.find((x) => x.id === id);
    commit(
      bills.filter((x) => x.id !== id),
      charges.filter((c) => c.billId !== id)
    );
    setView(null);
    if (b) flash(`${b.name} deleted`);
  };

  const resetAll = () => {
    commit([], [], null);
    setConfirmReset(false);
    flash("All data cleared");
  };

  /* ---- derived ---- */

  const book = useMemo(
    () => bills.map((b) => ({ bill: b, sum: summarize(b, charges, today) })),
    [bills, charges, today]
  );

  /* ---- backup / restore ---- */

  const download = (text, filename, type) => {
    try {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) {
      flash("Download is blocked on this device");
      return false;
    }
  };

  const backup = () => {
    const ok = download(
      JSON.stringify({ schema: SCHEMA, exported: today, bills, charges, pay }, null, 2),
      `ledger-backup-${today}.json`,
      "application/json"
    );
    if (ok) flash("Backup saved. Keep it somewhere safe.");
  };

  const exportCSV = () => {
    const lines = ["bill,due_date,billed,paid,fees,interest,still_owed,days_late,status"];
    book.forEach(({ bill, sum }) => {
      sum.rows.forEach(({ charge, led }) => {
        lines.push(
          [
            `"${bill.name.replace(/"/g, '""')}"`,
            charge.dueDate,
            r2(charge.principal),
            led.paidTotal,
            led.fees,
            led.interest,
            led.total,
            led.daysLate,
            led.closed ? "paid" : led.daysLate > 0 ? "overdue" : "open",
          ].join(",")
        );
      });
    });
    if (download(lines.join("\n"), `ledger-${today}.csv`, "text/csv"))
      flash("CSV downloaded");
  };

  const onFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(String(reader.result));
        if (!Array.isArray(d.bills)) throw new Error("shape");
        setView({ type: "restore", data: d });
      } catch (err) {
        flash("That file is not a Ledger backup");
      }
    };
    reader.onerror = () => flash("Could not read that file");
    reader.readAsText(file);
  };

  const doRestore = (data, mode) => {
    const inBills = data.bills || [];
    const inCharges = data.charges || [];
    let b, c;
    if (mode === "replace") {
      b = inBills;
      c = inCharges;
    } else {
      const have = new Set(bills.map((x) => x.id));
      const haveC = new Set(charges.map((x) => x.id));
      b = [...bills, ...inBills.filter((x) => !have.has(x.id))];
      c = [...charges, ...inCharges.filter((x) => !haveC.has(x.id))];
    }
    const byBill = Object.fromEntries(b.map((x) => [x.id, x]));
    c = c.map((ch) =>
      ch.terms || !byBill[ch.billId] ? ch : { ...ch, terms: snapshot(byBill[ch.billId]) }
    );
    const fresh = [];
    b.forEach((bill) => fresh.push(...postCharges(bill, [...c, ...fresh], today)));
    commit(b, [...c, ...fresh], data.pay || pay);
    setView(null);
    flash(`Restored ${b.length} bill${b.length === 1 ? "" : "s"}`);
  };

  /* ---- totals, forecast, periods ---- */

  const totals = useMemo(() => {
    let owed = 0,
      pastDue = 0,
      fees = 0,
      interest = 0,
      daily = 0,
      soon = 0;
    const count = { overdue: 0, soon: 0, upcoming: 0, clear: 0 };
    book.forEach(({ sum }) => {
      count[sum.status]++;
      owed += sum.owed;
      pastDue += sum.pastDue;
      fees += sum.fees;
      interest += sum.interest;
      daily += sum.daily;
      sum.open.forEach((x) => {
        const d = daysBetween(today, x.charge.dueDate);
        if (d >= 0 && d <= 7) soon += x.led.total;
      });
    });
    return {
      owed: r2(owed),
      pastDue: r2(pastDue),
      fees: r2(fees),
      interest: r2(interest),
      daily: r2(daily),
      soon: r2(soon),
      count,
    };
  }, [book, today]);

  const periods = useMemo(() => {
    const list = buildPeriods(pay, today, 3);
    return list.map((p) => {
      const items = [];
      let due = 0;
      book.forEach(({ bill, sum }) => {
        const seen = new Set();
        sum.open.forEach((x) => {
          seen.add(x.charge.dueDate);
          const inWindow =
            daysBetween(p.start, x.charge.dueDate) >= 0 &&
            daysBetween(x.charge.dueDate, p.end) >= 0;
          // anything already past due has to come out of the current check
          const isNow = p.payday === list[0].payday && x.led.daysLate > 0;
          if (inWindow || isNow) {
            due += x.led.total;
            items.push({ name: bill.name, amount: x.led.total, date: x.charge.dueDate });
          }
        });
        projectAhead(bill, today, 130).forEach((iso) => {
          if (seen.has(iso)) return;
          if (daysBetween(p.start, iso) >= 0 && daysBetween(iso, p.end) >= 0) {
            due += bill.amount;
            items.push({ name: bill.name, amount: bill.amount, date: iso });
          }
        });
      });
      items.sort((a, b) => a.date.localeCompare(b.date));
      return { ...p, due: r2(due), left: r2(p.income - due), items };
    });
  }, [book, pay, today]);

  const runway = useMemo(() => {
    const days = [];
    for (let i = 0; i < 30; i++)
      days.push({ iso: addDaysISO(today, i), total: 0, items: [] });
    const idx = Object.fromEntries(days.map((d, i) => [d.iso, i]));
    book.forEach(({ bill, sum }) => {
      const posted = new Set();
      sum.open.forEach((x) => {
        posted.add(x.charge.dueDate);
        const i = idx[x.charge.dueDate];
        if (i === undefined) return;
        days[i].total += x.led.total;
        days[i].items.push(bill.id);
      });
      projectAhead(bill, today, 30).forEach((iso) => {
        if (posted.has(iso)) return;
        const i = idx[iso];
        if (i === undefined) return;
        days[i].total += bill.amount;
        days[i].items.push(bill.id);
      });
    });
    return { days, max: Math.max(1, ...days.map((d) => d.total)) };
  }, [book, today]);

  const visible = useMemo(() => {
    const rank = { overdue: 0, soon: 1, upcoming: 2, clear: 3 };
    let list = [...book].sort((a, b) => {
      if (rank[a.sum.status] !== rank[b.sum.status])
        return rank[a.sum.status] - rank[b.sum.status];
      return (a.sum.nextDue || "9999").localeCompare(b.sum.nextDue || "9999");
    });
    if (selectedDay) {
      const ids = new Set(runway.days.find((d) => d.iso === selectedDay)?.items || []);
      return list.filter((x) => ids.has(x.bill.id));
    }
    if (filter !== "all") list = list.filter((x) => x.sum.status === filter);
    return list;
  }, [book, filter, selectedDay, runway]);

  const selectedInfo = selectedDay
    ? runway.days.find((d) => d.iso === selectedDay)
    : null;
  const detail =
    view?.type === "detail" ? book.find((x) => x.bill.id === view.id) : null;

  /* ============================ render ============================ */

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      <header style={S.header}>
        <div style={S.brand}>
          <img
            src={`${import.meta.env.BASE_URL}icon-192.png`}
            alt=""
            width={36}
            height={36}
            style={S.logo}
          />
          <div>
            <div style={S.wordmark}>
              LED<span style={{ color: C.accent }}>GER</span>
            </div>
            <div style={S.tagline}>what's owed, and when</div>
          </div>
        </div>
        <button className="lg-btn lg-primary" onClick={() => setView({ type: "add" })}>
          + Add bill
        </button>
      </header>

      {!storageOk && (
        <div style={S.warn}>
          Saving is unavailable here, so anything you enter stays only until you close
          this. Reopen the app from the chat to get storage back.
        </div>
      )}

      {loading ? (
        <div style={S.loading}>Loading your book…</div>
      ) : (
        <>
          <section style={S.readout}>
            <div style={{ marginBottom: 14 }}>
              <span style={S.figLabel}>Total owed right now</span>
              <div style={S.owedValue}>
                {money(totals.owed).split(".")[0]}
                <span style={S.owedCents}>.{money(totals.owed).split(".")[1]}</span>
              </div>
              {(totals.fees > 0 || totals.interest > 0) && (
                <div style={S.breakdown}>
                  <span>
                    {money(r2(totals.owed - totals.fees - totals.interest))} principal
                  </span>
                  {totals.fees > 0 && (
                    <>
                      <span style={S.sep}>+</span>
                      <span style={{ color: C.overdue }}>{money(totals.fees)} fees</span>
                    </>
                  )}
                  {totals.interest > 0 && (
                    <>
                      <span style={S.sep}>+</span>
                      <span style={{ color: C.overdue }}>
                        {money(totals.interest)} interest
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            <div style={S.splitRow}>
              <Mini
                label="Past due"
                value={totals.pastDue}
                color={totals.pastDue > 0 ? C.overdue : C.dimmer}
                sub={`${totals.count.overdue} account${
                  totals.count.overdue === 1 ? "" : "s"
                }`}
              />
              <div style={S.vrule} />
              <Mini
                label="Next 7 days"
                value={totals.soon}
                color={totals.soon > 0 ? C.soon : C.dimmer}
                sub={`${totals.count.soon} bill${totals.count.soon === 1 ? "" : "s"}`}
              />
            </div>

            {totals.daily > 0 && (
              <div style={S.meter}>
                <span className="lg-pulse" />
                <span>
                  Interest is adding{" "}
                  <strong style={{ color: C.overdue }}>{money(totals.daily)}</strong> a
                  day. Left alone for 30 days that is {money(r2(totals.daily * 30))} more.
                </span>
              </div>
            )}
          </section>

          {/* ---------- paycheck periods ---------- */}
          <section style={{ marginTop: 20 }}>
            <div style={S.runwayHead}>
              <span style={S.sectionLabel}>By paycheck</span>
              <button className="lg-link" onClick={() => setView({ type: "pay" })}>
                {pay?.anchor ? "edit schedule" : "set up"}
              </button>
            </div>

            {!pay?.anchor ? (
              <div style={S.setupCard}>
                Tell Ledger when you get paid and it splits the bills across each check
                instead of lumping them by month. That is the number that decides whether
                a week is tight.
              </div>
            ) : (
              <div style={S.periodScroll}>
                {periods.map((p, i) => {
                  const short = p.income > 0 && p.left < 0;
                  return (
                    <div
                      key={p.payday}
                      style={{
                        ...S.period,
                        borderColor: short ? "rgba(255,92,92,0.45)" : C.lineSoft,
                      }}
                    >
                      <div style={S.periodHead}>
                        <span>{i === 0 ? "This check" : shortDate(p.payday)}</span>
                        <span style={{ color: C.dimmer }}>
                          {shortDate(p.start)}–{shortDate(p.end)}
                        </span>
                      </div>
                      <div style={S.periodRow}>
                        <span>bills due</span>
                        <strong>{money(p.due)}</strong>
                      </div>
                      {p.income > 0 && (
                        <>
                          <div style={S.periodRow}>
                            <span>take-home</span>
                            <strong>{money(p.income)}</strong>
                          </div>
                          <div
                            style={{
                              ...S.periodLeft,
                              color: short ? C.overdue : C.paid,
                            }}
                          >
                            {short
                              ? `${money(Math.abs(p.left))} short`
                              : `${money(p.left)} left over`}
                          </div>
                        </>
                      )}
                      <div style={S.periodItems}>
                        {p.items.slice(0, 4).map((it, k) => (
                          <div key={k} style={S.periodItem}>
                            <span style={S.periodItemName}>{it.name}</span>
                            <span>{money(it.amount)}</span>
                          </div>
                        ))}
                        {p.items.length > 4 && (
                          <div style={{ color: C.dimmer }}>
                            +{p.items.length - 4} more
                          </div>
                        )}
                        {p.items.length === 0 && (
                          <div style={{ color: C.dimmer }}>nothing due</div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {periods.length === 0 && (
                  <div style={S.setupCard}>
                    Check the payday date on your schedule, nothing lines up yet.
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ---------- 30-day forecast ---------- */}
          <section style={{ marginTop: 20 }}>
            <div style={S.runwayHead}>
              <span style={S.sectionLabel}>30-day forecast</span>
              {selectedInfo ? (
                <button className="lg-link" onClick={() => setSelectedDay(null)}>
                  clear day
                </button>
              ) : (
                <span style={S.hint}>tap a bar</span>
              )}
            </div>

            <div style={S.strip}>
              {runway.days.map((d, i) => {
                const has = d.total > 0;
                const h = has ? 8 + (d.total / runway.max) * 56 : 2;
                const col = has ? (i <= 7 ? C.soon : C.upcoming) : C.lineSoft;
                const active = selectedDay === d.iso;
                return (
                  <button
                    key={d.iso}
                    className="lg-bar"
                    onClick={() => setSelectedDay(active || !has ? null : d.iso)}
                    aria-label={`${longDate(d.iso)}, ${money(d.total)} due`}
                    style={{ opacity: active || !selectedDay ? 1 : 0.3 }}
                  >
                    <span
                      style={{
                        height: h,
                        background: col,
                        boxShadow: active ? `0 0 0 1px ${C.ink}` : "none",
                      }}
                    />
                    {i === 0 && <span className="lg-today" />}
                  </button>
                );
              })}
            </div>
            <div style={S.axis}>
              <span>today</span>
              <span>{shortDate(addDaysISO(today, 15))}</span>
              <span>{shortDate(addDaysISO(today, 29))}</span>
            </div>

            {selectedInfo && (
              <div style={S.dayReadout}>
                <strong style={{ color: C.ink }}>{longDate(selectedInfo.iso)}</strong>
                <span style={{ color: C.dim }}>
                  {selectedInfo.items.length} bill
                  {selectedInfo.items.length === 1 ? "" : "s"} ·{" "}
                  {money(selectedInfo.total)}
                </span>
              </div>
            )}
          </section>

          {!selectedDay && bills.length > 0 && (
            <div style={S.filters}>
              {[
                ["all", `All ${bills.length}`],
                ["overdue", `Overdue ${totals.count.overdue}`],
                ["soon", `Due soon ${totals.count.soon}`],
                ["upcoming", `Upcoming ${totals.count.upcoming}`],
                ["clear", `Clear ${totals.count.clear}`],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={`lg-chip ${filter === id ? "on" : ""}`}
                  onClick={() => setFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <section style={S.list}>
            {bills.length === 0 ? (
              <div style={S.empty}>
                <div style={S.emptyTitle}>Nothing tracked yet</div>
                <p style={S.emptyBody}>
                  Add a bill and the forecast fills in. Recurring ones post themselves
                  each cycle, and anything left unpaid keeps its balance instead of
                  disappearing.
                </p>
                <button
                  className="lg-btn lg-primary"
                  onClick={() => setView({ type: "add" })}
                >
                  Add your first bill
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div style={S.emptySmall}>Nothing here. Try another filter.</div>
            ) : (
              visible.map(({ bill, sum }) => (
                <BillRow
                  key={bill.id}
                  bill={bill}
                  sum={sum}
                  today={today}
                  onOpen={() => setView({ type: "detail", id: bill.id })}
                />
              ))
            )}
          </section>

          <footer style={S.footer}>
            <span style={{ flex: 1, minWidth: 200 }}>
              Fees and interest are estimates. Confirm the real balance with each biller
              before you pay.
            </span>
            <span style={S.footerRow}>
              <button className="lg-link" onClick={backup}>
                Backup
              </button>
              <button className="lg-link" onClick={() => fileRef.current?.click()}>
                Restore
              </button>
              {bills.length > 0 && (
                <button className="lg-link" onClick={exportCSV}>
                  CSV
                </button>
              )}
              {bills.length > 0 &&
                (confirmReset ? (
                  <>
                    <button className="lg-link danger" onClick={resetAll}>
                      Delete everything
                    </button>
                    <button className="lg-link" onClick={() => setConfirmReset(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="lg-link" onClick={() => setConfirmReset(true)}>
                    Clear all
                  </button>
                ))}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={onFile}
              style={{ display: "none" }}
            />
          </footer>
        </>
      )}

      {toast && (
        <div style={S.toast} role="status">
          {toast.msg}
        </div>
      )}

      {(view?.type === "add" || view?.type === "edit") && (
        <BillSheet
          key={view.id || "new"}
          today={today}
          bill={view.type === "edit" ? bills.find((b) => b.id === view.id) : null}
          onSave={saveBill}
          onClose={() =>
            setView(view.type === "edit" ? { type: "detail", id: view.id } : null)
          }
        />
      )}

      {view?.type === "pay" && (
        <PaySheet
          pay={pay}
          today={today}
          onSave={(p) => {
            commit(bills, charges, p);
            setView(null);
          }}
          onClear={() => {
            commit(bills, charges, null);
            setView(null);
          }}
          onClose={() => setView(null)}
        />
      )}

      {view?.type === "restore" && (
        <RestoreSheet
          data={view.data}
          hasExisting={bills.length > 0}
          onRestore={doRestore}
          onClose={() => setView(null)}
        />
      )}

      {detail && (
        <DetailSheet
          key={detail.bill.id}
          bill={detail.bill}
          sum={detail.sum}
          today={today}
          onPay={addPayment}
          onRemovePayment={removePayment}
          onSetAmount={setChargeAmount}
          onEdit={() => setView({ type: "edit", id: detail.bill.id })}
          onDelete={() => removeBill(detail.bill.id)}
          onClose={() => setView(null)}
        />
      )}
    </div>
  );
}

/* ================================================================
   PIECES
   ================================================================ */

function Mini({ label, value, color, sub }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <span style={S.figLabel}>{label}</span>
      <div style={{ ...S.miniValue, color }}>{money(value)}</div>
      <div style={S.figSub}>{sub}</div>
    </div>
  );
}

function BillRow({ bill, sum, today, onOpen }) {
  const meta = STATUS[sum.status];
  const phrase = () => {
    if (sum.status === "clear") return "Nothing owed";
    if (sum.status === "overdue")
      return sum.maxDaysLate === 1 ? "1 day late" : `${sum.maxDaysLate} days late`;
    const d = daysBetween(today, sum.nextDue);
    if (d === 0) return "Due today";
    if (d === 1) return "Due tomorrow";
    return `Due in ${d} days`;
  };
  return (
    <button
      className="lg-rowbtn"
      onClick={onOpen}
      style={{ borderLeft: `3px solid ${meta.color}` }}
    >
      <div style={S.rowTop}>
        <span style={S.rowName}>{bill.name}</span>
        <span style={S.rowAmount}>{money(sum.owed)}</span>
      </div>
      <div style={S.rowBottom}>
        <span style={{ color: meta.color, fontWeight: 500 }}>{phrase()}</span>
        {sum.nextDue && (
          <>
            <span style={S.sep}>·</span>
            <span>{shortDate(sum.nextDue)}</span>
          </>
        )}
        {sum.missedCount > 1 && (
          <>
            <span style={S.sep}>·</span>
            <span style={{ color: C.overdue }}>{sum.missedCount} cycles behind</span>
          </>
        )}
        {bill.apr > 0 && <span style={S.tag}>{bill.apr}% APR</span>}
        {bill.autopay && <span style={S.tag}>AUTO</span>}
        {bill.creditLimit > 0 && bill.totalBalance != null && (
          <span style={S.tag}>
            {Math.round(Math.min(100, (bill.totalBalance / bill.creditLimit) * 100))}%
            of limit
          </span>
        )}
      </div>
      {(sum.fees > 0 || sum.interest > 0) && (
        <div style={S.rowFee}>
          {money(r2(sum.fees + sum.interest))} of that is fees and interest
          {sum.daily > 0 && ` · +${money(sum.daily)}/day`}
        </div>
      )}
    </button>
  );
}

/* ---------------- add / edit ---------------- */

function BillSheet({ bill, today, onSave, onClose }) {
  const [f, setF] = useState({
    name: bill?.name || "",
    amount: bill ? String(bill.amount) : "",
    startDate: bill?.startDate || today,
    repeat: bill?.repeat || "monthly",
    apr: bill?.apr ? String(bill.apr) : "",
    flatFee: bill?.flatFee ? String(bill.flatFee) : "",
    graceDays: bill ? String(bill.graceDays ?? 0) : "0",
    shiftWeekend: bill?.shiftWeekend || false,
    autopay: bill?.autopay || false,
    notes: bill?.notes || "",
    totalBalance: bill?.totalBalance != null ? String(bill.totalBalance) : "",
    creditLimit: bill?.creditLimit != null ? String(bill.creditLimit) : "",
  });
  const [advanced, setAdvanced] = useState(
    !!(bill && (bill.apr || bill.flatFee || bill.graceDays || bill.shiftWeekend))
  );
  const [showBalance, setShowBalance] = useState(
    !!(bill && (bill.totalBalance != null || bill.creditLimit != null))
  );
  const [applyToOpen, setApplyToOpen] = useState(false);
  const [error, setError] = useState("");
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const termsChanged =
    bill &&
    (String(bill.apr || 0) !== String(parseFloat(f.apr) || 0) ||
      String(bill.flatFee || 0) !== String(parseFloat(f.flatFee) || 0) ||
      String(bill.graceDays || 0) !== String(parseInt(f.graceDays, 10) || 0));

  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const submit = () => {
    if (!f.name.trim()) return setError("Give the bill a name so you recognize it.");
    const amt = parseFloat(f.amount);
    if (!Number.isFinite(amt) || amt <= 0)
      return setError("Enter an amount greater than zero.");
    if (!f.startDate) return setError("Pick the first due date.");
    onSave({ ...f, id: bill?.id }, applyToOpen);
  };

  return (
    <Scrim onClose={onClose}>
      <div style={S.sheetHead}>
        <span style={S.sheetTitle}>{bill ? "Edit bill" : "New bill"}</span>
        <button className="lg-link" onClick={onClose}>
          Close
        </button>
      </div>

      <Field label="Name">
        <input
          className="lg-input"
          value={f.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Rent, electric, Discover card…"
          autoFocus
        />
      </Field>

      <div style={S.fieldRow}>
        <Field label="Amount per cycle" flex>
          <input
            className="lg-input"
            value={f.amount}
            inputMode="decimal"
            onChange={(e) => set("amount", e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
          />
        </Field>
        <Field label="First due date" flex>
          <input
            className="lg-input"
            type="date"
            value={f.startDate}
            onChange={(e) => set("startDate", e.target.value)}
          />
        </Field>
      </div>

      <Field label="Repeats">
        <div style={S.chipGrid}>
          {REPEATS.map((r) => (
            <button
              key={r.id}
              className={`lg-chip ${f.repeat === r.id ? "on" : ""}`}
              onClick={() => set("repeat", r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </Field>

      <button className="lg-disclose" onClick={() => setAdvanced(!advanced)}>
        {advanced ? "−" : "+"} Late fees and interest
      </button>

      {advanced && (
        <div style={S.advanced}>
          <div style={S.fieldRow}>
            <Field label="Grace days" flex>
              <input
                className="lg-input"
                value={f.graceDays}
                inputMode="numeric"
                onChange={(e) => set("graceDays", e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="0"
              />
            </Field>
            <Field label="APR %" flex>
              <input
                className="lg-input"
                value={f.apr}
                inputMode="decimal"
                onChange={(e) => set("apr", e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="24.99"
              />
            </Field>
          </div>
          <Field label="Flat late fee (optional)">
            <input
              className="lg-input"
              value={f.flatFee}
              inputMode="decimal"
              onChange={(e) => set("flatFee", e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="35.00"
            />
          </Field>
          <p style={S.helper}>
            Interest compounds daily on whatever is still unpaid once grace runs out. A
            flat fee lands once per missed cycle. Both are estimates, so check them
            against your statement.
          </p>
          <Toggle
            on={f.shiftWeekend}
            onClick={() => set("shiftWeekend", !f.shiftWeekend)}
            title="Move weekend due dates to Monday"
            hint="for billers that post on business days"
          />
        </div>
      )}

      {termsChanged && (
        <div style={S.notice}>
          <Toggle
            on={applyToOpen}
            onClick={() => setApplyToOpen(!applyToOpen)}
            title="Apply new terms to open charges"
            hint="off means past charges keep the rate they were billed under"
          />
        </div>
      )}

      <button className="lg-disclose" onClick={() => setShowBalance(!showBalance)}>
        {showBalance ? "−" : "+"} Total balance & limit
      </button>

      {showBalance && (
        <div style={S.advanced}>
          <div style={S.fieldRow}>
            <Field label="Total balance owed" flex>
              <input
                className="lg-input"
                value={f.totalBalance}
                inputMode="decimal"
                onChange={(e) =>
                  set("totalBalance", e.target.value.replace(/[^0-9.]/g, ""))
                }
                placeholder="0.00"
              />
            </Field>
            <Field label="Credit limit (optional)" flex>
              <input
                className="lg-input"
                value={f.creditLimit}
                inputMode="decimal"
                onChange={(e) =>
                  set("creditLimit", e.target.value.replace(/[^0-9.]/g, ""))
                }
                placeholder="0.00"
              />
            </Field>
          </div>
          <p style={S.helper}>
            For reference only, so this doesn't feed into what posts each cycle above.
            Use it for a card's full statement balance against its limit, a mortgage or
            loan's remaining principal, or anything else with a running total worth
            tracking.
          </p>
        </div>
      )}

      <Toggle
        on={f.autopay}
        onClick={() => set("autopay", !f.autopay)}
        title="On autopay"
        hint="still tracked, just flagged"
      />

      <Field label="Notes">
        <input
          className="lg-input"
          value={f.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Last 4 of the account, who it's with, anything"
        />
      </Field>

      {error && <div style={S.error}>{error}</div>}

      <button className="lg-btn lg-primary wide" onClick={submit}>
        {bill ? "Save changes" : "Add bill"}
      </button>
    </Scrim>
  );
}

/* ---------------- paycheck schedule ---------------- */

function PaySheet({ pay, today, onSave, onClear, onClose }) {
  const [freq, setFreq] = useState(pay?.freq || "biweekly");
  const [anchor, setAnchor] = useState(pay?.anchor || today);
  const [amount, setAmount] = useState(pay?.amount ? String(pay.amount) : "");

  return (
    <Scrim onClose={onClose}>
      <div style={S.sheetHead}>
        <span style={S.sheetTitle}>Paycheck schedule</span>
        <button className="lg-link" onClick={onClose}>
          Close
        </button>
      </div>

      <Field label="How often">
        <div style={S.chipGrid}>
          {PAY_FREQ.map((r) => (
            <button
              key={r.id}
              className={`lg-chip ${freq === r.id ? "on" : ""}`}
              onClick={() => setFreq(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </Field>

      {freq !== "semimonthly" && (
        <Field label="A recent or upcoming payday">
          <input
            className="lg-input"
            type="date"
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
          />
        </Field>
      )}

      <Field label="Take-home per check (optional)">
        <input
          className="lg-input"
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.00"
        />
      </Field>
      <p style={S.helper}>
        Leave the amount blank and Ledger still splits bills by pay period, it just will
        not tell you whether a check covers them.
      </p>

      <button
        className="lg-btn lg-primary wide"
        onClick={() =>
          onSave({
            freq,
            anchor: freq === "semimonthly" ? today : anchor,
            amount: Math.max(0, parseFloat(amount) || 0),
          })
        }
      >
        Save schedule
      </button>

      {pay?.anchor && (
        <div style={{ marginTop: 16 }}>
          <button className="lg-link danger" onClick={onClear}>
            Remove schedule
          </button>
        </div>
      )}
    </Scrim>
  );
}

/* ---------------- restore ---------------- */

function RestoreSheet({ data, hasExisting, onRestore, onClose }) {
  const n = (data.bills || []).length;
  const c = (data.charges || []).length;
  return (
    <Scrim onClose={onClose}>
      <div style={S.sheetHead}>
        <span style={S.sheetTitle}>Restore backup</span>
        <button className="lg-link" onClick={onClose}>
          Close
        </button>
      </div>
      <p style={S.restoreBody}>
        This file holds <strong style={{ color: C.ink }}>{n}</strong> bill
        {n === 1 ? "" : "s"} and <strong style={{ color: C.ink }}>{c}</strong> charge
        record{c === 1 ? "" : "s"}
        {data.exported ? `, saved ${shortDate(data.exported)}` : ""}.
      </p>
      {hasExisting ? (
        <>
          <button
            className="lg-btn lg-primary wide"
            onClick={() => onRestore(data, "merge")}
          >
            Merge with what's here
          </button>
          <p style={S.helper}>
            Merge keeps everything you already have and adds anything the file has that
            you don't. Replace throws out your current data first.
          </p>
          <button className="lg-btn wide" onClick={() => onRestore(data, "replace")}>
            Replace everything
          </button>
        </>
      ) : (
        <button
          className="lg-btn lg-primary wide"
          onClick={() => onRestore(data, "replace")}
        >
          Restore
        </button>
      )}
    </Scrim>
  );
}

/* ---------------- detail + payments ---------------- */

function DetailSheet({
  bill,
  sum,
  today,
  onPay,
  onRemovePayment,
  onSetAmount,
  onEdit,
  onDelete,
  onClose,
}) {
  const [payFor, setPayFor] = useState(null);
  const [payAmt, setPayAmt] = useState("");
  const [payDate, setPayDate] = useState(today);
  const [editAmt, setEditAmt] = useState(null);
  const [amtDraft, setAmtDraft] = useState("");
  const [showPaid, setShowPaid] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const rows = sum.rows.filter((r) => showPaid || !r.led.closed);
  const meta = STATUS[sum.status];

  return (
    <Scrim onClose={onClose}>
      <div style={S.sheetHead}>
        <span style={S.sheetTitle}>{bill.name}</span>
        <button className="lg-link" onClick={onClose}>
          Close
        </button>
      </div>

      <div style={{ ...S.detailTop, borderColor: meta.color }}>
        <span style={S.figLabel}>Owed on this account</span>
        <div style={{ ...S.owedValue, fontSize: 26 }}>{money(sum.owed)}</div>
        <div style={S.detailStats}>
          {sum.fees > 0 && (
            <span>
              fees <strong style={{ color: C.overdue }}>{money(sum.fees)}</strong>
            </span>
          )}
          {sum.interest > 0 && (
            <span>
              interest <strong style={{ color: C.overdue }}>{money(sum.interest)}</strong>
            </span>
          )}
          {sum.daily > 0 && (
            <span>
              growing <strong style={{ color: C.overdue }}>{money(sum.daily)}</strong>/day
            </span>
          )}
          {bill.graceDays > 0 && <span>{bill.graceDays}-day grace</span>}
          {bill.apr > 0 && <span>{bill.apr}% APR</span>}
          {sum.lifetimePaid > 0 && <span>{money(sum.lifetimePaid)} paid to date</span>}
        </div>
      </div>

      {(bill.totalBalance != null || bill.creditLimit != null) && (
        <div style={S.balanceBlock}>
          <div style={S.balanceRow}>
            <span style={S.figLabel}>
              {bill.creditLimit != null ? "Balance vs. limit" : "Total balance owed"}
            </span>
            <span style={S.balanceValue}>
              {bill.totalBalance != null ? money(bill.totalBalance) : "—"}
              {bill.creditLimit != null && (
                <span style={S.balanceOf}> of {money(bill.creditLimit)}</span>
              )}
            </span>
          </div>
          {bill.creditLimit > 0 && bill.totalBalance != null && (
            <>
              <div style={S.utilTrack}>
                <div
                  style={{
                    ...S.utilFill,
                    width: `${Math.min(100, (bill.totalBalance / bill.creditLimit) * 100)}%`,
                    background:
                      bill.totalBalance / bill.creditLimit >= 0.7
                        ? C.overdue
                        : bill.totalBalance / bill.creditLimit >= 0.3
                        ? C.soon
                        : C.paid,
                  }}
                />
              </div>
              <div style={S.figSub}>
                {Math.round(Math.min(100, (bill.totalBalance / bill.creditLimit) * 100))}%
                of limit used
              </div>
            </>
          )}
        </div>
      )}

      {bill.notes && <p style={S.notes}>{bill.notes}</p>}

      <div style={S.detailHead}>
        <span style={S.sectionLabel}>Charges</span>
        <button className="lg-link" onClick={() => setShowPaid(!showPaid)}>
          {showPaid ? "hide settled" : "show settled"}
        </button>
      </div>

      <div style={S.chargeList}>
        {rows.length === 0 && (
          <div style={S.emptySmall}>Nothing outstanding on this one.</div>
        )}
        {rows.map(({ charge, led }) => {
          const late = led.daysLate > 0;
          const color = led.closed ? C.paid : late ? C.overdue : C.upcoming;
          const t = termsOf(charge, bill);
          const drift =
            t.apr !== (bill.apr || 0) ||
            t.graceDays !== (bill.graceDays || 0) ||
            t.flatFee !== (bill.flatFee || 0);
          return (
            <div key={charge.id} style={{ ...S.charge, borderLeft: `2px solid ${color}` }}>
              <div style={S.chargeTop}>
                <span style={{ fontFamily: MONO, fontSize: 12 }}>
                  {longDate(charge.dueDate)}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color }}>
                  {led.closed ? "settled" : money(led.total)}
                </span>
              </div>

              <div style={S.chargeMath}>
                {editAmt === charge.id ? (
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      className="lg-input tiny"
                      value={amtDraft}
                      inputMode="decimal"
                      onChange={(e) => setAmtDraft(e.target.value.replace(/[^0-9.]/g, ""))}
                      autoFocus
                    />
                    <button
                      className="lg-link"
                      onClick={() => {
                        onSetAmount(charge.id, amtDraft);
                        setEditAmt(null);
                      }}
                    >
                      save
                    </button>
                    <button className="lg-link" onClick={() => setEditAmt(null)}>
                      cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="lg-inline"
                    onClick={() => {
                      setEditAmt(charge.id);
                      setAmtDraft(String(charge.principal));
                    }}
                  >
                    {money(charge.principal)} billed
                  </button>
                )}
                {led.paidTotal > 0 && (
                  <span style={{ color: C.paid }}>− {money(led.paidTotal)} paid</span>
                )}
                {led.fees > 0 && (
                  <span style={{ color: C.overdue }}>+ {money(led.fees)} fee</span>
                )}
                {led.interest > 0 && (
                  <span style={{ color: C.overdue }}>+ {money(led.interest)} interest</span>
                )}
                {late && <span style={{ color: C.overdue }}>{led.daysLate}d late</span>}
              </div>

              {drift && !led.closed && (
                <div style={S.driftNote}>
                  billed under {t.apr || 0}% APR / {t.graceDays || 0}-day grace
                </div>
              )}

              {charge.payments?.length > 0 && (
                <div style={S.payList}>
                  {[...charge.payments]
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .map((p) => (
                      <div key={p.id} style={S.payRow}>
                        <span>{shortDate(p.date)}</span>
                        <span>{money(p.amount)}</span>
                        <button
                          className="lg-link danger"
                          onClick={() => onRemovePayment(charge.id, p.id)}
                        >
                          remove
                        </button>
                      </div>
                    ))}
                </div>
              )}

              {!led.closed &&
                (payFor === charge.id ? (
                  <div style={S.payForm}>
                    <input
                      className="lg-input tiny"
                      value={payAmt}
                      inputMode="decimal"
                      onChange={(e) => setPayAmt(e.target.value.replace(/[^0-9.]/g, ""))}
                      placeholder="0.00"
                      autoFocus
                    />
                    <input
                      className="lg-input tiny"
                      type="date"
                      value={payDate}
                      onChange={(e) => setPayDate(e.target.value)}
                    />
                    <button
                      className="lg-btn lg-primary sm"
                      onClick={() => {
                        onPay(charge.id, payAmt, payDate);
                        setPayFor(null);
                      }}
                    >
                      Record
                    </button>
                    <button className="lg-link" onClick={() => setPayFor(null)}>
                      cancel
                    </button>
                  </div>
                ) : (
                  <div style={S.chargeActions}>
                    <button
                      className="lg-btn sm"
                      onClick={() => {
                        setPayFor(charge.id);
                        setPayAmt(led.total.toFixed(2));
                        setPayDate(today);
                      }}
                    >
                      Pay in full
                    </button>
                    <button
                      className="lg-btn sm"
                      onClick={() => {
                        setPayFor(charge.id);
                        setPayAmt("");
                        setPayDate(today);
                      }}
                    >
                      Partial payment
                    </button>
                  </div>
                ))}
            </div>
          );
        })}
      </div>

      <div style={S.detailFoot}>
        <button className="lg-btn" onClick={onEdit}>
          Edit bill settings
        </button>
        {confirmDel ? (
          <span style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 12 }}>
            <span style={{ color: C.dim }}>Delete this and its history?</span>
            <button className="lg-link danger" onClick={onDelete}>
              Delete
            </button>
            <button className="lg-link" onClick={() => setConfirmDel(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button className="lg-link danger" onClick={() => setConfirmDel(true)}>
            Delete bill
          </button>
        )}
      </div>
    </Scrim>
  );
}

/* ---------------- shared ---------------- */

function Scrim({ children, onClose }) {
  return (
    <div style={S.scrim} onClick={onClose}>
      <div style={S.sheet} onClick={(e) => e.stopPropagation()} role="dialog">
        {children}
      </div>
    </div>
  );
}

function Field({ label, children, flex }) {
  return (
    <div style={{ ...S.field, ...(flex ? { flex: 1, minWidth: 0 } : {}) }}>
      <span style={S.label}>{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, onClick, title, hint }) {
  return (
    <button className="lg-toggle" onClick={onClick} aria-pressed={on}>
      <span
        style={{
          ...S.checkbox,
          background: on ? C.accent : "transparent",
          borderColor: on ? C.accent : C.line,
        }}
      >
        {on ? "✓" : ""}
      </span>
      <span>
        {title}
        <span style={S.toggleHint}>{hint}</span>
      </span>
    </button>
  );
}

/* ================================================================
   STYLES
   ================================================================ */

const S = {
  root: {
    minHeight: "100vh",
    background: C.bg,
    color: C.ink,
    fontFamily: SANS,
    padding: "18px 16px 40px",
    maxWidth: 720,
    margin: "0 auto",
    position: "relative",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 20,
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  logo: {
    borderRadius: 8,
    flexShrink: 0,
  },
  wordmark: {
    fontFamily: MONO,
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: "0.16em",
    lineHeight: 1,
  },
  tagline: {
    fontFamily: MONO,
    fontSize: 10,
    color: C.dimmer,
    letterSpacing: "0.08em",
    marginTop: 6,
  },
  warn: {
    background: "rgba(242,179,61,0.08)",
    border: "1px solid rgba(242,179,61,0.3)",
    color: C.soon,
    fontSize: 12,
    padding: "10px 12px",
    borderRadius: 6,
    marginBottom: 16,
    lineHeight: 1.5,
  },
  loading: { color: C.dim, fontSize: 13, padding: "40px 0", textAlign: "center" },

  readout: {
    background: C.panel,
    border: `1px solid ${C.lineSoft}`,
    borderRadius: 8,
    padding: "16px 14px 14px",
  },
  owedValue: {
    fontFamily: MONO,
    fontSize: 34,
    fontWeight: 700,
    letterSpacing: "-0.03em",
    lineHeight: 1,
  },
  owedCents: { fontSize: 17, fontWeight: 400, opacity: 0.5 },
  breakdown: {
    fontFamily: MONO,
    fontSize: 10,
    color: C.dim,
    marginTop: 9,
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
    alignItems: "center",
  },
  splitRow: {
    display: "flex",
    gap: 14,
    paddingTop: 14,
    borderTop: `1px solid ${C.lineSoft}`,
  },
  vrule: { width: 1, background: C.lineSoft },
  figLabel: {
    fontFamily: MONO,
    fontSize: 9,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: C.dimmer,
    marginBottom: 7,
    display: "block",
  },
  miniValue: { fontFamily: MONO, fontSize: 16, fontWeight: 600, lineHeight: 1 },
  figSub: { fontSize: 10, color: C.dimmer, marginTop: 6, fontFamily: MONO },
  meter: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    marginTop: 14,
    paddingTop: 13,
    borderTop: `1px solid ${C.lineSoft}`,
    fontSize: 11.5,
    color: C.dim,
    lineHeight: 1.5,
  },

  setupCard: {
    background: C.panel,
    border: `1px dashed ${C.line}`,
    borderRadius: 8,
    padding: "16px 14px",
    fontSize: 12.5,
    color: C.dim,
    lineHeight: 1.6,
  },
  periodScroll: {
    display: "flex",
    gap: 9,
    overflowX: "auto",
    paddingBottom: 4,
    scrollbarWidth: "thin",
  },
  period: {
    flex: "0 0 auto",
    width: 190,
    background: C.panel,
    border: "1px solid",
    borderRadius: 8,
    padding: "12px 12px 11px",
  },
  periodHead: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: "0.06em",
    marginBottom: 11,
    color: C.ink,
  },
  periodRow: {
    display: "flex",
    justifyContent: "space-between",
    fontFamily: MONO,
    fontSize: 11.5,
    color: C.dim,
    marginBottom: 5,
  },
  periodLeft: {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 600,
    marginTop: 8,
    paddingTop: 8,
    borderTop: `1px solid ${C.lineSoft}`,
  },
  periodItems: {
    marginTop: 10,
    paddingTop: 9,
    borderTop: `1px solid ${C.lineSoft}`,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontFamily: MONO,
    fontSize: 10,
    color: C.dim,
  },
  periodItem: { display: "flex", justifyContent: "space-between", gap: 8 },
  periodItemName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 110,
  },

  runwayHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 10,
  },
  sectionLabel: {
    fontFamily: MONO,
    fontSize: 9,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: C.dim,
  },
  hint: { fontFamily: MONO, fontSize: 9, color: C.dimmer },
  strip: {
    display: "flex",
    alignItems: "flex-end",
    gap: 2,
    height: 72,
    paddingBottom: 2,
    borderBottom: `1px solid ${C.line}`,
  },
  axis: {
    display: "flex",
    justifyContent: "space-between",
    fontFamily: MONO,
    fontSize: 9,
    color: C.dimmer,
    marginTop: 7,
    letterSpacing: "0.06em",
  },
  dayReadout: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
    fontSize: 12,
    marginTop: 12,
    padding: "9px 11px",
    background: C.panel2,
    borderRadius: 6,
    fontFamily: MONO,
  },
  filters: { display: "flex", gap: 6, flexWrap: "wrap", margin: "22px 0 12px" },
  list: { display: "flex", flexDirection: "column", gap: 7, marginTop: 12 },

  rowTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
    marginBottom: 5,
  },
  rowName: {
    fontSize: 14,
    fontWeight: 500,
    color: C.ink,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowAmount: { fontFamily: MONO, fontSize: 15, fontWeight: 600, flexShrink: 0 },
  rowBottom: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: C.dim,
    fontFamily: MONO,
    flexWrap: "wrap",
  },
  rowFee: { fontFamily: MONO, fontSize: 10, color: C.overdue, marginTop: 7, opacity: 0.85 },
  sep: { color: C.dimmer },
  tag: {
    fontSize: 8,
    letterSpacing: "0.1em",
    color: C.accent,
    border: "1px solid rgba(123,140,255,0.4)",
    borderRadius: 3,
    padding: "1px 4px",
  },

  empty: {
    textAlign: "center",
    padding: "44px 20px",
    background: C.panel,
    borderRadius: 8,
    border: `1px dashed ${C.line}`,
  },
  emptyTitle: {
    fontFamily: MONO,
    fontSize: 13,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    marginBottom: 10,
  },
  emptyBody: {
    fontSize: 13,
    color: C.dim,
    lineHeight: 1.6,
    maxWidth: 360,
    margin: "0 auto 20px",
  },
  emptySmall: {
    fontSize: 12,
    color: C.dim,
    padding: "22px 0",
    textAlign: "center",
    fontFamily: MONO,
  },
  footer: {
    marginTop: 26,
    paddingTop: 14,
    borderTop: `1px solid ${C.lineSoft}`,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
    fontSize: 10,
    color: C.dimmer,
    fontFamily: MONO,
    lineHeight: 1.6,
  },
  footerRow: { display: "flex", gap: 12, flexShrink: 0, flexWrap: "wrap" },

  toast: {
    position: "fixed",
    left: "50%",
    bottom: 20,
    transform: "translateX(-50%)",
    background: C.panel2,
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    padding: "11px 15px",
    fontSize: 12,
    boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
    zIndex: 90,
    maxWidth: "90vw",
  },
  scrim: {
    position: "fixed",
    inset: 0,
    background: "rgba(6,8,12,0.78)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    zIndex: 80,
  },
  sheet: {
    background: C.panel,
    borderTop: `1px solid ${C.line}`,
    borderRadius: "12px 12px 0 0",
    padding: "18px 16px 26px",
    width: "100%",
    maxWidth: 560,
    maxHeight: "94vh",
    overflowY: "auto",
    animation: "lgUp 220ms cubic-bezier(0.2,0.8,0.2,1)",
  },
  sheetHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 18,
    gap: 12,
  },
  sheetTitle: {
    fontFamily: MONO,
    fontSize: 12,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: C.dim,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  field: { marginBottom: 15, display: "flex", flexDirection: "column" },
  fieldRow: { display: "flex", gap: 10 },
  label: {
    fontFamily: MONO,
    fontSize: 9,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: C.dimmer,
    marginBottom: 7,
  },
  chipGrid: { display: "flex", flexWrap: "wrap", gap: 6 },
  advanced: {
    background: C.bg,
    border: `1px solid ${C.lineSoft}`,
    borderRadius: 7,
    padding: "14px 12px 4px",
    marginBottom: 15,
  },
  notice: {
    background: "rgba(123,140,255,0.07)",
    border: "1px solid rgba(123,140,255,0.25)",
    borderRadius: 7,
    padding: "12px 12px 0",
    marginBottom: 15,
  },
  helper: { fontSize: 11, color: C.dimmer, lineHeight: 1.6, margin: "0 0 12px" },
  restoreBody: { fontSize: 13, color: C.dim, lineHeight: 1.6, margin: "0 0 18px" },
  checkbox: {
    width: 17,
    height: 17,
    borderRadius: 4,
    border: `1px solid ${C.line}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    color: C.bg,
    flexShrink: 0,
  },
  toggleHint: {
    display: "block",
    fontSize: 10,
    color: C.dimmer,
    marginTop: 3,
    fontFamily: MONO,
    lineHeight: 1.5,
  },
  error: {
    fontSize: 12,
    color: C.overdue,
    marginBottom: 12,
    background: "rgba(255,92,92,0.08)",
    padding: "9px 11px",
    borderRadius: 5,
  },

  detailTop: {
    border: "1px solid",
    borderRadius: 8,
    padding: "14px 13px",
    background: C.bg,
    marginBottom: 14,
  },
  detailStats: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 12,
    fontFamily: MONO,
    fontSize: 10,
    color: C.dim,
  },
  notes: { fontSize: 12, color: C.dim, margin: "0 0 16px", lineHeight: 1.5 },
  balanceBlock: {
    background: C.panel,
    border: `1px solid ${C.lineSoft}`,
    borderRadius: 7,
    padding: "11px 12px",
    marginBottom: 16,
  },
  balanceRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
  },
  balanceValue: { fontFamily: MONO, fontSize: 15, fontWeight: 600, color: C.ink },
  balanceOf: { fontSize: 11, fontWeight: 400, color: C.dimmer },
  utilTrack: {
    height: 5,
    borderRadius: 5,
    background: C.lineSoft,
    marginTop: 9,
    overflow: "hidden",
  },
  utilFill: { height: "100%", borderRadius: 5 },
  detailHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 10,
  },
  chargeList: { display: "flex", flexDirection: "column", gap: 8 },
  charge: { background: C.panel2, borderRadius: 6, padding: "11px 12px" },
  chargeTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
    marginBottom: 7,
  },
  chargeMath: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    fontFamily: MONO,
    fontSize: 10.5,
    color: C.dim,
    alignItems: "center",
  },
  driftNote: {
    fontFamily: MONO,
    fontSize: 9.5,
    color: C.dimmer,
    marginTop: 7,
    letterSpacing: "0.04em",
  },
  chargeActions: { display: "flex", gap: 7, marginTop: 11 },
  payForm: {
    display: "flex",
    gap: 6,
    marginTop: 11,
    alignItems: "center",
    flexWrap: "wrap",
  },
  payList: {
    marginTop: 9,
    paddingTop: 8,
    borderTop: `1px solid ${C.line}`,
    display: "flex",
    flexDirection: "column",
    gap: 5,
  },
  payRow: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    fontFamily: MONO,
    fontSize: 10.5,
    color: C.dim,
  },
  detailFoot: {
    marginTop: 22,
    paddingTop: 16,
    borderTop: `1px solid ${C.lineSoft}`,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap');

* { box-sizing: border-box; }
button { font-family: inherit; cursor: pointer; }

.lg-btn {
  border: 1px solid ${C.line};
  background: ${C.panel2};
  color: ${C.ink};
  font-size: 13px;
  font-weight: 500;
  padding: 9px 15px;
  border-radius: 6px;
  white-space: nowrap;
  transition: background 140ms ease, border-color 140ms ease;
}
.lg-btn:hover { background: ${C.line}; }
.lg-btn.sm { font-size: 11px; padding: 7px 11px; }
.lg-btn.wide { width: 100%; padding: 13px; font-size: 14px; margin-top: 4px; }
.lg-primary { background: ${C.accent}; border-color: ${C.accent}; color: #0B0E14; font-weight: 600; }
.lg-primary:hover { background: #92A0FF; border-color: #92A0FF; }

.lg-link {
  background: none; border: none; padding: 0;
  color: ${C.accent};
  font-size: 11px;
  font-family: ${MONO};
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.lg-link:hover { text-decoration: underline; }
.lg-link.danger { color: ${C.overdue}; }

.lg-inline {
  background: none; border: none; padding: 0;
  color: ${C.dim};
  font-family: ${MONO}; font-size: 10.5px;
  border-bottom: 1px dashed ${C.line};
}
.lg-inline:hover { color: ${C.ink}; border-bottom-color: ${C.dim}; }

.lg-disclose {
  background: none;
  border: 1px solid ${C.line};
  border-radius: 6px;
  color: ${C.dim};
  font-family: ${MONO};
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 9px 12px;
  width: 100%;
  text-align: left;
  margin-bottom: 15px;
}
.lg-disclose:hover { color: ${C.ink}; border-color: ${C.dim}; }

.lg-chip {
  background: transparent;
  border: 1px solid ${C.line};
  color: ${C.dim};
  font-family: ${MONO};
  font-size: 10px;
  letter-spacing: 0.06em;
  padding: 6px 10px;
  border-radius: 20px;
  transition: all 140ms ease;
}
.lg-chip:hover { color: ${C.ink}; border-color: ${C.dim}; }
.lg-chip.on { background: ${C.accent}; border-color: ${C.accent}; color: #0B0E14; font-weight: 500; }

.lg-bar {
  flex: 1 1 0; min-width: 0;
  background: none; border: none; padding: 0;
  height: 100%;
  display: flex; align-items: flex-end;
  position: relative;
  transition: opacity 160ms ease;
}
.lg-bar > span:first-child {
  display: block; width: 100%;
  border-radius: 1px;
  transition: height 200ms ease, filter 140ms ease;
}
.lg-bar:hover > span:first-child { filter: brightness(1.35); }
.lg-today { position: absolute; left: 0; bottom: -3px; width: 100%; height: 2px; background: ${C.ink}; }

.lg-rowbtn {
  background: ${C.panel};
  border: none;
  border-radius: 6px;
  text-align: left;
  padding: 12px 13px 11px;
  color: inherit;
  width: 100%;
  display: block;
  transition: background 140ms ease;
}
.lg-rowbtn:hover { background: ${C.panel2}; }

.lg-input {
  background: ${C.bg};
  border: 1px solid ${C.line};
  border-radius: 6px;
  color: ${C.ink};
  font-family: ${MONO};
  font-size: 14px;
  padding: 11px 12px;
  width: 100%;
  outline: none;
  transition: border-color 140ms ease;
}
.lg-input.tiny { font-size: 12px; padding: 7px 9px; width: auto; flex: 1; min-width: 92px; }
.lg-input::placeholder { color: ${C.dimmer}; }
.lg-input:focus { border-color: ${C.accent}; }
input[type="date"].lg-input { color-scheme: dark; }

.lg-toggle {
  display: flex; align-items: flex-start; gap: 11px;
  background: none; border: none;
  padding: 3px 0 15px;
  color: ${C.ink};
  font-size: 13px;
  text-align: left;
}

.lg-pulse {
  width: 7px; height: 7px; border-radius: 7px;
  background: ${C.overdue};
  flex-shrink: 0;
  animation: lgPulse 2s ease-in-out infinite;
}

:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; border-radius: 4px; }

@keyframes lgUp { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes lgPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
@media (max-width: 420px) {
  .lg-btn { padding: 8px 12px; font-size: 12px; }
}
`;
