import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format } from 'date-fns';
import {
  Calculator,
  ChevronDown,
  ChevronUp,
  Gauge,
  LineChart as LineChartIcon,
  Percent,
  Sparkles,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { getDateLocale } from '../lib/date-locale';
import { formatMoney } from '../lib/money';
import { useProperty } from '../context/PropertyContext';
import KpiCard from '../components/ui/KpiCard';
import RevenueWorkspaceNav from '../components/revenue/RevenueWorkspaceNav';
import { Link } from 'react-router-dom';
import { propertyHref } from '../lib/navigation';
import { useAuth } from '../context/AuthContext';
import {
  DEFAULT_PRICING_SETTINGS,
  FORECAST_DAYS,
  MOCK_FORECAST_MIN_BOOKINGS,
  ROOM_CATEGORIES,
  ROUNDING_STEPS,
  addDaysKey,
  computeNightPrice,
  generateMockForecast,
  goalSeekBaseRate,
  propertyClock,
  summariseForecast,
  type BreakdownLine,
  type ForecastDay,
  type NightPrice,
  type PricingSettings,
  type RoomCategory,
  type RoundingStep,
} from '../lib/dynamic-pricing';

/**
 * Dynamic pricing simulator.
 *
 * A rate ladder is only trustworthy if the person selling it can see WHY a
 * night costs what it costs, so every number on this page traces back to the
 * waterfall: base rate, category, then each demand adjustment, then the floor
 * and the rounding step. The maths lives in lib/dynamic-pricing.ts — this file
 * is inputs, charts and labels only.
 *
 * Nothing here writes to the property. It is a simulator: the revenue manager
 * reads a recommendation off it and applies it through rate plans.
 */

interface PaceDay {
  date: string;
  roomsOnBooks: number;
  newBookings: number;
}

function percentLabel(value: number): string {
  const rounded = Math.round(value * 1000) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/** Editable numeric field that tolerates an empty box mid-typing. */
function NumberField({
  label,
  value,
  onChange,
  min = 0,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-telivity-mid-grey mb-1">{label}</span>
      <div className="relative">
        <input
          type="number"
          min={min}
          step={step}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal"
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-telivity-mid-grey">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}

function Accordion({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border border-gray-200 rounded-lg">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-telivity-navy"
      >
        {title}
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && <div className="px-3 pb-3 space-y-3">{children}</div>}
    </div>
  );
}

export default function DynamicPricing() {
  const { propertyId } = useProperty();
  return <PricingSimulation key={propertyId} />;
}

function PricingSimulation() {
  const { t, i18n } = useTranslation();
  const { propertyId, currencyCode, properties, isPortfolioMode } = useProperty();
  const { hasPermission } = useAuth();
  const ru = i18n.language.startsWith('ru');
  const dateLocale = getDateLocale(i18n.resolvedLanguage);
  const property = properties.find((p) => p.id === propertyId);

  // The 15:00 decay is a property-local decision, so the clock is the hotel's.
  const clock = useMemo(
    () => propertyClock(new Date(), property?.timezone),
    // Re-evaluated when the property changes; the hour is read once per mount,
    // which is what a simulator needs (a rate that mutates while you read it is
    // worse than one that is a few minutes stale).
    [property?.timezone],
  );

  const [settings, setSettings] = useState<PricingSettings>(DEFAULT_PRICING_SETTINGS);
  const [category, setCategory] = useState<RoomCategory>('standard');
  const [openSection, setOpenSection] = useState<string | null>('occupancy');
  const [selectedDate, setSelectedDate] = useState<string>(clock.today);
  const [occupancyOverrides, setOccupancyOverrides] = useState<Record<string, number>>({});
  const [targetAdr, setTargetAdr] = useState(125000);
  const [solverNote, setSolverNote] = useState<string | null>(null);

  const windowStart = clock.today;
  const windowEnd = addDaysKey(clock.today, FORECAST_DAYS - 1);

  const occupancyQuery = useQuery({
    queryKey: ['reports', 'occupancy', propertyId, windowStart],
    queryFn: () =>
      api
        .get('/v1/reports/occupancy', { params: { propertyId, date: windowStart } })
        .then((r) => r.data),
    enabled: !!propertyId && !isPortfolioMode && hasPermission('reports.view'),
  });

  const paceQuery = useQuery({
    queryKey: ['reports', 'booking-pace', propertyId, windowStart, windowEnd],
    queryFn: () =>
      api
        .get('/v1/reports/booking-pace', {
          params: { propertyId, startDate: windowStart, endDate: windowEnd },
        })
        .then((r) => r.data),
    enabled: !!propertyId && !isPortfolioMode && hasPermission('reports.view'),
  });

  // Pace is a property-wide velocity signal: how many bookings landed in the
  // last 24h, not how many landed for one specific night.
  const recentPaceQuery = useQuery({
    queryKey: ['reports', 'booking-pace', 'recent', propertyId, windowStart],
    queryFn: () =>
      api
        .get('/v1/reports/booking-pace', {
          params: {
            propertyId,
            startDate: addDaysKey(windowStart, -1),
            endDate: windowStart,
          },
        })
        .then((r) => r.data),
    enabled: !!propertyId && !isPortfolioMode && hasPermission('reports.view'),
  });

  const occupancyReport = occupancyQuery.data;
  const paceReport = paceQuery.data;
  const recentPaceReport = recentPaceQuery.data;

  const totalRooms: number = occupancyReport?.totalRooms ?? property?.totalRooms ?? 0;
  const availableRooms: number = occupancyReport?.availableRooms ?? totalRooms;
  const paceDays: PaceDay[] = paceReport?.daily ?? [];
  const bookingsLast24h: number =
    recentPaceReport?.daily?.reduce((max: number, d: PaceDay) => Math.max(max, d.newBookings), 0) ??
    0;

  /**
   * Real occupancy where the ledger has enough to say something, the documented
   * synthetic curve where it does not. A property with three test bookings would
   * otherwise render a flat 2% forecast and every night would price at the floor
   * — a simulator that teaches nothing.
   */
  const forecastSource: { days: ForecastDay[]; synthetic: boolean } = useMemo(() => {
    const roomsOnBooks = paceDays.reduce((sum, d) => sum + d.roomsOnBooks, 0);
    if (paceDays.length === 0 || roomsOnBooks < MOCK_FORECAST_MIN_BOOKINGS || availableRooms <= 0) {
      return { days: generateMockForecast(windowStart), synthetic: true };
    }
    return {
      days: paceDays.slice(0, FORECAST_DAYS).map((day) => ({
        date: day.date,
        occupancyPercent: Math.min(
          100,
          Math.round((day.roomsOnBooks / availableRooms) * 1000) / 10,
        ),
        bookingsLast24h,
        eventAdjustment: 0,
        isSynthetic: false,
      })),
      synthetic: false,
    };
  }, [paceDays, availableRooms, bookingsLast24h, windowStart]);

  const forecast: ForecastDay[] = useMemo(
    () =>
      forecastSource.days.map((day) =>
        day.date in occupancyOverrides
          ? { ...day, occupancyPercent: occupancyOverrides[day.date] }
          : day,
      ),
    [forecastSource.days, occupancyOverrides],
  );

  const pricedNights: NightPrice[] = useMemo(
    () => forecast.map((day) => computeNightPrice(day, category, settings, clock)),
    [forecast, category, settings, clock],
  );

  const summary = useMemo(
    () => summariseForecast(pricedNights, totalRooms || availableRooms),
    [pricedNights, totalRooms, availableRooms],
  );

  // Keep the waterfall pointed at a night that exists in the window.
  useEffect(() => {
    if (forecast.length && !forecast.some((d) => d.date === selectedDate)) {
      setSelectedDate(forecast[0].date);
    }
  }, [forecast, selectedDate]);

  const selectedNight =
    pricedNights.find((n) => n.date === selectedDate) ?? pricedNights[0] ?? null;

  const chartData = useMemo(
    () =>
      pricedNights.map((night) => ({
        date: night.date,
        label: format(new Date(`${night.date}T00:00:00`), 'd MMM', { locale: dateLocale }),
        dynamicRate: night.finalPrice,
        baseRate: settings.baseRate * (settings.categoryMultipliers[category] ?? 1),
        occupancy: night.occupancyPercent,
      })),
    [pricedNights, settings.baseRate, settings.categoryMultipliers, category, dateLocale],
  );

  function patchSettings(patch: Partial<PricingSettings>) {
    setSettings((prev) => ({ ...prev, ...patch }));
    setSolverNote(null);
  }

  function runGoalSeek() {
    const { recommendedBaseRate } = goalSeekBaseRate({
      targetAdr,
      currentBaseRate: settings.baseRate,
      roundingStep: settings.roundingStep,
      totalRooms: totalRooms || availableRooms,
      priced: pricedNights,
    });
    setSettings((prev) => ({ ...prev, baseRate: recommendedBaseRate }));
    setSolverNote(t('dynamicPricing.solver.updated'));
  }

  function breakdownLabel(line: BreakdownLine): string {
    const categoryName = t(`dynamicPricing.categories.${category}`);
    switch (line.kind) {
      case 'base':
        return t('dynamicPricing.waterfall.base', { category: t('dynamicPricing.categories.standard') });
      case 'category':
        return t('dynamicPricing.waterfall.category', {
          category: categoryName,
          percent: percentLabel(line.percent ?? 0),
        });
      case 'event':
        return t('dynamicPricing.waterfall.event', { percent: percentLabel(line.percent ?? 0) });
      case 'occupancy':
        return t('dynamicPricing.waterfall.occupancy', {
          occupancy: line.detail ?? 0,
          percent: percentLabel(line.percent ?? 0),
        });
      case 'pace':
        return t('dynamicPricing.waterfall.pace', {
          count: line.detail ?? 0,
          percent: percentLabel(line.percent ?? 0),
        });
      case 'leadTime':
        return t('dynamicPricing.waterfall.leadTime', {
          days: line.detail ?? 0,
          percent: percentLabel(line.percent ?? 0),
        });
      case 'clamp':
        return t('dynamicPricing.waterfall.clamp', { percent: percentLabel(line.percent ?? 0) });
      case 'intraday':
        return t('dynamicPricing.waterfall.intraday', {
          hour: line.detail ?? settings.intradayDecay.fromHour,
          percent: percentLabel(line.percent ?? 0),
        });
      case 'floor':
        return t('dynamicPricing.waterfall.floor', {
          floor: formatMoney(line.detail ?? settings.floorPrice, currencyCode),
        });
      case 'rounding':
        return t('dynamicPricing.waterfall.rounding', { step: line.detail ?? settings.roundingStep });
      case 'total':
      default:
        return t('dynamicPricing.waterfall.total');
    }
  }

  if (!propertyId || isPortfolioMode) {
    return (
      <div className="flex items-center justify-center h-64 text-telivity-mid-grey">
        {t('common.selectProperty')}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Gauge size={24} className="text-telivity-teal" />
        <div>
          <h1 className="text-2xl font-semibold text-telivity-navy">{t('dynamicPricing.title')}</h1>
          <p className="text-xs text-telivity-mid-grey">{t('dynamicPricing.subtitle')}</p>
        </div>
      </div>

      <RevenueWorkspaceNav />

      <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
        <p className="font-semibold">Simulation · {ru ? 'Не изменяет реальные тарифы' : 'Does not change live rates'}</p>
        <p className="mt-1">{ru ? 'Все цены, ADR, RevPAR и суммы ниже — результаты сценария, не Actual и не подтверждённый прогноз. Synthetic demand никогда не применяется к Live. Реальный прогноз: INSUFFICIENT_HISTORY.' : 'All prices, ADR, RevPAR and amounts below are scenario results, not Actual or a confirmed forecast. Synthetic demand is never applied to Live. Real forecast: INSUFFICIENT_HISTORY.'}</p>
        <Link className="mt-2 inline-block font-semibold text-telivity-teal" to={propertyHref('/revenue', propertyId)}>{ru ? 'Live Rate Management →' : 'Live Rate Management →'}</Link>
        {(occupancyQuery.isError || paceQuery.isError || recentPaceQuery.isError) && <p role="alert" className="mt-2">{ru ? 'Коммерческие данные недоступны; демонстрация не является прогнозом.' : 'Commercial data unavailable; demo is not a forecast.'} <button type="button" className="underline" onClick={() => { void occupancyQuery.refetch(); void paceQuery.refetch(); void recentPaceQuery.refetch(); }}>{ru ? 'Повторить' : 'Retry'}</button></p>}
        {(occupancyQuery.isPending || paceQuery.isPending) && hasPermission('reports.view') && <p role="status">{ru ? 'Загрузка данных PMS; пока показан демонстрационный сценарий.' : 'Loading PMS data; currently showing a demo scenario.'}</p>}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* ---- Left: controls ---- */}
        <section className="xl:col-span-3 bg-white rounded-xl shadow-sm p-4 space-y-4 self-start">
          <h2 className="text-sm font-semibold text-telivity-navy flex items-center gap-2">
            <Calculator size={16} className="text-telivity-teal" />
            {t('dynamicPricing.controls.title')}
          </h2>

          <NumberField
            label={t('dynamicPricing.controls.baseRate')}
            value={settings.baseRate}
            step={settings.roundingStep}
            onChange={(baseRate) => patchSettings({ baseRate })}
          />
          <NumberField
            label={t('dynamicPricing.controls.floorPrice')}
            value={settings.floorPrice}
            step={settings.roundingStep}
            onChange={(floorPrice) => patchSettings({ floorPrice })}
          />
          <label className="block">
            <span className="block text-xs font-medium text-telivity-mid-grey mb-1">
              {t('dynamicPricing.controls.roundingStep')}
            </span>
            <select
              value={settings.roundingStep}
              onChange={(e) =>
                patchSettings({ roundingStep: Number(e.target.value) as RoundingStep })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal"
            >
              {ROUNDING_STEPS.map((step) => (
                <option key={step} value={step}>
                  {step.toLocaleString(i18n.resolvedLanguage)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-telivity-mid-grey mb-1">
              {t('dynamicPricing.controls.category')}
            </span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as RoomCategory)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal"
            >
              {ROOM_CATEGORIES.map((key) => (
                <option key={key} value={key}>
                  {t(`dynamicPricing.categories.${key}`)}
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-telivity-navy">
              {t('dynamicPricing.controls.multipliers')}
            </p>
            {ROOM_CATEGORIES.map((key) => (
              <NumberField
                key={key}
                label={t(`dynamicPricing.categories.${key}`)}
                value={settings.categoryMultipliers[key]}
                step={0.05}
                onChange={(value) =>
                  patchSettings({
                    categoryMultipliers: { ...settings.categoryMultipliers, [key]: value },
                  })
                }
              />
            ))}
          </div>

          <Accordion
            title={t('dynamicPricing.controls.occupancyTiers')}
            open={openSection === 'occupancy'}
            onToggle={() => setOpenSection(openSection === 'occupancy' ? null : 'occupancy')}
          >
            <NumberField
              label={t('dynamicPricing.controls.lowBelow')}
              value={settings.occupancy.lowBelow}
              suffix="%"
              onChange={(lowBelow) =>
                patchSettings({ occupancy: { ...settings.occupancy, lowBelow } })
              }
            />
            <NumberField
              label={t('dynamicPricing.controls.lowAdjustment')}
              value={Math.round(settings.occupancy.lowAdjustment * 100)}
              suffix="%"
              min={-100}
              onChange={(value) =>
                patchSettings({
                  occupancy: { ...settings.occupancy, lowAdjustment: value / 100 },
                })
              }
            />
            <NumberField
              label={t('dynamicPricing.controls.neutralThrough')}
              value={settings.occupancy.neutralThrough}
              suffix="%"
              onChange={(neutralThrough) =>
                patchSettings({ occupancy: { ...settings.occupancy, neutralThrough } })
              }
            />
            <NumberField
              label={t('dynamicPricing.controls.highThrough')}
              value={settings.occupancy.highThrough}
              suffix="%"
              onChange={(highThrough) =>
                patchSettings({ occupancy: { ...settings.occupancy, highThrough } })
              }
            />
            <NumberField
              label={t('dynamicPricing.controls.highAdjustment')}
              value={Math.round(settings.occupancy.highAdjustment * 100)}
              suffix="%"
              min={-100}
              onChange={(value) =>
                patchSettings({
                  occupancy: { ...settings.occupancy, highAdjustment: value / 100 },
                })
              }
            />
            <NumberField
              label={t('dynamicPricing.controls.peakAdjustment')}
              value={Math.round(settings.occupancy.peakAdjustment * 100)}
              suffix="%"
              min={-100}
              onChange={(value) =>
                patchSettings({
                  occupancy: { ...settings.occupancy, peakAdjustment: value / 100 },
                })
              }
            />
          </Accordion>

          <Accordion
            title={t('dynamicPricing.controls.paceTriggers')}
            open={openSection === 'pace'}
            onToggle={() => setOpenSection(openSection === 'pace' ? null : 'pace')}
          >
            <NumberField
              label={t('dynamicPricing.controls.paceTier1Above')}
              value={settings.pace.tier1Above}
              onChange={(tier1Above) => patchSettings({ pace: { ...settings.pace, tier1Above } })}
            />
            <NumberField
              label={t('dynamicPricing.controls.paceTier1Adjustment')}
              value={Math.round(settings.pace.tier1Adjustment * 100)}
              suffix="%"
              min={-100}
              onChange={(value) =>
                patchSettings({ pace: { ...settings.pace, tier1Adjustment: value / 100 } })
              }
            />
            <NumberField
              label={t('dynamicPricing.controls.paceTier2Above')}
              value={settings.pace.tier2Above}
              onChange={(tier2Above) => patchSettings({ pace: { ...settings.pace, tier2Above } })}
            />
            <NumberField
              label={t('dynamicPricing.controls.paceTier2Adjustment')}
              value={Math.round(settings.pace.tier2Adjustment * 100)}
              suffix="%"
              min={-100}
              onChange={(value) =>
                patchSettings({ pace: { ...settings.pace, tier2Adjustment: value / 100 } })
              }
            />
            <p className="text-[11px] text-telivity-mid-grey">
              {t('dynamicPricing.controls.paceSignal', { count: bookingsLast24h })}
            </p>
          </Accordion>

          <Accordion
            title={t('dynamicPricing.controls.leadTime')}
            open={openSection === 'lead'}
            onToggle={() => setOpenSection(openSection === 'lead' ? null : 'lead')}
          >
            <NumberField
              label={t('dynamicPricing.controls.leadNearDays')}
              value={settings.leadTime.nearThroughDays}
              onChange={(nearThroughDays) =>
                patchSettings({ leadTime: { ...settings.leadTime, nearThroughDays } })
              }
            />
            <NumberField
              label={t('dynamicPricing.controls.leadNearAdjustment')}
              value={Math.round(settings.leadTime.nearAdjustment * 100)}
              suffix="%"
              min={-100}
              onChange={(value) =>
                patchSettings({ leadTime: { ...settings.leadTime, nearAdjustment: value / 100 } })
              }
            />
            <NumberField
              label={t('dynamicPricing.controls.leadMidDays')}
              value={settings.leadTime.midThroughDays}
              onChange={(midThroughDays) =>
                patchSettings({ leadTime: { ...settings.leadTime, midThroughDays } })
              }
            />
            <NumberField
              label={t('dynamicPricing.controls.leadMidAdjustment')}
              value={Math.round(settings.leadTime.midAdjustment * 100)}
              suffix="%"
              min={-100}
              onChange={(value) =>
                patchSettings({ leadTime: { ...settings.leadTime, midAdjustment: value / 100 } })
              }
            />
          </Accordion>

          <div className="border border-gray-200 rounded-lg p-3 space-y-3">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.intradayDecay.enabled}
                onChange={(e) =>
                  patchSettings({
                    intradayDecay: { ...settings.intradayDecay, enabled: e.target.checked },
                  })
                }
                className="mt-0.5 accent-telivity-teal"
              />
              <span className="text-xs font-medium text-telivity-navy">
                {t('dynamicPricing.controls.intradayToggle', {
                  hour: settings.intradayDecay.fromHour,
                })}
              </span>
            </label>
            <div>
              <div className="flex items-center justify-between text-xs text-telivity-mid-grey mb-1">
                <span>{t('dynamicPricing.controls.intradayAmount')}</span>
                <span className="font-semibold text-telivity-navy">
                  {Math.round(settings.intradayDecay.amount * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={80}
                step={5}
                value={Math.round(settings.intradayDecay.amount * 100)}
                disabled={!settings.intradayDecay.enabled}
                onChange={(e) =>
                  patchSettings({
                    intradayDecay: {
                      ...settings.intradayDecay,
                      amount: Number(e.target.value) / 100,
                    },
                  })
                }
                className="w-full accent-telivity-teal"
                aria-label={t('dynamicPricing.controls.intradayAmount')}
              />
            </div>
            <NumberField
              label={t('dynamicPricing.controls.intradayFromHour')}
              value={settings.intradayDecay.fromHour}
              min={0}
              onChange={(fromHour) =>
                patchSettings({ intradayDecay: { ...settings.intradayDecay, fromHour } })
              }
            />
            <p className="text-[11px] text-telivity-mid-grey">
              {t('dynamicPricing.controls.propertyClock', {
                time: `${String(clock.hour).padStart(2, '0')}:00`,
                zone: property?.timezone ?? t('dynamicPricing.controls.localZone'),
              })}
            </p>
          </div>
        </section>

        {/* ---- Centre: waterfall + solver ---- */}
        <div className="xl:col-span-4 space-y-4">
          <section className="bg-white rounded-xl shadow-sm p-4">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h2 className="text-sm font-semibold text-telivity-navy">
                  {t('dynamicPricing.waterfall.title')}
                </h2>
                <p className="text-xs text-telivity-mid-grey">
                  {selectedNight
                    ? format(new Date(`${selectedNight.date}T00:00:00`), 'EEEE, d MMMM', {
                        locale: dateLocale,
                      })
                    : '—'}
                </p>
              </div>
              <p className="text-2xl font-semibold text-telivity-teal whitespace-nowrap">
                {formatMoney(selectedNight?.finalPrice, currencyCode)}
              </p>
            </div>

            {selectedNight ? (
              <ul className="divide-y divide-gray-100">
                {selectedNight.lines.map((line, index) => (
                  <li
                    key={`${line.kind}-${index}`}
                    className={`flex items-baseline justify-between gap-3 py-2 text-sm ${
                      line.kind === 'total' ? 'font-semibold text-telivity-navy' : ''
                    }`}
                  >
                    <span className="text-telivity-slate">{breakdownLabel(line)}</span>
                    <span
                      className={
                        'whitespace-nowrap tabular-nums shrink-0 ' + (line.kind === 'total'
                          ? 'text-telivity-navy'
                          : line.amount < 0
                            ? 'text-telivity-orange'
                            : line.amount > 0
                              ? 'text-telivity-dark-teal'
                              : 'text-telivity-mid-grey')
                      }
                    >
                      {line.kind === 'total' || line.kind === 'base'
                        ? formatMoney(line.amount, currencyCode)
                        : line.amount === 0
                          ? '—'
                          : `${line.amount > 0 ? '+' : '−'}${formatMoney(Math.abs(line.amount), currencyCode)}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-telivity-mid-grey">{t('dynamicPricing.noForecast')}</p>
            )}
          </section>

          <section className="bg-white rounded-xl shadow-sm p-4 space-y-3">
            <h2 className="text-sm font-semibold text-telivity-navy flex items-center gap-2">
              <Sparkles size={16} className="text-telivity-teal" />
              {t('dynamicPricing.solver.title')}
            </h2>
            <p className="text-xs text-telivity-mid-grey">{t('dynamicPricing.solver.hint')}</p>
            <NumberField
              label={t('dynamicPricing.solver.targetAdr')}
              value={targetAdr}
              step={settings.roundingStep}
              onChange={setTargetAdr}
            />
            <div className="flex items-center justify-between text-xs text-telivity-mid-grey">
              <span>{t('dynamicPricing.solver.currentAdr')}</span>
              <span className="font-semibold text-telivity-navy">
                {formatMoney(Math.round(summary.adr), currencyCode)}
              </span>
            </div>
            <button
              type="button"
              onClick={runGoalSeek}
              disabled={pricedNights.length === 0}
              className="w-full bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-teal disabled:opacity-50"
            >
              {t('dynamicPricing.solver.action')}
            </button>
            {solverNote && (
              <p className="rounded-lg bg-telivity-dark-teal/10 text-telivity-dark-teal text-xs font-semibold px-3 py-2">
                {solverNote}
              </p>
            )}
          </section>
        </div>

        {/* ---- Right: forecast + simulation ---- */}
        <div className="xl:col-span-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <KpiCard
              nowrap
              title={t('dynamicPricing.kpi.adr')}
              value={formatMoney(Math.round(summary.adr), currencyCode)}
              icon={TrendingUp}
            />
            <KpiCard
              nowrap
              title={t('dynamicPricing.kpi.occupancy')}
              value={`${summary.averageOccupancyPercent.toFixed(1)}%`}
              icon={Percent}
            />
            <KpiCard
              nowrap
              title={t('dynamicPricing.kpi.revpar')}
              value={formatMoney(Math.round(summary.revpar), currencyCode)}
              subtitle={t('dynamicPricing.kpi.revparSubtitle', {
                revenue: formatMoney(Math.round(summary.revenue), currencyCode),
              })}
              icon={Wallet}
            />
          </div>

          <section className="bg-white rounded-xl shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-telivity-navy flex items-center gap-2">
                <LineChartIcon size={16} className="text-telivity-teal" />
                {t('dynamicPricing.forecast.title', { days: FORECAST_DAYS })}
              </h2>
              {forecastSource.synthetic ? (
                <span className="rounded-full bg-telivity-orange/15 text-telivity-orange text-[11px] font-semibold px-2.5 py-1">
                  {t('dynamicPricing.forecast.synthetic')}
                </span>
              ) : <span className="text-[11px] text-telivity-mid-grey">{ru ? 'Сценарий на основе On books (не Forecast)' : 'On-books scenario (not Forecast)'}</span>}
            </div>
            <div className="h-56 sm:h-64" role="img" aria-label={ru ? 'Сценарий цены и загрузки на 30 дней; выбор даты в таблице ниже' : '30-day price and occupancy scenario; choose a date in the table below'}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 0, left: 0, bottom: 4 }} onClick={(state) => {
                  const date = state?.activePayload?.[0]?.payload?.date;
                  if (typeof date === 'string') setSelectedDate(date);
                }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" />
                  <XAxis dataKey="date" tickFormatter={date => format(new Date(`${date}T00:00:00`), 'd MMM', { locale: dateLocale })} tick={{ fontSize: 10 }} minTickGap={24} />
                  <YAxis yAxisId="rate" tick={{ fontSize: 10 }} width={56} tickFormatter={value => new Intl.NumberFormat(i18n.language, { notation: 'compact', maximumFractionDigits: 1 }).format(value)} />
                  <YAxis
                    yAxisId="occupancy"
                    orientation="right"
                    domain={[0, 100]}
                    unit="%"
                    tick={{ fontSize: 10 }}
                    width={45}
                  />
                  <Tooltip content={({ active, payload }) => {
                    const date = payload?.[0]?.payload?.date as string | undefined;
                    const night = pricedNights.find(n => n.date === date);
                    if (!active || !night) return null;
                    return <div className="max-w-64 rounded-lg border bg-white p-3 text-xs shadow-lg"><p className="font-semibold">{night.date} · Simulation</p><p className="mt-1 whitespace-nowrap tabular-nums">{t('dynamicPricing.forecast.dynamicSeries')}: {formatMoney(night.finalPrice, currencyCode, i18n.language)}</p><p className="whitespace-nowrap tabular-nums">{t('dynamicPricing.forecast.baseSeries')}: {formatMoney(settings.baseRate * (settings.categoryMultipliers[category] ?? 1), currencyCode, i18n.language)}</p><p>{t('dynamicPricing.forecast.occupancySeries')}: {night.occupancyPercent}%</p><p className="mt-2">{night.lines.filter(line => line.amount !== 0 && line.kind !== 'base' && line.kind !== 'total').map(breakdownLabel).join(' · ')}</p><p className="mt-2 text-telivity-mid-grey">{ru ? 'Нажмите для расшифровки' : 'Click for waterfall'}</p></div>;
                  }} />
                  <ReferenceLine x={selectedDate} yAxisId="rate" stroke="#0f9b8e" strokeDasharray="3 3" />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar
                    yAxisId="occupancy"
                    dataKey="occupancy"
                    name={t('dynamicPricing.forecast.occupancySeries')}
                    fill="#7fd1c8"
                    barSize={8}
                    radius={[2, 2, 0, 0]}
                  />
                  <Line
                    yAxisId="rate"
                    type="monotone"
                    dataKey="dynamicRate"
                    name={t('dynamicPricing.forecast.dynamicSeries')}
                    stroke="#0f9b8e"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    yAxisId="rate"
                    type="monotone"
                    dataKey="baseRate"
                    name={t('dynamicPricing.forecast.baseSeries')}
                    stroke="#94a3b8"
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-telivity-navy">
                {t('dynamicPricing.table.title')}
              </h2>
              <p className="text-xs text-telivity-mid-grey">{t('dynamicPricing.table.hint')}</p>
            </div>
            <div className="max-h-80 overflow-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-telivity-teal/5">
                  <tr className="border-b border-gray-100">
                    <th className="px-3 py-2 text-left text-xs font-semibold text-telivity-slate">
                      {t('dynamicPricing.table.date')}
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-telivity-slate">
                      {t('dynamicPricing.table.dayOfWeek')}
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-telivity-slate">
                      {t('dynamicPricing.table.occupancy')}
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-telivity-slate">
                      {t('dynamicPricing.table.price')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pricedNights.map((night) => {
                    const day = new Date(`${night.date}T00:00:00`);
                    const isSelected = night.date === selectedDate;
                    return (
                      <tr
                        key={night.date}
                        onClick={() => setSelectedDate(night.date)}
                        className={`border-b border-gray-50 cursor-pointer ${
                          isSelected ? 'bg-telivity-teal/10' : 'hover:bg-telivity-light-grey/60'
                        }`}
                      >
                        <td className="px-3 py-1.5 text-xs font-medium text-telivity-navy">
                          {format(day, 'd MMM', { locale: dateLocale })}
                          {night.leadTimeDays === 0 && (
                            <span className="ml-2 text-[10px] font-semibold text-telivity-teal">
                              {t('dynamicPricing.table.today')}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-telivity-slate capitalize">
                          {format(day, 'EEEE', { locale: dateLocale })}
                        </td>
                        <td className="px-3 py-1 text-right">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={night.occupancyPercent}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) =>
                              setOccupancyOverrides((prev) => ({
                                ...prev,
                                [night.date]: Math.max(0, Math.min(100, Number(e.target.value))),
                              }))
                            }
                            aria-label={t('dynamicPricing.table.occupancyFor', {
                              date: format(day, 'd MMMM', { locale: dateLocale }),
                            })}
                            className="w-16 border border-gray-200 rounded px-2 py-1 text-xs text-right focus:outline-none focus:border-telivity-teal"
                          />
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs font-semibold text-telivity-navy">
                          {formatMoney(night.finalPrice, currencyCode)}
                          {night.intradayApplied && (
                            <span className="ml-1 text-[10px] font-semibold text-telivity-orange">
                              {t('dynamicPricing.table.decayed')}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {pricedNights.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-sm text-telivity-mid-grey">
                        {t('dynamicPricing.noForecast')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {Object.keys(occupancyOverrides).length > 0 && (
              <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between">
                <span className="text-xs text-telivity-mid-grey">
                  {t('dynamicPricing.table.overrides', {
                    count: Object.keys(occupancyOverrides).length,
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => setOccupancyOverrides({})}
                  className="text-xs font-semibold text-telivity-teal hover:underline"
                >
                  {t('dynamicPricing.table.resetOverrides')}
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
