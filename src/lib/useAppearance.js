import { useEffect, useState } from 'react';

import { readAppearance, subscribeAppearance } from './appearance';

/**
 * The live appearance blob, for the handful of places that need a value in JS
 * rather than a CSS token — a measurement, say, or a preview that has to
 * render the choice rather than inherit it. Everything that can read the
 * tokens should keep reading the tokens instead.
 */
export function useAppearance() {
  const [appearance, setAppearance] = useState(readAppearance);
  useEffect(() => subscribeAppearance(setAppearance), []);
  return appearance;
}

export default useAppearance;
