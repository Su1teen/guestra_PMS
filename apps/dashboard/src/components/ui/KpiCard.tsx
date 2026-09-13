import type { LucideIcon } from 'lucide-react';

interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  trend?: { value: number; label: string };
  /** Optional numeric value used for threshold coloring (when display value is formatted). */
  numericValue?: number;
  threshold?: { warnBelow?: number; goodAbove?: number };
}

function thresholdStatus(
  numericValue: number | undefined,
  threshold?: { warnBelow?: number; goodAbove?: number },
): 'ok' | 'warn' | 'neutral' {
  if (numericValue == null || !threshold) return 'neutral';
  if (threshold.warnBelow != null && numericValue < threshold.warnBelow) return 'warn';
  if (threshold.goodAbove != null && numericValue >= threshold.goodAbove) return 'ok';
  if (threshold.warnBelow == null && threshold.goodAbove == null) return 'neutral';
  return 'ok';
}

export default function KpiCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  numericValue,
  threshold,
}: KpiCardProps) {
  const status = thresholdStatus(numericValue, threshold);
  const valueClass =
    status === 'warn'
      ? 'text-telivity-orange'
      : status === 'ok'
        ? 'text-telivity-dark-teal'
        : 'text-telivity-navy';
  const iconWrap =
    status === 'warn'
      ? 'bg-telivity-orange/10'
      : status === 'ok'
        ? 'bg-telivity-dark-teal/10'
        : 'bg-telivity-teal/10';
  const iconColor =
    status === 'warn'
      ? 'text-telivity-orange'
      : status === 'ok'
        ? 'text-telivity-dark-teal'
        : 'text-telivity-teal';

  return (
    <div className="bg-white rounded-xl shadow-sm p-5 overflow-hidden">
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-telivity-mid-grey font-medium">{title}</p>
          <p className={`text-2xl font-semibold leading-tight mt-1 break-words ${valueClass}`}>{value}</p>
          {subtitle && <p className="text-xs text-telivity-mid-grey mt-1">{subtitle}</p>}
          {trend && (
            <p className={`text-xs mt-1 font-medium ${trend.value >= 0 ? 'text-telivity-dark-teal' : 'text-telivity-orange'}`}>
              {trend.value >= 0 ? '+' : ''}{trend.value}% {trend.label}
            </p>
          )}
        </div>
        <div className={`p-2.5 rounded-lg shrink-0 ${iconWrap}`}>
          <Icon size={20} className={iconColor} />
        </div>
      </div>
    </div>
  );
}
