import { AbsoluteFill, Img, staticFile } from "remotion";

// Shared stage backdrop for every composition: the deep-blue studio
// gradient (remotion/public/scene-bg.png), covering the full frame.
export const SCENE_BG_FILE = "scene-bg.png";

export const SceneBackground: React.FC = () => (
  <AbsoluteFill>
    <Img
      src={staticFile(SCENE_BG_FILE)}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
      from={-52} />
  </AbsoluteFill>
);
