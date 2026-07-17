// Remotion CLI/Studio config. This is ONLY used by the Remotion toolchain
// (`npm run remotion:studio` / `npm run remotion:render`) and is completely
// separate from the app's Vite build and server.js.
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

// WebGL compositions (LyknSynthesisZoom uses @remotion/three) need the ANGLE
// OpenGL renderer in headless Chrome — the default swiftshader-less setup
// can't create a WebGL context during renders.
Config.setChromiumOpenGlRenderer("angle");

// Keep Remotion assets out of the app's shared public/ folder.
Config.setPublicDir("remotion/public");
