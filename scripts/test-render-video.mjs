// Sanity test for lykn_render_video's core pipeline: writes a sample
// model-style Remotion composition, bundles + renders it to mp4 via
// renderOnce (the exact path the tool uses), and checks the output is a
// real mp4. Run: node scripts/test-render-video.mjs
import { renderOnce } from '../lib/exterior/capabilities/renderVideo.js';

const SAMPLE = `
import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from 'remotion';

const Badge = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12 } });
  const drawn = interpolate(frame, [0, 25], [1, 0], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div style={{ transform: \`scale(\${pop})\`, textAlign: 'center' }}>
      <svg width="160" height="160" viewBox="0 0 100 100">
        <circle
          cx="50" cy="50" r="40"
          fill="none" stroke="#5eead4" strokeWidth="6"
          pathLength={1} strokeDasharray={1} strokeDashoffset={drawn}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
};

const Title = () => {
  const frame = useCurrentFrame();
  const rise = interpolate(frame, [0, 20], [24, 0], { extrapolateRight: 'clamp' });
  const fade = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        color: '#fff',
        fontFamily: 'Helvetica, Arial, sans-serif',
        fontSize: 42,
        fontWeight: 700,
        opacity: fade,
        transform: \`translateY(\${rise}px)\`,
      }}
    >
      Render pipeline OK
    </div>
  );
};

export default function Demo() {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: '#0b1220',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
      }}
    >
      <Badge />
      <Sequence from={10}>
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 60 }}>
          <Title />
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
}
`;

const started = Date.now();
console.log('Bundling + rendering 45 frames at 640x360@30fps…');
let lastPct = -1;
const { buffer } = await renderOnce({
  code: SAMPLE,
  durationInFrames: 45,
  fps: 30,
  width: 640,
  height: 360,
  onProgress: (p) => {
    const pct = Math.round(p * 100);
    if (pct !== lastPct && pct % 20 === 0) {
      lastPct = pct;
      console.log(`  render ${pct}%`);
    }
  },
});

const isMp4 = buffer.length > 4096 && buffer.slice(4, 8).toString('ascii') === 'ftyp';
console.log(`Output: ${buffer.length} bytes, ftyp box: ${isMp4}, took ${Math.round((Date.now() - started) / 1000)}s`);
if (!isMp4) {
  console.error('FAIL — output is not a valid mp4');
  process.exit(1);
}
console.log('PASS — mp4 rendered successfully');
