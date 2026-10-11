import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import i18n from '../../i18n';
import { isChunkLoadError, logRuntimeFailure } from '../../lib/runtime-errors';
import { errorMessage } from '../../lib/error-message';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  resetKey?: string;
  onRetry?: () => void;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) { logRuntimeFailure('render', error); }

  componentDidUpdate(previous: Props) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center py-16 px-4" role="alert">
          <div className="p-3 bg-telivity-orange/10 rounded-full mb-4">
            <AlertTriangle size={24} className="text-telivity-orange" />
          </div>
          <h2 className="text-lg font-semibold text-telivity-navy mb-2">{i18n.t('systemErrors.unexpected')}</h2>
          <p className="text-sm text-telivity-mid-grey mb-4 text-center max-w-md">
            {i18n.t(isChunkLoadError(this.state.error) ? 'runtimeErrors.chunk' : 'runtimeErrors.render')}
          </p>
          <button
            onClick={() => { this.props.onRetry?.(); this.setState({ hasError: false, error: undefined }); }}
            className="flex items-center gap-2 bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-teal transition-colors"
          >
            <RefreshCw size={14} />
            {i18n.t('systemErrors.retry')}
          </button>
          {isChunkLoadError(this.state.error) && <button type="button" onClick={() => window.location.reload()}
            className="mt-3 text-sm text-telivity-slate underline">{i18n.t('runtimeErrors.update')}</button>}
        </div>
      );
    }

    return this.props.children;
  }
}

export function QueryError({ onRetry, error }: { onRetry?: () => void; error?: unknown }) {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
  const canRetry = status !== 401 && status !== 403 && status !== 404;
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4" role="alert">
      <div className="p-3 bg-telivity-orange/10 rounded-full mb-4">
        <AlertTriangle size={24} className="text-telivity-orange" />
      </div>
      <h3 className="text-base font-semibold text-telivity-navy mb-1">{i18n.t(status === 403 ? 'runtimeErrors.access' : 'systemErrors.load')}</h3>
      <p className="text-sm text-telivity-mid-grey mb-4">{error ? errorMessage(error) : i18n.t('systemErrors.request')}</p>
      {onRetry && canRetry && (
        <button
          onClick={onRetry}
          className="flex items-center gap-2 bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-teal transition-colors"
        >
          <RefreshCw size={14} />
          {i18n.t('systemErrors.retry')}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon: Icon, message }: { icon?: React.ComponentType<any>; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {Icon && (
        <div className="p-3 bg-telivity-light-grey rounded-full mb-3">
          <Icon size={24} className="text-telivity-mid-grey" />
        </div>
      )}
      <p className="text-sm text-telivity-mid-grey">{message}</p>
    </div>
  );
}
