import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return (
        <div className="m-4 bg-red-50 border border-red-200 rounded-lg p-6 max-w-3xl">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-red-900">Algo se rompió en esta página</h2>
              <p className="text-sm text-red-800 mt-1">
                El navbar sigue activo — podés moverte a otra sección. Si esto se repite, mostrale este mensaje a quien
                administra el sistema.
              </p>
              <pre className="mt-3 text-xs bg-white border border-red-200 rounded p-3 overflow-auto max-h-48 text-slate-700 font-mono">
                {this.state.error.message}
                {this.state.error.stack && `\n\n${this.state.error.stack.split('\n').slice(0, 6).join('\n')}`}
              </pre>
              <button
                onClick={this.reset}
                className="mt-3 inline-flex items-center gap-1.5 px-3 h-8 text-sm font-medium rounded-md bg-red-600 text-white hover:bg-red-700"
              >
                <RotateCcw className="w-4 h-4" />
                Reintentar
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
