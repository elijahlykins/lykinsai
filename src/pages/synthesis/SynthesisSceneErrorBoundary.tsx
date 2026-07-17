import React from "react";
import { Brain } from "lucide-react";

interface Props {
  children: React.ReactNode;
  /**
   * Optional list of neuron labels to surface in the default fallback so
   * the user still sees what they've built when the 3D scene refuses to
   * render. (E.g. on mobile WebGL contexts that crash on Bloom
   * postprocessing.) Ignored when `fallback` is supplied.
   */
  neurons?: string[];
  /**
   * Custom fallback UI to render when the 3D scene throws. Used by
   * SynthesisLayer on mobile to fall back to the rich neuron card
   * stack instead of the default "open on desktop" card. When omitted
   * the boundary renders its built-in fallback.
   */
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Local error boundary scoped to the synthesis 3D scene. The scene leans on
 * react-three-fiber + EffectComposer + Bloom, all of which can throw
 * uncatchable runtime errors on a sliver of mobile WebGL contexts (iOS
 * Safari low-power mode, certain Android GPUs, etc.). Without this, those
 * crashes bubble up to the route-level RouteErrorBoundary and the user
 * sees a generic "this page ran into an issue" page they can't recover
 * from. Catching at the canvas level lets the rest of the synthesis page
 * (sidebar, walkthrough nudge, neuron list) keep working, and shows the
 * user a friendly fallback that still surfaces their neurons.
 */
class SynthesisSceneErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    if (import.meta.env.DEV) {
      console.error("[SynthesisSceneErrorBoundary]", error);
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback !== undefined) return this.props.fallback;

    const neurons = this.props.neurons ?? [];

    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
        <div className="text-center max-w-sm space-y-3">
          <Brain className="w-12 h-12 text-indigo-300 mx-auto" />
          <p className="text-sm text-gray-200">
            Your synthesis layer is still forming.
          </p>
          <p className="text-xs text-gray-400 leading-relaxed">
            The interactive 3D mind map needs a desktop browser. On mobile we
            show a simple list. Open LYKN on a laptop or desktop to explore
            the full layer.
          </p>
          {neurons.length > 0 && (
            <div className="mt-4 flex flex-wrap justify-center gap-1.5">
              {neurons.map((label, i) => (
                <span
                  key={`${label}-${i}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium text-pink-200 border border-pink-400/40 bg-pink-500/[0.08]"
                >
                  <span
                    aria-hidden
                    className="w-1.5 h-1.5 rounded-full bg-pink-300 shadow-[0_0_8px_rgba(244,114,182,0.9)]"
                  />
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
}

export default SynthesisSceneErrorBoundary;
