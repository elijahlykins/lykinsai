import { useRef, useEffect, useState } from "react";
import collageSpacex from "@/assets/landing/collage-spacex.jpg";
import collagePorscheShowroom from "@/assets/landing/collage-porsche-showroom.jpg";
import collageBranding from "@/assets/landing/collage-branding.jpg";
import collageSmallBiz from "@/assets/landing/collage-small-biz.jpg";
import collageRedbullPlanes from "@/assets/landing/collage-redbull-planes.jpg";
import collageRedbullCan from "@/assets/landing/collage-redbull-can.jpg";
import collageRobotArm from "@/assets/landing/collage-robot-arm.jpg";
import collagePorscheGt3 from "@/assets/landing/collage-porsche-gt3.jpg";
import collageAppleVision from "@/assets/landing/collage-apple-vision.png";
import collageMessageUi from "@/assets/landing/collage-message-ui.png";
import collageTweet from "@/assets/landing/collage-tweet.png";
import collageSpreadsheet from "@/assets/landing/collage-spreadsheet.png";
import collageNike from "@/assets/landing/collage-nike.png";
import collageDarkTexture from "@/assets/landing/collage-dark-texture.jpg";
import collageAtomicHabits from "@/assets/landing/collage-atomic-habits.jpg";
import collageCocaCola from "@/assets/landing/collage-coca-cola.jpg";

const images = [
  { src: collageSpacex, alt: "SpaceX rocket", scatterX: -350, scatterY: -300, scatterRotate: -25 },
  { src: collageAppleVision, alt: "Master Your Vision", scatterX: 100, scatterY: -400, scatterRotate: 15 },
  { src: collageBranding, alt: "Branding and Marketing", scatterX: 300, scatterY: -250, scatterRotate: 20 },
  { src: collagePorscheShowroom, alt: "Porsche showroom", scatterX: 400, scatterY: -180, scatterRotate: -18 },
  { src: collageRedbullPlanes, alt: "Red Bull air race", scatterX: -300, scatterY: 350, scatterRotate: 22 },
  { src: collageMessageUi, alt: "Message UI", scatterX: -50, scatterY: 400, scatterRotate: -12 },
  { src: collageSmallBiz, alt: "Small Business Big Impact", scatterX: 250, scatterY: 350, scatterRotate: 16 },
  { src: collageRobotArm, alt: "Robot arm", scatterX: -400, scatterY: 200, scatterRotate: -20 },
  { src: collageRedbullCan, alt: "Red Bull can", scatterX: 50, scatterY: -350, scatterRotate: 25 },
  { src: collagePorscheGt3, alt: "Porsche GT3 RS", scatterX: 350, scatterY: 300, scatterRotate: -22 },
  { src: collageTweet, alt: "Elon Musk tweet", scatterX: -200, scatterY: -150, scatterRotate: 10 },
  { src: collageSpreadsheet, alt: "Productivity Sheet", scatterX: 150, scatterY: 250, scatterRotate: -15 },
  { src: collageNike, alt: "Nike Just Do It", scatterX: -380, scatterY: -100, scatterRotate: 18 },
  { src: collageDarkTexture, alt: "Dark texture", scatterX: 280, scatterY: -320, scatterRotate: -10 },
  { src: collageAtomicHabits, alt: "Atomic Habits book", scatterX: -150, scatterY: 380, scatterRotate: 14 },
  { src: collageCocaCola, alt: "Coca Cola can", scatterX: 320, scatterY: 180, scatterRotate: -8 },
];

const CollageOrganizeSection = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [scatterScale, setScatterScale] = useState(1);

  useEffect(() => {
    const updateScale = () => {
      setScatterScale(Math.min(1, window.innerWidth / 900));
    };
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (sectionRef.current) {
        const rect = sectionRef.current.getBoundingClientRect();
        const windowH = window.innerHeight;
        const rawProgress = 1 - (rect.top - windowH * 0.2) / (windowH * 1.2);
        setProgress(Math.max(0, Math.min(1, rawProgress)));
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <section className="relative z-10 py-16 px-4 md:px-8">
      <div className="max-w-4xl mx-auto text-center mb-12">
        <h2 className="font-display text-4xl md:text-6xl lg:text-7xl font-extralight tracking-tight mb-6 text-foreground">
          All of your ideas in the{" "}
          <span className="text-primary">LYKN</span> studio.
        </h2>
        <p className="text-muted-foreground text-lg md:text-xl font-light max-w-2xl mx-auto">
          Drag and drop images, videos, notes, screenshots, pdfs, links, into an active digital memory, a place for every idea to be seen.
        </p>
      </div>

      <div className="relative mx-2 md:mx-8 bg-white rounded-2xl md:rounded-3xl p-3 md:p-10 overflow-hidden">
        <div ref={sectionRef} style={{ minHeight: "70vh" }}>
          <div className="columns-2 sm:columns-3 md:columns-4 gap-3 md:gap-4">
            {images.map((img, i) => {
              const delay = (i / (images.length - 1)) * 0.5;
              const imgProgress = Math.max(0, Math.min(1, (progress - delay) / (1 - delay)));
              const eased = imgProgress * imgProgress * (3 - 2 * imgProgress);
              const translateX = img.scatterX * scatterScale * (1 - eased);
              const translateY = img.scatterY * scatterScale * (1 - eased);
              const rotate = img.scatterRotate * (1 - eased);
              const scale = 0.5 + 0.5 * eased;
              const opacity = eased;

              return (
                <div
                  key={i}
                  className="mb-3 md:mb-4 break-inside-avoid"
                  style={{
                    transform: `translate(${translateX}px, ${translateY}px) scale(${scale}) rotate(${rotate}deg)`,
                    opacity,
                    willChange: "transform, opacity",
                  }}
                >
                  <img src={img.src} alt={img.alt} className="w-full rounded-xl object-cover shadow-md" loading="eager" />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};

export default CollageOrganizeSection;
