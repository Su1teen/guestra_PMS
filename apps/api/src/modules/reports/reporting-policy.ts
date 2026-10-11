import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';

export function reportDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('Expected a valid YYYY-MM-DD business date');
  }
  return value;
}

export function reportDates(start: string, end: string): string[] {
  reportDate(start); reportDate(end);
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (days < 0 || days > 366) throw new BadRequestException('Report range must be ordered and at most 367 days');
  return Array.from({ length: days + 1 }, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10));
}

export function priorYearDate(date: string): string {
  reportDate(date);
  const year = Number(date.slice(0, 4)) - 1;
  const lastDay = new Date(Date.UTC(year, Number(date.slice(5, 7)), 0)).getUTCDate();
  return `${year}${date.slice(4, 8)}${String(Math.min(Number(date.slice(8)), lastDay)).padStart(2, '0')}`;
}

export function ratio(numerator: number, denominator: number, places = 2): number | null {
  return denominator > 0 ? new Decimal(numerator).div(denominator).toDecimalPlaces(places).toNumber() : null;
}
