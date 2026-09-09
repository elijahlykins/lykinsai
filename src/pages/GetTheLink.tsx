import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import lyknLogoMark from "@/assets/FINAL/LYKN-LOGO-B-Open/SVG/LYKN-Logo-Primary-B-Open-BLACK.svg";
import LandingHeader from "@/components/landing/LandingHeader";
import { LyknWordmark } from "@/components/landing/LyknWordmark";
import SendDownloadLink from "@/components/landing/SendDownloadLink";
import { useLandingLightTheme } from "@/components/landing/useLandingLightTheme";
import "./GlassLanding.css";
import "@/components/landing/landingIcy.css";
import "./DownloadLykn.css";
import "./GetTheLink.css";

/** /get-started — the phone hand-off page behind the header's Get started
    button. The desktop app can't install on a phone, so this captures an
    email and mails the visitor their download link. */
export default function GetTheLink() {
  const navigate = useNavigate();

  useLandingLightTheme();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="glass-land dlp">
      <LandingHeader onBrandClick={() => navigate("/")} />

      <main className="dlp-stage">
        <section className="dlp-copy">
          <span
            className="dlp-brand"
            role="img"
            aria-label="LYKN"
            style={{ ["--dlp-mark" as string]: `url("${lyknLogoMark}")` }}
          />
          <h1 className="dlp-tag" aria-label="LYKN is not available for mobile yet">
            <LyknWordmark decorative /> is not available for mobile yet
          </h1>
          <p className="glk-sub">
            Send the link to download on the machine of your choice.
          </p>

          <div className="glk-capture">
            <SendDownloadLink fieldId="page-getlink-email" />
          </div>
        </section>
      </main>
    </div>
  );
}
