import { Composition } from "remotion";
import { HelloLykn } from "./HelloLykn";
import { LyknLogoReveal } from "./LyknLogoReveal";
import { LyknIconSpin, lyknIconSpinDefaults } from "./LyknIconSpin";
import { LyknIconPulse, lyknIconPulseDefaults } from "./LyknIconPulse";

// Every composition you want to render or preview is registered here.
// Add more <Composition> entries as we build new things.
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="LyknLogoReveal"
        component={LyknLogoReveal}
        durationInFrames={130}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          background: "linear-gradient(to bottom, #1a4ee2 0%, #ffffff 100%)",
        }}
      />
      <Composition
        id="LyknIconSpin"
        component={LyknIconSpin}
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={lyknIconSpinDefaults}
      />
      <Composition
        id="LyknIconPulse"
        component={LyknIconPulse}
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={lyknIconPulseDefaults}
      />
      <Composition
        id="HelloLykn"
        component={HelloLykn}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          headline: "Stop using AI that forgets.",
          accentWord: "forgets",
          subtext: "LYKN is the memory layer your AI never had.",
        }}
      />
    </>
  );
};
