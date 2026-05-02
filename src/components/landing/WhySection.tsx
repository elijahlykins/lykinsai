import { useEffect, useRef, useState } from "react";

const fullText = `Creativity is life. Creativity is what sets us apart. Humans were made to create. It's not talent some have and others only dream of. It's what we are. Every civilization, every breakthrough, every beautiful thing that ever existed started as a thought in someone's mind. Creation is what moves us forward. It's how we've always moved forward. Some today make the claim that creativity is dying. We're building LYKN because that claim is a lie. We exist to bring people back to what's innate. To help them think deeper, reach further, and build something the world deserves to see. Because when you create at your full potential, you don't just change your life, you change all of us.`;

// Split into 3 chunks by sentence groups
const allSentences = fullText.match(/[^.!?]+[.!?]+/g) || [fullText];
const third = Math.ceil(allSentences.length / 3);
const chunks = [
  allSentences.slice(0, third).join(""),
  allSentences.slice(third, third * 2).join(""),
  allSentences.slice(third * 2).join(""),
];

const WhySection = () => {
  const [visibleChunks, setVisibleChunks] = useState(0);
  const [started, setStarted] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started) {
          setStarted(true);
        }
      },
      { threshold: 0.3 }
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started) return;
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setVisibleChunks(i);
      if (i >= chunks.length) {
        clearInterval(interval);
      }
    }, 400);
    return () => clearInterval(interval);
  }, [started]);

  const done = visibleChunks >= chunks.length;

  return (
    <section ref={sectionRef} className="relative z-10 py-32 px-8 md:px-16">
      <div className="max-w-3xl mx-auto">
        <p className="text-primary font-display text-sm md:text-base tracking-[0.4em] uppercase mb-8 font-semibold">
          Why LYKN
        </p>
        <p className="font-display text-xl md:text-2xl lg:text-3xl leading-relaxed text-foreground font-medium">
          {chunks.map((chunk, index) => (
            <span
              key={index}
              className="transition-all duration-700 ease-out inline"
              style={{
                opacity: index < visibleChunks ? 1 : 0,
                filter: index < visibleChunks ? 'blur(0px)' : 'blur(8px)',
              }}
            >
              {chunk}
            </span>
          ))}
        </p>
        {done && (
          <p className="text-muted-foreground font-display text-sm mt-10 tracking-widest animate-fade-in">
            —LYKN team
          </p>
        )}
      </div>
    </section>
  );
};

export default WhySection;
