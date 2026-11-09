// The bank instruction file for payouts: pure functions (no I/O), unit tested. Money stays integer kobo until it is
// written out as naira text for the bank.

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // Lagos is UTC+1 all year
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_EXPORT_DAYS = 366;

/** "2026-11-09" is a real calendar day. */
export function isCalendarDay(text: string): boolean {
  if (!DAY.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/**
 * The instants that bound the days `from` to `to` (both included) on the Lagos clock: the start of `from` up to, but not
 * including, the start of the day after `to`. Returns null when the days are not real, are the wrong way round, or span too long.
 */
export function lagosRange(from: string, to: string): { start: Date; end: Date } | null {
  if (!isCalendarDay(from) || !isCalendarDay(to)) return null;
  const start = new Date(`${from}T00:00:00Z`).getTime() - LAGOS_OFFSET_MS;
  const end = new Date(`${to}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000 - LAGOS_OFFSET_MS;
  const days = (end - start) / (24 * 60 * 60 * 1000);
  if (days < 1 || days > MAX_EXPORT_DAYS) return null;
  return { start: new Date(start), end: new Date(end) };
}

/** The calendar day of an instant on the Lagos clock, as YYYY-MM-DD. */
export const lagosDay = (d: Date) => new Date(d.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);

/** Integer kobo as plain naira text for a bank file: 150000 -> "1500.00". No symbol, no thousands separators. */
export function nairaText(kobo: number): string {
  if (!Number.isInteger(kobo) || kobo < 0) throw new Error("kobo must be a whole, non-negative number");
  return `${Math.floor(kobo / 100)}.${String(kobo % 100).padStart(2, "0")}`;
}

/**
 * One CSV cell. Quotes anything with a comma, quote or line break. A value that starts with = + - @ (or a tab or return)
 * would be run as a formula by a spreadsheet, and vendors type their own account name, so it gets a leading apostrophe.
 */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface PayoutExportRow {
  number: string;
  vendor: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  amountKobo: number;
  requestedAt: Date;
  status: string;
}

export const PAYOUT_EXPORT_HEADER = ["Payout number", "Vendor", "Bank name", "Account number", "Account name", "Amount (NGN)", "Narration", "Requested on", "Status"];

/** The file as text, with a byte order mark so Excel reads it as UTF-8, and Windows line endings. */
export function payoutCsv(rows: PayoutExportRow[]): string {
  const lines = [PAYOUT_EXPORT_HEADER.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([r.number, r.vendor, r.bankName, r.accountNumber, r.accountName, nairaText(r.amountKobo), `VendraMart ${r.number}`, lagosDay(r.requestedAt), r.status].map(csvCell).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
