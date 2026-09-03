import { Composition } from "remotion";
import { HelloLykn } from "./HelloLykn";
import { LyknLogoReveal } from "./LyknLogoReveal";
import { LyknIconSpin, lyknIconSpinDefaults } from "./LyknIconSpin";
import { LyknIconPulse, lyknIconPulseDefaults } from "./LyknIconPulse";
import { LyknIconOutline, lyknIconOutlineDefaults } from "./LyknIconOutline";
import { LyknVoiceOrb, lyknVoiceOrbDefaults } from "./LyknVoiceOrb";
import { LyknChatStatus } from "./LyknChatStatus";
import { LyknVoiceAgent } from "./LyknVoiceAgent";
import { LyknProjects } from "./LyknProjects";
import { LyknProjectsZoom, PROJECTS_ZOOM_DURATION } from "./LyknProjectsZoom";
import { LyknChatZoom } from "./LyknChatZoom";
import { LyknIconRoll } from "./LyknIconRoll";
import { LyknAiAnywhereRoll, AI_ANYWHERE_ROLL_DURATION } from "./LyknAiAnywhereRoll";
import { LyknGlassOverlay } from "./LyknGlassOverlay";
import { LyknGlassUi, GLASS_UI_DURATION } from "./LyknGlassUi";
import { LyknSnipArticle, SNIP_ARTICLE_DURATION } from "./LyknSnipArticle";
import { LyknCreateReport, CREATE_REPORT_DURATION } from "./LyknCreateReport";
import { LyknGenerateAd, GENERATE_AD_DURATION } from "./LyknGenerateAd";
import { LyknBuildDashboard, BUILD_DASHBOARD_DURATION } from "./LyknBuildDashboard";
import { LyknBuildPresentation, BUILD_PRESENTATION_DURATION } from "./LyknBuildPresentation";
import { LyknArticleMeaning, ARTICLE_MEANING_DURATION } from "./LyknArticleMeaning";
import { LyknGlassWords, GLASS_WORDS_DURATION } from "./LyknGlassWords";
import { LyknCanNow, CAN_NOW_DURATION } from "./LyknCanNow";
import { LyknCloudChat, CLOUD_CHAT_DURATION } from "./LyknCloudChat";
import { LyknInvisibleMode, INVISIBLE_MODE_DURATION } from "./LyknInvisibleMode";
import { LyknPlusMacos, PLUS_MACOS_DURATION } from "./LyknPlusMacos";
import { LyknSayHello, SAY_HELLO_DURATION } from "./LyknSayHello";
import { LyknWastingTime, WASTING_TIME_DURATION } from "./LyknWastingTime";
import {
  LyknStillWastingTime,
  STILL_WASTING_TIME_DURATION,
} from "./LyknStillWastingTime";
import { LyknStudioPrompts, STUDIO_PROMPTS_DURATION } from "./LyknStudioPrompts";
import { LyknImessage, IMESSAGE_DURATION } from "./LyknImessage";
import { LyknIconNodes, ICON_NODES_DURATION } from "./LyknIconNodes";
import { LyknClickButton, CLICK_BUTTON_DURATION } from "./LyknClickButton";
import { LyknCommandL } from "./LyknCommandL";
import { LyknKeysPress, KEYS_PRESS_DURATION } from "./LyknKeysPress";
import { LyknKineticWords, KINETIC_WORDS_DURATION } from "./LyknKineticWords";
import { LyknVaultZoom, VAULT_ZOOM_DURATION } from "./LyknVaultZoom";
import { LyknVoiceMode, VOICE_MODE_DURATION } from "./LyknVoiceMode";
import { LyknVoiceOverlay, VOICE_OVERLAY_DURATION } from "./LyknVoiceOverlay";
import { LyknAppSelector, APP_SELECTOR_DURATION } from "./LyknAppSelector";
import { LyknYourNewAI, YOUR_NEW_AI_DURATION } from "./LyknYourNewAI";
import { ActivationGradient, activationGradientDefaults } from "./ActivationGradient";
import { AuroraGlass, auroraGlassDefaults } from "./AuroraGlass";
import { ParticleBurst, particleBurstDefaults } from "./ParticleBurst";
import { AiAnywhere } from "./AiAnywhere";
import { GlassBarStill, glassBarStillDefaults } from "./GlassBarStill";
import { GlassPoster, glassPosterDefaults } from "./GlassPoster";
import { LyknDmgBackground } from "./LyknDmgBackground";
import { LyknStudioOpen, STUDIO_OPEN_DURATION, lyknStudioOpenDefaults } from "./LyknStudioOpen";
import { LyknStudioResearch, STUDIO_RESEARCH_DURATION } from "./LyknStudioResearch";
import { LyknStudioDemo, STUDIO_DEMO_DURATION } from "./LyknStudioDemo";
import { LyknStudioChat, STUDIO_CHAT_DURATION } from "./LyknStudioChat";
import { LyknStudioChatDemo, STUDIO_CHAT_DEMO_DURATION } from "./LyknStudioChatDemo";
import { LyknStudioBrowser, STUDIO_BROWSER_DURATION } from "./LyknStudioBrowser";
import { LyknStudioBrowserDemo, STUDIO_BROWSER_DEMO_DURATION } from "./LyknStudioBrowserDemo";
import {
  LyknHeroDesktop,
  HERO_DESKTOP_DURATION,
  HERO_DESKTOP_WIDTH,
  HERO_DESKTOP_HEIGHT,
  HERO_DESKTOP_RESEARCH_DURATION,
  HERO_DESKTOP_RESEARCH_PROPS,
  lyknHeroDesktopDefaults,
} from "./LyknHeroDesktop";
import {
  LyknHeroDesktopBuild,
  HERO_DESKTOP_BUILD_DURATION,
} from "./LyknHeroDesktopBuild";
import { LyknLaptopDockZoom, LAPTOP_DOCK_ZOOM_DURATION } from "./LyknLaptopDockZoom";

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
          background: "#2a2a2a",
        }}
      />
      <Composition
        id="LyknLogoRevealFast"
        component={LyknLogoReveal}
        durationInFrames={65}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          background: "#2a2a2a",
          scale: 0.8,
          speed: 2,
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
        id="LyknIconOutline"
        component={LyknIconOutline}
        durationInFrames={110}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={lyknIconOutlineDefaults}
      />
      <Composition
        id="LyknVoiceOrb"
        component={LyknVoiceOrb}
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={lyknVoiceOrbDefaults}
      />
      <Composition
        id="LyknChatStatus"
        component={LyknChatStatus}
        durationInFrames={480}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknVoiceAgent"
        component={LyknVoiceAgent}
        durationInFrames={360}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknProjects"
        component={LyknProjects}
        durationInFrames={540}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknGlassOverlay"
        component={LyknGlassOverlay}
        durationInFrames={240}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknGlassUi"
        component={LyknGlassUi}
        durationInFrames={GLASS_UI_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknSnipArticle"
        component={LyknSnipArticle}
        durationInFrames={SNIP_ARTICLE_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknCreateReport"
        component={LyknCreateReport}
        durationInFrames={CREATE_REPORT_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknGenerateAd"
        component={LyknGenerateAd}
        durationInFrames={GENERATE_AD_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknBuildDashboard"
        component={LyknBuildDashboard}
        durationInFrames={BUILD_DASHBOARD_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknBuildPresentation"
        component={LyknBuildPresentation}
        durationInFrames={BUILD_PRESENTATION_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknArticleMeaning"
        component={LyknArticleMeaning}
        durationInFrames={ARTICLE_MEANING_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknGlassWords"
        component={LyknGlassWords}
        durationInFrames={GLASS_WORDS_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknCanNow"
        component={LyknCanNow}
        durationInFrames={CAN_NOW_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknCloudChat"
        component={LyknCloudChat}
        durationInFrames={CLOUD_CHAT_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknInvisibleMode"
        component={LyknInvisibleMode}
        durationInFrames={INVISIBLE_MODE_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknIconRoll"
        component={LyknIconRoll}
        durationInFrames={80}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknAiAnywhereRoll"
        component={LyknAiAnywhereRoll}
        durationInFrames={AI_ANYWHERE_ROLL_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknChatZoom"
        component={LyknChatZoom}
        durationInFrames={560}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknProjectsZoom"
        component={LyknProjectsZoom}
        durationInFrames={PROJECTS_ZOOM_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknPlusMacos"
        component={LyknPlusMacos}
        durationInFrames={PLUS_MACOS_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknSayHello"
        component={LyknSayHello}
        durationInFrames={SAY_HELLO_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknWastingTime"
        component={LyknWastingTime}
        durationInFrames={WASTING_TIME_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknStillWastingTime"
        component={LyknStillWastingTime}
        durationInFrames={STILL_WASTING_TIME_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknStudioPrompts"
        component={LyknStudioPrompts}
        durationInFrames={STUDIO_PROMPTS_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknImessage"
        component={LyknImessage}
        durationInFrames={IMESSAGE_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknIconNodes"
        component={LyknIconNodes}
        durationInFrames={ICON_NODES_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknClickButton"
        component={LyknClickButton}
        durationInFrames={CLICK_BUTTON_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknCommandL"
        component={LyknCommandL}
        durationInFrames={560}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknKeysPress"
        component={LyknKeysPress}
        durationInFrames={KEYS_PRESS_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknKineticWords"
        component={LyknKineticWords}
        durationInFrames={KINETIC_WORDS_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknVaultZoom"
        component={LyknVaultZoom}
        durationInFrames={VAULT_ZOOM_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknVoiceMode"
        component={LyknVoiceMode}
        durationInFrames={VOICE_MODE_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknVoiceOverlay"
        component={LyknVoiceOverlay}
        durationInFrames={VOICE_OVERLAY_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknAppSelector"
        component={LyknAppSelector}
        durationInFrames={APP_SELECTOR_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknYourNewAI"
        component={LyknYourNewAI}
        durationInFrames={YOUR_NEW_AI_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="ActivationGradient"
        component={ActivationGradient}
        durationInFrames={180}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={activationGradientDefaults}
      />
      <Composition
        id="AuroraGlass"
        component={AuroraGlass}
        durationInFrames={240}
        fps={30}
        width={1080}
        height={1350}
        defaultProps={auroraGlassDefaults}
      />
      <Composition
        id="ParticleBurst"
        component={ParticleBurst}
        durationInFrames={210}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={particleBurstDefaults}
      />
      <Composition
        id="GlassBarStill"
        component={GlassBarStill}
        durationInFrames={1}
        fps={30}
        width={760}
        height={360}
        defaultProps={glassBarStillDefaults}
      />
      <Composition
        id="GlassPoster"
        component={GlassPoster}
        durationInFrames={1}
        fps={30}
        width={990}
        height={2048}
        defaultProps={glassPosterDefaults}
      />
      <Composition
        id="LyknDmgBackground"
        component={LyknDmgBackground}
        durationInFrames={1}
        fps={30}
        width={540}
        height={380}
      />
      <Composition
        id="LyknStudioOpen"
        component={LyknStudioOpen}
        durationInFrames={STUDIO_OPEN_DURATION}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={lyknStudioOpenDefaults}
      />
      <Composition
        id="LyknStudioResearch"
        component={LyknStudioResearch}
        durationInFrames={STUDIO_RESEARCH_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknStudioDemo"
        component={LyknStudioDemo}
        durationInFrames={STUDIO_DEMO_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknStudioChat"
        component={LyknStudioChat}
        durationInFrames={STUDIO_CHAT_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknStudioChatDemo"
        component={LyknStudioChatDemo}
        durationInFrames={STUDIO_CHAT_DEMO_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknStudioBrowser"
        component={LyknStudioBrowser}
        durationInFrames={STUDIO_BROWSER_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknStudioBrowserDemo"
        component={LyknStudioBrowserDemo}
        durationInFrames={STUDIO_BROWSER_DEMO_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LyknHeroDesktop"
        component={LyknHeroDesktop}
        durationInFrames={HERO_DESKTOP_DURATION}
        fps={30}
        width={HERO_DESKTOP_WIDTH}
        height={HERO_DESKTOP_HEIGHT}
        defaultProps={lyknHeroDesktopDefaults}
      />
      <Composition
        id="LyknHeroDesktopResearch"
        component={LyknHeroDesktop}
        durationInFrames={HERO_DESKTOP_RESEARCH_DURATION}
        fps={30}
        width={HERO_DESKTOP_WIDTH}
        height={HERO_DESKTOP_HEIGHT}
        defaultProps={HERO_DESKTOP_RESEARCH_PROPS}
      />
      <Composition
        id="LyknHeroDesktopBuild"
        component={LyknHeroDesktopBuild}
        durationInFrames={HERO_DESKTOP_BUILD_DURATION}
        fps={30}
        width={HERO_DESKTOP_WIDTH}
        height={HERO_DESKTOP_HEIGHT}
      />
      <Composition
        id="LyknLaptopDockZoom"
        component={LyknLaptopDockZoom}
        durationInFrames={LAPTOP_DOCK_ZOOM_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="AiAnywhere"
        component={AiAnywhere}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1920}
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
